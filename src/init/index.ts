// src/init/index.ts — Stage 9 (I9.1): InitRegistry — vault-driven boot sequencer.
// -------------------------------------------------------------------------
// Authoritative contract:
//   project/software/opencode/specification/contract/init-registry.md
//   project/software/opencode/specification/schema/init-card.md
//
// Replaces the hardcoded `Promise.all([Phase.load(), RuntimeRole.load(), ...])`
// block at `src/index.ts:192-223`. Discovers `<vault>/atomic/init/<order>-<service>.md`
// cards, validates frontmatter, builds depends_on DAG, runs Kahn topo-sort,
// invokes registered ServiceLoader.load() in topo order, applies health probes,
// enforces required/optional policy.
//
// Init registry scope:
//   - I9.1 (this file)  : registry, topo-sort, sequential exec, default probe
//   - I9.2 (vault)      : 6 init cards under <vault>/atomic/init/
//   - I9.3 (predicates) : `init-registry-loaded` predicate (registered HERE)
//   - I9.4 (deferred)   : restart manager (always|on-failure)
//   - I9.5 (deferred)   : <vault>/log/init/<day>.log writer
//
// Design notes:
//   - Mirrors `src/workflow/phase.ts` namespace + frozen-snapshot pattern.
//   - Empty-vault tolerance per L3 §I3 + InitRegistry §I1: missing
//     <vault>/atomic/init/ → run loaders in registration order, all required.
//   - `boot()` is idempotent-guarded: second call throws AlreadyBooted (§I9).
//   - Topo-sort uses Kahn (BFS), tie-broken by `order` ascending → deterministic.
//   - Stage-9 restart loop honours `never` only; `always|on-failure` is I9.4.
//   - Bus events `init.boot.complete` + `init.boot.degraded` per spec
//     §Discovery and load lifecycle / §Required vs optional failure handling.
// -------------------------------------------------------------------------

import path from "path"
import { existsSync } from "fs"
import fs from "fs/promises"
import z from "zod"
import { NamedError } from "@opencode-ai/util/error"
import { ConfigMarkdown } from "@/config/markdown"
import { Log } from "@/foundation/util/log"
import { vaultPath } from "@/notes/root"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Predicate } from "@/workflow/predicates"

export namespace InitRegistry {
  const log = Log.create({ service: "init-registry" })

  // ── Types ────────────────────────────────────────────────────────────

  /** Init-card frontmatter — see specification/schema/init-card.md §Frontmatter. */
  export const InitCardSchema = z.object({
    order: z.number().int().min(1).max(9999),
    service: z.string().regex(/^[a-z][a-z0-9-]*$/),
    required: z.boolean(),
    depends_on: z.array(z.string()).default([]),
    health_probe: z.string().nullable().default(null),
    restart_policy: z.enum(["always", "on-failure", "never"]).default("never"),
    max_retries: z.number().int().min(0).default(3),
    backoff_ms: z.number().int().min(0).default(500),
    description: z.string().nullable().default(null),
  })
  export type InitCard = z.infer<typeof InitCardSchema>

  /** ServiceLoader — caller registers one per service. Idempotent (provider obligation P1). */
  export interface ServiceLoader {
    name: string
    load(): Promise<void>
  }

  /** BootResult — returned by `boot()`. Used by `src/index.ts` for error surfacing. */
  export interface BootResult {
    started: string[]
    degraded: string[]
    failed: string[]
    errors: Record<string, Error>
    durationMs: number
  }

  /** LoadError — non-fatal per-card failure accumulated during discovery. */
  export interface LoadError {
    path: string
    name: string
    reason: "frontmatter.parse" | "schema.invalid" | "filename.mismatch" | "duplicate" | "io.read"
    detail: string
  }

  // ── Bus events ───────────────────────────────────────────────────────

  /** init.boot.complete — emitted at end of `boot()` regardless of outcome. */
  export const Complete = BusEvent.define(
    "init.boot.complete",
    z.object({
      started: z.array(z.string()),
      degraded: z.array(z.string()),
      failed: z.array(z.string()),
      durationMs: z.number(),
    }),
  )

  /** init.boot.degraded — emitted only when result.degraded is non-empty. */
  export const Degraded = BusEvent.define(
    "init.boot.degraded",
    z.object({
      degraded: z.array(z.string()),
    }),
  )

