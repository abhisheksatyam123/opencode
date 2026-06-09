// src/workflow/phase.ts — Phase L3 registry (Stage 1, leaf I1.4).
// -------------------------------------------------------------------------
// Authoritative contract: project/software/opencode/specification/contract/
//   l3-registry.md           — `Source<T>` + `Registry<T>` 6-method API,
//                              7-step lifecycle, 10 invariants.
//   schema/phase-card.md     — frontmatter schema (5 required + 5 optional
//                              fields, 8 validation rules, migration table).
//
// This is the FIRST L3 registry implementation in the codebase. It sets the
// template for I1.6 (runtime-roles + dispatch-reasons), Stage 2 policy
// registry, later registries.
//
// Design choices ("why this shape"):
//
// 1. **Namespace style, plain async** — mirrors `RuntimeRoles` + `DispatchRoles`
//    instead of the Effect-heavy `Skill` registry. The L3 contract spec
//    declares a plain `Promise<>` surface; consumers (note-seed, reconcile)
//    call this from non-Effect code paths.
//
// 2. **Built-in fallback map (`DEFAULT_PHASE_BINDINGS`) lives HERE, not in
//    consumers** — per L3 §empty-vault: "DEFAULT_<KIND>_BINDINGS in the
//    registry module itself, NOT in consumer modules — consumers see only
//    the registry surface." This transitional shape remains until
//    the literal map can be deleted after all consumers route through
//    `Phase.get()`.
//
// 3. **Frozen snapshot** — invariant I2 (immutable snapshot). `Object.freeze`
//    on every record + the snapshot Map; `all()` returns a frozen array.
//
// 4. **Empty-vault tolerance is hard invariant I3** — when the vault subtree
//    is missing or empty, `all() === []` (frozen) and `get()` returns the
//    DEFAULT_PHASE_BINDINGS-derived synthetic Info. WARN log fires once at
//    first `load()` per process. Engine boot MUST succeed.
//
// 5. **No throws on bad cards** — invariant I6. Schema/ref failures append
//    a structured `LoadError` and exclude that card from the snapshot. The
//    consumer can read `errors()` for diagnostics.
//
// 6. **Watch deferred to Stage 7 (I7.1)** — current scope is one-shot load +
//    explicit `reload()`. The L3 contract permits this; `onChange` returns
//    a no-op disposable until Stage 7 lands fs.watch wiring.
// -------------------------------------------------------------------------

import path from "path"
import { existsSync } from "fs"
import fs from "fs/promises"
import z from "zod"
import { NamedError } from "@opencode-ai/util/error"
import { ConfigMarkdown } from "@/config/markdown"
import { Log } from "@/foundation/util/log"
import { vaultPath } from "@/notes/root"
import { Bus, WatchManager } from "@/bus"
import { RegistryEvent } from "@/bus/registry-events"
import { DispatchRoles } from "@/permission/policy/dispatch-roles"

export namespace Phase {
  const log = Log.create({ service: "phase-registry" })

  // ── Types ────────────────────────────────────────────────────────────

  /**
   * Closed enum of leaf types per phase-card schema §field-schema.
   * Subset of `impl · test · fix · search · refactor · chore · learn ·
   * design · plan · spec · contract · verify · build`.
   */
  export const LeafType = z.enum([
    "impl",
    "test",
    "fix",
    "search",
    "refactor",
    "chore",
    "learn",
    "design",
    "plan",
    "spec",
    "contract",
    "verify",
    "build",
  ])
  export type LeafType = z.infer<typeof LeafType>