  // ── Errors ───────────────────────────────────────────────────────────

  export const RequiredServiceFailed = NamedError.create(
    "InitRegistryRequiredServiceFailed",
    z.object({
      service: z.string(),
      retriesAttempted: z.number().int(),
      diagnostic: z.string(),
    }),
  )

  export const CycleDetected = NamedError.create(
    "InitRegistryCycleDetected",
    z.object({
      cycle: z.array(z.string()),
    }),
  )

  export const AlreadyBooted = NamedError.create("InitRegistryAlreadyBooted", z.object({}))

  // ── Internal state ───────────────────────────────────────────────────

  let booted = false
  let cardErrors: LoadError[] = []

  function vaultDir(): string {
    return vaultPath.atomic("init")
  }

  // ── Boot trace log (I9.5) ────────────────────────────────────────────
  //
  // Per spec §Boot trace logging: every service transition is appended
  // (best-effort) to `<vault>/log/init/<YYYY-MM-DD>.log` in addition to
  // the structured Log.Default JSON stream.
  //
  // Format: `[BOOT] <ISO-timestamp> <VERB>   <service> <details>`
  // Verbs: START, OK, RETRY, SKIP, DEGRADE, FAIL, DONE.
  //
  // I/O failures are swallowed (never block boot). The directory is
  // created lazily on first append — vault may be brand-new.

  type TraceVerb = "START" | "OK" | "RETRY" | "SKIP" | "DEGRADE" | "FAIL" | "DONE"

  /** Test seam — replaceable trace-line collector for I9.5 cells. */
  let traceSink: ((line: string) => void | Promise<void>) | null = null

  /** @internal — test-only trace-sink override. Restored by `_resetForTest()`. */
  export function _setTraceSinkForTest(fn: ((line: string) => void | Promise<void>) | null): void {
    traceSink = fn
  }

  function isoDay(now: Date = new Date()): string {
    return now.toISOString().slice(0, 10) // YYYY-MM-DD
  }

  function bootTracePath(now: Date = new Date()): string {
    return vaultPath.log("init", isoDay(now))
  }