  /**
   * Phase-card frontmatter schema. Required + optional per phase-card.md
   * §field-schema. Validation rules 1-8 fire on `load()`; failures produce
   * `LoadError` entries and exclude the card from the snapshot.
   */
  export const Info = z.object({
    /** Canonical phase name (kebab-case). MUST equal filename stem. */
    phase: z.string().regex(/^[a-z][a-z0-9-]*$/),

    /** Position in standard phase chain. 1-99. Lower = earlier. */
    order: z.number().int().min(1).max(99),

    /** Tier-1 specialist who owns this phase. */
    default_owner: z.string().min(1),

    /** Task-note `## <Phase>` sub-sections this phase writes to. */
    section_ownership: z.array(z.string().min(1)).min(1),

    /** Subset of LeafType — non-empty by phase semantics (every phase emits something). */
    allowed_leaf_types: z.array(LeafType).min(1),

    // ── optional ──
    loop_back_targets: z.record(z.string(), z.string()).optional(),
    min_engine: z.string().optional(),
    description: z.string().optional(),
    aliases: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),

    /** Provenance — populated by registry, never present in source frontmatter. */
    _source: z.string().optional(),
  })
  export type Info = z.infer<typeof Info>

  /**
   * Structured load failure per L3 §validation-policy. Bad cards are
   * excluded from the snapshot and surfaced through `errors()` — the
   * registry NEVER throws.
   */
  export interface LoadError {
    /** Source.id — currently "vault" only; will fan out in Stage 6 federation. */
    source: string
    /** Absolute file path that produced the error. */
    path?: string
    /** Card name (filename stem) when known. */
    name?: string
    /** Structured reason key — see L3 §validation-policy. */
    reason: "schema.invalid" | "ref.unresolved" | "duplicate" | "engine.too-old" | "io.read" | "frontmatter.parse"
    /** Human-readable detail. */
    detail: string
  }

  // ── Built-in fallback ────────────────────────────────────────────────

  /**
   * DEFAULT_PHASE_BINDINGS — per L3 §empty-vault, every L3 registry MUST
   * carry the in-code fallback map for empty-vault degraded boot. Mirrors
   * `src/agent/dispatch-roles.ts:67 PHASE_DEFAULTS` exactly so behavior is
   * unchanged when the vault has not yet been populated. Stage 1 ships
   * with both code AND seed cards present; Stage 3 deletes the literal
   * map in `dispatch-roles.ts` once `Phase.get()` is the canonical
   * resolver per `note-seed.ts` and `workflow.ts`.
   *
   * Keys are the original `PHASE_DEFAULTS` keys (with spaces) so the
   * fallback path can answer for legacy callers; the registry's vault
   * source uses kebab `phase` field + `aliases` to map both styles.
   */
  export const DEFAULT_PHASE_BINDINGS: Record<string, string> = Object.freeze({
    Plan: "planner",
    Design: "planner",
    "Root cause": "searcher",
    Contract: "planner",
    Spec: "planner",
    Implement: "implementer",
    "Rethink & Redesign": "planner",
    "Test Strategy": "implementer",
    Verification: "implementer",
    Research: "searcher",
    Notes: "planner",
  }) as Record<string, string>

  // ── Internal state ───────────────────────────────────────────────────

  type Snapshot = {
    /** name → Info (frozen). Lookup canonical key + every alias points here. */
    byName: ReadonlyMap<string, Info>
    /** Stable-ordered (by order asc, then phase asc) frozen array for `all()`. */
    list: ReadonlyArray<Info>
    /** Errors from the most recent reload — NEVER thrown. */
    errors: ReadonlyArray<LoadError>
  }

  let snapshot: Snapshot = {
    byName: new Map(),
    list: Object.freeze([]),
    errors: Object.freeze([]),
  }
  let loaded = false
  let warnedEmpty = false
  const subscribers = new Set<() => void>()

  // ── Helpers ──────────────────────────────────────────────────────────

  function vaultDir(): string {
    return vaultPath.atomic("workflow", "phase")
  }

  /**
   * Validate post-merge record per phase-card §validation-rules 1-8.
   * Returns null on success; a `LoadError.reason` + detail tuple on failure.
   * Rules 3 (default_owner ∈ agent registry) + 6 (loop_back_targets agent
   * resolution) are deferred to Stage 1.5 once the agent registry is
   * file-loaded; here we only enforce the structural checks (1, 2, 4, 5,
   * 7, 8). Cross-reference checks land alongside agent registry migration.
   */
  function validateRecord(rec: Info, filenameStem: string): { reason: LoadError["reason"]; detail: string } | null {
    // Rule 1: phase MUST equal filename stem.
    if (rec.phase !== filenameStem) {
      return {
        reason: "schema.invalid",
        detail: `phase field "${rec.phase}" must equal filename stem "${filenameStem}"`,
      }
    }
    // Rules 2, 4, 5 are enforced by the zod schema (range, min(1), enum).
    // Rule 7 (min_engine semver vs engine version): we don't have a
    //   running engine version constant yet; treat any min_engine as
    //   parseable-and-accepted. When engine version constant lands, gate
    //   here.
    // Rule 8 (duplicate `phase`) handled at the index step, not per-record.
    return null
  }

  /** Single source: vault file-tree at `<vault>/atomic/workflow/phase/`. */
  async function loadFromVault(): Promise<{
    records: Map<string, Info>
    errors: LoadError[]
  }> {
    const records = new Map<string, Info>()
    const errors: LoadError[] = []
    const dir = vaultDir()

    if (!existsSync(dir)) {
      // Empty-vault path. Not an error — engine will degrade gracefully.
      return { records, errors }
    }

    let dirents: string[]
    try {
      dirents = await fs.readdir(dir)
    } catch (err) {
      errors.push({
        source: "vault",
        path: dir,
        reason: "io.read",
        detail: `failed to read directory: ${err instanceof Error ? err.message : String(err)}`,
      })
      return { records, errors }
    }

    const mdFiles = dirents.filter((n) => n.endsWith(".md"))

    // Sequential parsing — phase set is small (≤ 20). Concurrency adds
    // little benefit and complicates duplicate-detection ordering.
    const seenPhase = new Set<string>()
    for (const filename of mdFiles) {
      const filenameStem = filename.replace(/\.md$/, "")
      const filePath = path.join(dir, filename)

      // Step 2: Parse.
      let parsed: { data: unknown; content: string }
      try {
        parsed = await ConfigMarkdown.parse(filePath)
      } catch (err) {
        errors.push({
          source: "vault",
          path: filePath,
          name: filenameStem,
          reason: "frontmatter.parse",
          detail: err instanceof Error ? err.message : String(err),
        })
        continue
      }

      // Step 3: Validate (zod).
      const result = Info.safeParse(parsed.data)
      if (!result.success) {
        errors.push({
          source: "vault",
          path: filePath,
          name: filenameStem,
          reason: "schema.invalid",
          detail: result.error.issues.map((i) => `${i.path.join("@/workflow") || "<root>"}: ${i.message}`).join("; "),
        })
        continue
      }

      const rec = { ...result.data, _source: "vault" }

      // Step 3 (cont): post-merge structural validation (rules 1, 7).
      const validation = validateRecord(rec, filenameStem)
      if (validation) {
        errors.push({
          source: "vault",
          path: filePath,
          name: filenameStem,
          reason: validation.reason,
          detail: validation.detail,
        })
        continue
      }

      // Rule 8: duplicate phase value across cards.
      if (seenPhase.has(rec.phase)) {
        errors.push({
          source: "vault",
          path: filePath,
          name: filenameStem,
          reason: "duplicate",
          detail: `phase "${rec.phase}" already declared by another card; this card excluded`,
        })
        continue
      }
      seenPhase.add(rec.phase)

      // Step 5: Index — frozen record, indexed by phase + every alias.
      const frozen = Object.freeze(rec) as Info
      records.set(rec.phase, frozen)
      for (const alias of rec.aliases ?? []) {
        // Aliases are alternate keys pointing at the SAME frozen record.
        // Don't conflict-check aliases against `phase` — by definition an
        // alias may be the historical name of this same card.
        if (!records.has(alias)) records.set(alias, frozen)
      }
    }

    return { records, errors }
  }

  // ── Public API (L3 contract) ─────────────────────────────────────────

  /**
   * Build the snapshot. Steps 1-6 of L3 §loader-lifecycle (Watch deferred
   * to Stage 7).
   *
   * NEVER throws — schema/ref failures are accumulated in `errors()`.
   * Idempotent: calling `load()` multiple times is equivalent to one call
   * + N calls to `reload()`.
   */
  export async function load(): Promise<void> {
    const t0 = Date.now()
    // Capture prior snapshot for diff (Stage 7.1 D.2). On the very first
    // reload, `priorByName` is empty → computeDiff returns added=all,
    // removed=[], changed=[] per spec.
    const priorByName = snapshot.byName
    const { records, errors } = await loadFromVault()

    // Empty-vault degraded boot (invariant I3).
    if (records.size === 0) {
      if (!warnedEmpty) {
        log.warn("registry.empty", {
          kind: "phase",
          vault_dir: vaultDir(),
          fallback: "DEFAULT_PHASE_BINDINGS (in-code)",
          message:
            "phase registry empty — using built-in defaults. Populate <vault>/atomic/workflow/phase/ to override.",
        })
        warnedEmpty = true
      }
    }

    // Step 5 (cont): build stable-order list (by `order` asc, then `phase` asc).
    // Use a Set keyed by frozen-record reference to deduplicate alias entries.
    const uniqueRecords = new Set<Info>()
    for (const r of records.values()) uniqueRecords.add(r)
    const list = Object.freeze([...uniqueRecords].sort((a, b) => a.order - b.order || a.phase.localeCompare(b.phase)))

    // Step 6: atomic publish (single-pointer swap).
    const next: Snapshot = {
      byName: records,
      list,
      errors: Object.freeze(errors),
    }
    snapshot = next
    loaded = true

    // Notify subscribers post-swap (after the new snapshot is visible to
    // any concurrent reader).
    for (const fn of subscribers) {
      try {
        fn()
      } catch (err) {
        log.warn("onChange.handler.threw", {
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // Step 6 (cont): publish `<kind>.reloaded` per L3 §provider-obligations P5.
    // Fire-and-forget — bus failures must not block engine boot.
    //
    // Payload includes added/removed/changed diff vs prior
    // snapshot. computeDiff dedupes alias entries by object identity (Phase
    // indexes both canonical name + every alias to the same frozen record).
    const diff = RegistryEvent.computeDiff(priorByName.size === 0 ? null : priorByName, records)
    Bus.publish(RegistryEvent.Reloaded, {
      kind: "phase",
      count: uniqueRecords.size,
      errors: errors.length,
      durationMs: Date.now() - t0,
      sourceIds: ["vault"],
      added: diff.added,
      removed: diff.removed,
      changed: diff.changed,
    }).catch((err) => {
      if (RegistryEvent.isBusNotBootstrapped(err)) return
      log.warn("bus.publish.reloaded.failed", {
        kind: "phase",
        err: err instanceof Error ? err.message : String(err),
      })
    })
  }

  /**
   * Start fs.watch on the phase vault subtree. On any *.md mutation
   * (debounced per WatchManager.DEFAULT_DEBOUNCE_MS), re-runs `load()`.
   * No-op when env gate `OPENCODE_HOT_RELOAD=0` is set. Returns
   * disposer; idempotent.
   */
  export function startWatcher(opts?: { debounceMs?: number }): { dispose(): void } {
    return WatchManager.start({
      kind: "phase",
      dir: vaultDir(),
      onChange: () => reload(),
      debounceMs: opts?.debounceMs,
    })
  }

  /** Stop the phase watcher. Idempotent. */
  export function stopWatcher(): void {
    WatchManager.stop("phase")
  }

  /**
   * Lookup by canonical phase name OR alias. When the vault is empty AND
   * the requested name is a known DEFAULT_PHASE_BINDINGS key, returns a
   * synthetic Info constructed from the fallback (degraded boot).
   *
   * Returns `undefined` for unknown names — same shape as `Map.get`.
   */
  export function get(name: string): Info | undefined {
    if (!loaded) {
      // Lazy-load contract: callers may call get() before explicit load().
      // Surface this as undefined; caller should `await load()` first.
      // Logged once for debuggability.
      log.debug("get.before.load", { name })
    }
    const direct = snapshot.byName.get(name)
    if (direct) return direct

    // Empty-vault degraded path: synthesize from DEFAULT_PHASE_BINDINGS.
    if (snapshot.byName.size === 0 && Object.prototype.hasOwnProperty.call(DEFAULT_PHASE_BINDINGS, name)) {
      // Synthesize a minimal Info — only the fields a degraded consumer
      // strictly needs: `phase` (echo of name) + `default_owner` (from
      // fallback map) + sensible defaults for the rest. Frozen.
      const synthetic = Object.freeze({
        phase: kebab(name),
        order: 99, // unknown order in degraded mode
        default_owner: DEFAULT_PHASE_BINDINGS[name],
        section_ownership: [name],
        allowed_leaf_types: ["plan", "design", "impl", "test", "verify"] as LeafType[],
        _source: "default-binding",
      }) as Info
      return synthetic
    }
    return undefined
  }

  /** Frozen snapshot of all phase Infos in stable order. */
  export function all(): ReadonlyArray<Info> {
    return snapshot.list
  }

  /** Most recent reload's load errors. Frozen. NEVER thrown. */
  export function errors(): ReadonlyArray<LoadError> {
    return snapshot.errors
  }

  /** Re-run discover/parse/validate/index/publish. */
  export async function reload(): Promise<void> {
    await load()
  }

  /**
   * Subscribe to post-publish notifications. Disposable returns the
   * unsubscribe handle. Watch (auto-fire on file mutation) is deferred to
   * Stage 7 — until then this only fires after explicit `reload()`.
   */
  export function onChange(fn: () => void): { dispose(): void } {
    subscribers.add(fn)
    return {
      dispose() {
        subscribers.delete(fn)
      },
    }
  }

  /**
   * Per-record provenance. In Stage 1 there is exactly one source ("vault")
   * so the answer is always either `[{source:"vault", fields:[...]}]` or
   * `[]` for unknown names. Multi-source merge lands in Stage 6 federation.
   */
  export function provenance(name: string): Array<{ source: string; fields: string[] }> {
    const rec = snapshot.byName.get(name)
    if (!rec) return []
    const fields = Object.keys(rec).filter((k) => k !== "_source")
    return [{ source: rec._source ?? "vault", fields }]
  }

  // ── Test helpers (NOT part of public L3 surface) ─────────────────────

  /** @internal — reset module state. Used by tests across reboots. */
  export function _resetForTest(): void {
    snapshot = { byName: new Map(), list: Object.freeze([]), errors: Object.freeze([]) }
    loaded = false
    warnedEmpty = false
    subscribers.clear()
  }

  // ── Internal utilities ───────────────────────────────────────────────

  function kebab(s: string): string {
    return s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
  }

  // ── Re-export for typed errors (parity with src/skill/index.ts pattern) ──

  export const InvalidError = NamedError.create(
    "PhaseInvalidError",
    z.object({
      path: z.string(),
      message: z.string().optional(),
      issues: z.custom<z.core.$ZodIssue[]>().optional(),
    }),
  )
}

DispatchRoles.registerPhaseRegistryBridge({
  defaultOwner: (phase) => Phase.get(phase)?.default_owner,
})