  /**
   * Append one boot-trace line. Best-effort — failures are logged at
   * WARN level but never propagate. Test-mode sink (if set) bypasses
   * filesystem entirely.
   */
  async function appendTrace(verb: TraceVerb, service: string, details: string): Promise<void> {
    const ts = new Date().toISOString()
    const line = `[BOOT] ${ts} ${verb.padEnd(7)} ${service} ${details}`.trimEnd() + "\n"
    if (traceSink) {
      try {
        await traceSink(line)
      } catch (err) {
        log.warn("init.trace.sink.failed", {
          err: err instanceof Error ? err.message : String(err),
        })
      }
      return
    }
    try {
      const dir = vaultPath.logDir("init")
      await fs.mkdir(dir, { recursive: true })
      await fs.appendFile(bootTracePath(), line, "utf-8")
    } catch (err) {
      log.warn("init.trace.write.failed", {
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // ── Card discovery + validation ──────────────────────────────────────

  /** Scan <vault>/atomic/init/, parse + validate every card. Never throws. */
  export async function loadCards(): Promise<{ cards: InitCard[]; errors: LoadError[] }> {
    const cards: InitCard[] = []
    const errors: LoadError[] = []
    const dir = vaultDir()

    if (!existsSync(dir)) {
      // I3 empty-vault path — caller falls back to registration-order boot.
      return { cards, errors }
    }

    let dirents: string[]
    try {
      dirents = await fs.readdir(dir)
    } catch (err) {
      errors.push({
        path: dir,
        name: "<dir>",
        reason: "io.read",
        detail: err instanceof Error ? err.message : String(err),
      })
      return { cards, errors }
    }

    const mdFiles = dirents.filter((n) => n.endsWith(".md"))
    const seenService = new Set<string>()

    for (const filename of mdFiles) {
      // Filename pattern: `<order>-<service>.md`. Files not matching → skip+warn.
      const match = filename.match(/^(\d+)-([a-z][a-z0-9-]*)\.md$/)
      const filePath = path.join(dir, filename)
      if (!match) {
        log.warn("init.card.filename.skipped", {
          file: filename,
          reason: "filename pattern <order>-<service>.md not matched",
        })
        continue
      }
      const stemService = match[2]

      // Step 2: Parse frontmatter.
      let parsed: { data: unknown; content: string }
      try {
        parsed = await ConfigMarkdown.parse(filePath)
      } catch (err) {
        errors.push({
          path: filePath,
          name: stemService,
          reason: "frontmatter.parse",
          detail: err instanceof Error ? err.message : String(err),
        })
        continue
      }

      // Step 3: Validate via zod.
      const result = InitCardSchema.safeParse(parsed.data)
      if (!result.success) {
        errors.push({
          path: filePath,
          name: stemService,
          reason: "schema.invalid",
          detail: result.error.issues.map((i) => `${i.path.join("@/init") || "<root>"}: ${i.message}`).join("; "),
        })
        continue
      }

      const card = result.data

      // Validation rule: `service` field MUST equal filename stem after order prefix.
      if (card.service !== stemService) {
        errors.push({
          path: filePath,
          name: stemService,
          reason: "filename.mismatch",
          detail: `service field "${card.service}" must equal filename stem "${stemService}"`,
        })
        continue
      }

      // Validation rule: duplicate `service` names → second card skipped.
      if (seenService.has(card.service)) {
        errors.push({
          path: filePath,
          name: card.service,
          reason: "duplicate",
          detail: `service "${card.service}" already declared by another card; this card excluded`,
        })
        continue
      }
      seenService.add(card.service)
      cards.push(Object.freeze(card) as InitCard)
    }

    return { cards, errors }
  }

  // ── Topo-sort (Kahn) ─────────────────────────────────────────────────

  /**
   * Topo-sort cards by depends_on DAG. Tie-break by `order` ascending then
   * `service` alphabetical for full determinism (§I2).
   *
   * Throws CycleDetected if the graph has a cycle (§I3).
   * Unknown service in `depends_on` → warning only; edge ignored (validation
   * rule "depends_on contains unknown service" → warning).
   */
  export function topoSort(cards: InitCard[]): InitCard[] {
    const byService = new Map<string, InitCard>()
    for (const c of cards) byService.set(c.service, c)

    // Build adjacency + in-degree, ignoring unknown-service edges.
    const adj = new Map<string, string[]>() // service → dependents
    const inDeg = new Map<string, number>()
    for (const c of cards) {
      adj.set(c.service, [])
      inDeg.set(c.service, 0)
    }
    for (const c of cards) {
      for (const dep of c.depends_on) {
        if (!byService.has(dep)) {
          log.warn("init.card.depends_on.unknown", { service: c.service, missing: dep })
          continue
        }
        adj.get(dep)!.push(c.service)
        inDeg.set(c.service, (inDeg.get(c.service) ?? 0) + 1)
      }
    }

    // Sort comparator for determinism.
    const cmp = (aSvc: string, bSvc: string): number => {
      const a = byService.get(aSvc)!
      const b = byService.get(bSvc)!
      return a.order - b.order || a.service.localeCompare(b.service)
    }

    // Initial queue: all in-degree-0 nodes, sorted.
    const queue: string[] = []
    for (const [svc, deg] of inDeg) if (deg === 0) queue.push(svc)
    queue.sort(cmp)

    const result: InitCard[] = []
    while (queue.length > 0) {
      const next = queue.shift()!
      result.push(byService.get(next)!)
      const newlyZero: string[] = []
      for (const dep of adj.get(next)!) {
        const d = (inDeg.get(dep) ?? 0) - 1
        inDeg.set(dep, d)
        if (d === 0) newlyZero.push(dep)
      }
      // Re-sort the queue plus newly-zero in stable order.
      newlyZero.sort(cmp)
      queue.push(...newlyZero)
      queue.sort(cmp)
    }

    if (result.length < cards.length) {
      // Surviving non-zero in-degree nodes form the cycle set.
      const cycle = [...inDeg.entries()].filter(([, d]) => d > 0).map(([svc]) => svc)
      throw new CycleDetected({ cycle })
    }
    return result
  }

  // ── Health-probe integration ─────────────────────────────────────────

  // Single built-in probe `init-registry-loaded`. The probe
  // accepts a Predicate.Input but its only meaningful signal is whether the
  // service's load() resolved without throwing — that signal is held by the
  // caller (boot() loop), so this predicate is a placeholder that always
  // returns blocked:false. The L3 invariant (errors().length === 0) is
  // enforced at the loader level by each registry's own `errors()` method.
  //
  // Future Stage 9.5: per-service probes (`phase-loaded`, `policy-loaded`,
  // …) that introspect Registry.errors() directly.
  const INIT_PROBE_NAME = "init-registry-loaded"
  function ensureProbeRegistered(): void {
    if (Predicate.get(INIT_PROBE_NAME)) return
    Predicate.register(INIT_PROBE_NAME, () => ({ blocked: false }))
  }

  async function runHealthProbe(card: InitCard): Promise<{ healthy: true } | { healthy: false; reason: string }> {
    if (card.health_probe == null) return { healthy: true }
    const fn = Predicate.get(card.health_probe)
    if (!fn) {
      log.warn("init.health-probe.unknown", {
        service: card.service,
        probe: card.health_probe,
      })
      return { healthy: true } // unknown probe is fail-open per §I6
    }
    const result = fn({ noteContent: "" })
    if (result.blocked) return { healthy: false, reason: result.detail }
    return { healthy: true }
  }

  // ── Restart loop (I9.4) ──────────────────────────────────────────────

  /**
   * Backoff formula per spec §Restart-on-crash policy:
   *   wait(attempt) = min(backoff_ms * 2^attempt, 30_000)
   *
   * `attempt` is 0-indexed: attempt 0 = first retry (after initial failure).
   * Cap at 30 000 ms so misconfigured cards can't stall boot indefinitely.
   */
  function backoffMs(card: InitCard, attempt: number): number {
    const raw = card.backoff_ms * Math.pow(2, attempt)
    return Math.min(raw, 30_000)
  }

  /** Test seam — replaceable sleep so T.4 can fast-forward backoff windows. */
  let sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))

  /** @internal — test-only sleep override. Restored by `_resetForTest()`. */
  export function _setSleepForTest(fn: ((ms: number) => Promise<void>) | null): void {
    sleep = fn ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  /**
   * Run loader.load() + health probe with retry loop per `restart_policy`.
   *
   * Returns the final outcome after all retries exhausted:
   *   - `{ ok: true }`  → service loaded + probe passed
   *   - `{ ok: false, error, reason, attempts }` → all attempts failed
   *
   * Per spec §Restart-on-crash policy:
   *   - `never`      → no retry; first failure is final
   *   - `on-failure` → retry up to max_retries on load-throw OR probe-fail
   *   - `always`     → same as on-failure for load-time (Stage 9 scope);
   *                    post-boot crash monitoring is Stage 10+
   *
   * Each retry emits `init.service.retry` WARN log per spec §Retry log.
   */
  async function runWithRetries(
    card: InitCard,
    loader: ServiceLoader,
  ): Promise<{ ok: true } | { ok: false; error: Error; reason: string; attempts: number }> {
    const maxAttempts = card.restart_policy === "never" ? 1 : 1 + Math.max(0, card.max_retries)

    let lastError: Error = new Error("no attempts made")
    let lastReason = "unknown"

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Backoff BEFORE retry attempts (not the first call).
      if (attempt > 0) {
        const wait = backoffMs(card, attempt - 1)
        log.warn("init.service.retry", {
          service: card.service,
          attempt,
          max_retries: card.max_retries,
          backoff_ms: wait,
          error: lastError.message,
        })
        await appendTrace("RETRY", card.service, `attempt=${attempt}/${card.max_retries} error=${lastError.message}`)
        await sleep(wait)
      }

      // Attempt: load + probe.
      try {
        await loader.load()
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        lastReason = lastError.message
        continue
      }

      const probe = await runHealthProbe(card)
      if (!probe.healthy) {
        lastError = new Error(`health probe failed: ${probe.reason}`)
        lastReason = probe.reason
        continue
      }

      // Success.
      return { ok: true }
    }

    return { ok: false, error: lastError, reason: lastReason, attempts: maxAttempts }
  }

  // ── Service execution model ─────────────────────────────────────────

  async function runOneService(
    card: InitCard,
    loader: ServiceLoader,
    skippedDeps: Set<string>,
  ): Promise<{ kind: "started" } | { kind: "degraded" | "failed" | "skipped"; error?: Error; reason: string }> {
    // Skip if any required dependency is in failed[].
    for (const dep of card.depends_on) {
      if (skippedDeps.has(dep)) {
        const reason = `dep-failed:${dep}`
        log.info("init.service.skipped", { service: card.service, reason })
        await appendTrace("SKIP", card.service, `reason=${reason}`)
        return { kind: "skipped", reason }
      }
    }

    const t0 = Date.now()
    log.info("init.service.start", { service: card.service, order: card.order, required: card.required })
    await appendTrace("START", card.service, `order=${card.order} required=${card.required}`)

    // Retry loop honours restart_policy + max_retries + backoff_ms.
    const outcome = await runWithRetries(card, loader)
    if (!outcome.ok) {
      log.error("init.service.load.failed", {
        service: card.service,
        error: outcome.error.message,
        attempts: outcome.attempts,
      })
      const verb: TraceVerb = card.required ? "FAIL" : "DEGRADE"
      const tail = card.required ? " [BOOT HALTED]" : ""
      await appendTrace(verb, card.service, `error=${outcome.error.message}${tail}`)
      return { kind: card.required ? "failed" : "degraded", error: outcome.error, reason: outcome.reason }
    }

    const elapsedMs = Date.now() - t0
    log.info("init.service.ok", {
      service: card.service,
      probe: card.health_probe ?? "none",
      elapsedMs,
    })
    await appendTrace("OK", card.service, `probe=${card.health_probe ?? "none"} elapsed=${elapsedMs}ms`)
    return { kind: "started" }
  }

  // ── Public boot() ────────────────────────────────────────────────────

  /**
   * Discover init cards, topo-sort, run each registered ServiceLoader in
   * order. Returns BootResult.
   *
   * Throws RequiredServiceFailed if a required service fails after retries.
   * Throws AlreadyBooted on second invocation.
   * Optional service failures captured in result.degraded; engine continues.
   *
   * I3 empty-vault fallback: if no init cards exist, run loaders in their
   * registration order with `required: true` and no probes — preserves the
   * original `Promise.all([...])` semantics (now sequential for determinism).
   */
  export async function boot(loaders: ServiceLoader[]): Promise<BootResult> {
    if (booted) throw new AlreadyBooted({})
    booted = true
    ensureProbeRegistered()

    const t0 = Date.now()
    const { cards, errors } = await loadCards()
    cardErrors = errors

    // Build name→loader index.
    const loaderByName = new Map<string, ServiceLoader>()
    for (const l of loaders) loaderByName.set(l.name, l)

    const result: BootResult = {
      started: [],
      degraded: [],
      failed: [],
      errors: {},
      durationMs: 0,
    }

    // I3: empty-vault fallback — sequential by registration order, all required.
    if (cards.length === 0) {
      log.warn("init.cards.empty", {
        vault_dir: vaultDir(),
        fallback: "registration-order, all required",
        loaders: loaders.map((l) => l.name),
      })
      for (const loader of loaders) {
        const synthetic: InitCard = Object.freeze({
          order: 0,
          service: loader.name,
          required: true,
          depends_on: [],
          health_probe: null,
          restart_policy: "never" as const,
          max_retries: 0,
          backoff_ms: 0,
          description: "synthetic empty-vault card",
        })
        const outcome = await runOneService(synthetic, loader, new Set())
        if (outcome.kind === "started") {
          result.started.push(loader.name)
        } else if (outcome.kind === "failed") {
          result.failed.push(loader.name)
          if (outcome.error) result.errors[loader.name] = outcome.error
          // Required failure → halt.
          result.durationMs = Date.now() - t0
          await publishComplete(result)
          throw new RequiredServiceFailed({
            service: loader.name,
            retriesAttempted: 0,
            diagnostic: `Service "${loader.name}" failed during empty-vault boot: ${outcome.reason}`,
          })
        } else if (outcome.kind === "degraded") {
          result.degraded.push(loader.name)
          if (outcome.error) result.errors[loader.name] = outcome.error
        }
      }
      result.durationMs = Date.now() - t0
      await publishComplete(result)
      return result
    }

    // Manifest-driven path.
    let ordered: InitCard[]
    try {
      ordered = topoSort(cards)
    } catch (err) {
      // Cycle detection — surface immediately, no services started.
      result.durationMs = Date.now() - t0
      result.failed = cards.map((c) => c.service)
      throw err
    }

    const skippedDeps = new Set<string>() // services whose dependents must skip

    for (const card of ordered) {
      const loader = loaderByName.get(card.service)
      if (!loader) {
        log.warn("init.card.no-loader", {
          service: card.service,
          message: "card present but no ServiceLoader registered; skipping",
        })
        // Treat as degraded if optional, failed if required.
        if (card.required) {
          result.failed.push(card.service)
          result.durationMs = Date.now() - t0
          await publishComplete(result)
          throw new RequiredServiceFailed({
            service: card.service,
            retriesAttempted: 0,
            diagnostic: `Required service "${card.service}" has no registered ServiceLoader`,
          })
        }
        result.degraded.push(card.service)
        skippedDeps.add(card.service)
        continue
      }

      const outcome = await runOneService(card, loader, skippedDeps)
      if (outcome.kind === "started") {
        result.started.push(card.service)
      } else if (outcome.kind === "failed") {
        result.failed.push(card.service)
        if (outcome.error) result.errors[card.service] = outcome.error
        result.durationMs = Date.now() - t0
        await publishComplete(result)
        throw new RequiredServiceFailed({
          service: card.service,
          retriesAttempted: 0,
          diagnostic: `Required service "${card.service}" failed: ${outcome.reason}`,
        })
      } else if (outcome.kind === "degraded") {
        result.degraded.push(card.service)
        if (outcome.error) result.errors[card.service] = outcome.error
        skippedDeps.add(card.service)
      } else if (outcome.kind === "skipped") {
        result.degraded.push(card.service)
        skippedDeps.add(card.service)
      }
    }

    // Run any extra loaders that had no card (registration-order suffix).
    const cardServices = new Set(ordered.map((c) => c.service))
    for (const loader of loaders) {
      if (cardServices.has(loader.name)) continue
      log.info("init.loader.no-card", {
        service: loader.name,
        message: "loader registered with no init card; running at end with required=true",
      })
      const synthetic: InitCard = Object.freeze({
        order: 9999,
        service: loader.name,
        required: true,
        depends_on: [],
        health_probe: null,
        restart_policy: "never" as const,
        max_retries: 0,
        backoff_ms: 0,
        description: "synthetic suffix card",
      })
      const outcome = await runOneService(synthetic, loader, skippedDeps)
      if (outcome.kind === "started") result.started.push(loader.name)
      else if (outcome.kind === "failed") {
        result.failed.push(loader.name)
        if (outcome.error) result.errors[loader.name] = outcome.error
        result.durationMs = Date.now() - t0
        await publishComplete(result)
        throw new RequiredServiceFailed({
          service: loader.name,
          retriesAttempted: 0,
          diagnostic: `Suffix loader "${loader.name}" failed: ${outcome.reason}`,
        })
      } else if (outcome.kind === "degraded") result.degraded.push(loader.name)
    }

    result.durationMs = Date.now() - t0
    await publishComplete(result)
    return result
  }

  async function publishComplete(result: BootResult): Promise<void> {
    // Always emit DONE trace alongside bus event, regardless of bus state.
    await appendTrace(
      "DONE",
      "<all>",
      `started=${result.started.length} degraded=${result.degraded.length} failed=${result.failed.length} elapsed=${result.durationMs}ms`,
    )
    try {
      await Bus.publish(Complete, {
        started: result.started,
        degraded: result.degraded,
        failed: result.failed,
        durationMs: result.durationMs,
      })
      if (result.degraded.length > 0) {
        await Bus.publish(Degraded, { degraded: result.degraded })
      }
    } catch (err) {
      // Fire-and-forget; bus failures must not break boot.
      log.warn("init.bus.publish.failed", {
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /** Read accumulated card-discovery errors. Diagnostic surface per spec §Discovery. */
  export function errors(): ReadonlyArray<LoadError> {
    return Object.freeze([...cardErrors])
  }

  /** @internal — test-only reset. Tests MUST call this in `afterEach`. */
  export function _resetForTest(): void {
    booted = false
    cardErrors = []
    sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    traceSink = null
  }
}

export {
  InitPortSchema,
  BootSurfaceSchema,
  BootOptsSchema,
  InstallTypeSchema,
  InstallSpecSchema,
  AuthTokenSchema,
  InitErrorSchema,
  Init,
  type InitPortSchema as InitPortSchemaType,
  type BootOpts,
  type InstallSpec,
  type AuthToken,
  type InitError,
  type InitPort,
} from "@/init/port"

export { InitAdapterLayer } from "@/init/adapter"
export { InitLayer } from "@/init/layer"
