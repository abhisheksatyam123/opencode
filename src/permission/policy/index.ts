// src/policy/index.ts — Policy L3 registry (Stage 2, leaf I2.1).
// -------------------------------------------------------------------------
// Authoritative contract:
//   project/software/opencode/specification/contract/l3-registry.md
//   project/software/opencode/specification/schema/policy-card.md
//
// Loads numeric/boolean policy constants from vault cards instead of scattering
// hardcoded defaults across runtime consumers. Cards live under
// `<vault>/atomic/policy/<domain>.md`. Engine reads via
// `Policy.get("compaction").values.token_threshold` etc.
//
// Architectural shape locked in Stage 1 — same template as
// `src/workflow/phase.ts` / `runtime-role.ts` / `dispatch-reason.ts`:
//
//   - 6-method API: load · get · all · reload · onChange · provenance · errors
//   - 7-step lifecycle (Discover → Parse → Validate → Index → Publish → Notify;
//     Watch deferred to Stage 7)
//   - frozen snapshot, atomic pointer-swap publish
//   - empty-vault tolerant: get() synthesises Info from in-code DEFAULT_*
//     when vault subtree is empty/absent
//   - never throws — bad cards surface via errors()
//
// What's DIFFERENT from Stage-1 registries (per policy-card §field-schema):
//
//   - Record schema is a **discriminated union** keyed on `domain` — every
//     domain has a distinct `values` shape (compaction vs scheduler vs budget,
//     etc). The Phase template's flat schema doesn't fit.
//   - **Per-key fallback** (validation rule 3): when one key in `values` is
//     missing or invalid, that key drops to engine default while the rest
//     of the card is preserved. Phase / RuntimeRole / DispatchReason dropped
//     the whole card on schema violation; here we degrade per-knob.
//   - **Forward-compat unknown keys** (rule 6): unknown keys logged INFO
//     and ignored. Older engines reading newer cards stay green.
// -------------------------------------------------------------------------

import path from "path"
import { existsSync } from "fs"
import fs from "fs/promises"
import z from "zod"
import { ConfigMarkdown } from "@/config/markdown"
import { Log } from "@/foundation/util/log"
import { vaultPath } from "@/notes/root"
import { Bus, WatchManager } from "@/bus"
import { RegistryEvent } from "@/bus/registry-events"

export namespace Policy {
  const log = Log.create({ service: "policy-registry" })

  // ── Domain catalogue ─────────────────────────────────────────────────
  //
  // Initial set (Stage 2). Each domain declares (a) the canonical key
  // names it expects, (b) the value type per key, (c) the engine default
  // when the key is missing or invalid.
  //
  // Adding a new domain = adding an entry here + a per-domain schema
  // below. Removing a domain = bumping policy-card §version + migration
  // table.

  export const Domain = z.enum([
    "compaction",
    "context-packet",
    "scheduler",
    "budget",
    "bg-task",
    "retrieval",
    "predicate",
    "delegation",
  ])
  export type Domain = z.infer<typeof Domain>

  // Per-domain `values` schemas. Strict shape (rejects unknown keys at
  // the schema level so we can route them through the rule-6 forward-
  // compat path explicitly via `passthrough()` + post-parse filter).

  const CompactionValues = z
    .object({
      token_threshold: z.number().int().positive().describe("Total token count above which compaction fires."),
      retain_recent_n: z.number().int().nonnegative().describe("Most-recent N turns kept verbatim post-compaction."),
      summary_target_tokens: z.number().int().positive().describe("Target token budget for the rolled summary."),
    })
    .passthrough()

  const ContextPacketValues = z
    .object({
      excerpt_words: z.number().int().positive().describe("Max words per note excerpt in the packet."),
      link_cap: z.number().int().nonnegative().describe("Max links per packet section."),
      tail_length: z.number().int().nonnegative().describe("Final-N-lines retained verbatim."),
      // Standard-tier limits (I2.3). The narrow/wide tiers scale around
      // these values in code (`src/session/context-packet.ts:TIER`); only
      // the canonical "standard" row is vault-loaded. Operators wanting
      // narrow/wide overrides in v1 should set the cfg override path
      // documented in `policy-card §override`.
      progress: z.number().int().positive().optional().describe("Standard-tier max Progress entries."),
      progress_bytes: z.number().int().positive().optional().describe("Standard-tier max Progress bytes."),
      excerpts: z.number().int().nonnegative().optional().describe("Standard-tier max excerpt count."),
      residue: z.number().int().nonnegative().optional().describe("Standard-tier residue cap."),
    })
    .passthrough()

  const SchedulerValues = z
    .object({
      parallel_limit: z.number().int().positive().describe("Max concurrent dispatched siblings."),
      dedup_window_ms: z.number().int().nonnegative().describe("claimDelegation dedup horizon (ms)."),
    })
    .passthrough()

  const BudgetValues = z
    .object({
      turn_cap: z.number().int().positive().describe("Default DEFAULT_TASK_BUDGET turn count."),
      // Hard cap — refuses dispatch on overflow. Maps to `tokens_hard` in
      // `src/tool/task/budget.ts:DEFAULT_TASK_BUDGET`.
      token_cap: z.number().int().positive().describe("Default DEFAULT_TASK_BUDGET hard token count."),
      // Soft cap — surfaces a packet warning but permits dispatch. Maps
      // to `tokens_soft` in DEFAULT_TASK_BUDGET. Optional — when absent
      // consumer falls back to in-code default 120_000 (I2.5).
      token_soft_cap: z.number().int().positive().optional().describe("Default DEFAULT_TASK_BUDGET soft token count."),
    })
    .passthrough()

  const BgTaskValues = z
    .object({
      ttl_ms: z.number().int().positive().describe("Background task record TTL (ms)."),
      cleanup_window_ms: z.number().int().nonnegative().describe("Cleanup sweep window (ms)."),
    })
    .passthrough()

  const RetrievalValues = z
    .object({
      tag_weight: z.number().min(0).max(1).describe("[0,1] weight on tag-overlap score."),
      path_weight: z.number().min(0).max(1).describe("[0,1] weight on path-prefix score."),
      backlink_weight: z.number().min(0).max(1).describe("[0,1] weight on backlink-count score."),
      recency_half_life_days: z.number().positive().describe("Half-life of recency boost (days)."),
    })
    .passthrough()

  const PredicateValues = z
    .object({
      timeout_ms: z.number().int().positive().describe("Default per-predicate timeout (ms)."),
    })
    .passthrough()

  // Delegation policy replaces the old hardcoded provider allowlist.
  // allowed_providers: explicit list of provider IDs permitted for subagent delegation.
  // inherit_from_enabled_providers: when true, fall back to cfg.enabled_providers if
  //   allowed_providers is absent/empty. Seed default: true (zero-config for new installs).
  const DelegationValues = z
    .object({
      allowed_providers: z
        .array(z.string().min(1))
        .optional()
        .describe("Provider IDs allowed for subagent delegation. qpilot/qgenie only."),
      inherit_from_enabled_providers: z
        .boolean()
        .optional()
        .describe("Policy seed knob; subagent delegation remains qpilot/qgenie-only."),
    })
    .passthrough()

  /**
   * Discriminated-union of per-domain Info records. The `domain` field
   * selects which `values` schema applies. zod's `discriminatedUnion`
   * gives us schema-driven dispatch + exhaustiveness in TypeScript.
   */
  export const Info = z.discriminatedUnion("domain", [
    z.object({
      domain: z.literal("compaction"),
      version: z.string().min(1),
      values: CompactionValues,
      description: z.string().optional(),
      tags: z.array(z.string()).optional(),
      min_engine: z.string().optional(),
      _source: z.string().optional(),
    }),
    z.object({
      domain: z.literal("context-packet"),
      version: z.string().min(1),
      values: ContextPacketValues,
      description: z.string().optional(),
      tags: z.array(z.string()).optional(),
      min_engine: z.string().optional(),
      _source: z.string().optional(),
    }),
    z.object({
      domain: z.literal("scheduler"),
      version: z.string().min(1),
      values: SchedulerValues,
      description: z.string().optional(),
      tags: z.array(z.string()).optional(),
      min_engine: z.string().optional(),
      _source: z.string().optional(),
    }),
    z.object({
      domain: z.literal("budget"),
      version: z.string().min(1),
      values: BudgetValues,
      description: z.string().optional(),
      tags: z.array(z.string()).optional(),
      min_engine: z.string().optional(),
      _source: z.string().optional(),
    }),
    z.object({
      domain: z.literal("bg-task"),
      version: z.string().min(1),
      values: BgTaskValues,
      description: z.string().optional(),
      tags: z.array(z.string()).optional(),
      min_engine: z.string().optional(),
      _source: z.string().optional(),
    }),
    z.object({
      domain: z.literal("retrieval"),
      version: z.string().min(1),
      values: RetrievalValues,
      description: z.string().optional(),
      tags: z.array(z.string()).optional(),
      min_engine: z.string().optional(),
      _source: z.string().optional(),
    }),
    z.object({
      domain: z.literal("predicate"),
      version: z.string().min(1),
      values: PredicateValues,
      description: z.string().optional(),
      tags: z.array(z.string()).optional(),
      min_engine: z.string().optional(),
      _source: z.string().optional(),
    }),
    z.object({
      domain: z.literal("delegation"),
      version: z.string().min(1),
      values: DelegationValues,
      description: z.string().optional(),
      tags: z.array(z.string()).optional(),
      min_engine: z.string().optional(),
      _source: z.string().optional(),
    }),
  ])
  export type Info = z.infer<typeof Info>

  /**
   * Type helper: extract a domain's Info shape. Used by consumers calling
   * `Policy.get("compaction")` who need TS to narrow `values` to the
   * compaction-specific keys.
   */
  export type InfoOf<D extends Domain> = Extract<Info, { domain: D }>

  // ── LoadError + types ────────────────────────────────────────────────

  export interface LoadError {
    source: string
    path?: string
    name?: string
    reason: "schema.invalid" | "ref.unresolved" | "duplicate" | "engine.too-old" | "io.read" | "frontmatter.parse"
    detail: string
  }

  // ── Built-in fallbacks ───────────────────────────────────────────────
  //
  // DEFAULT_POLICY_VALUES per L3 §empty-vault. Mirrors the existing
  // in-code constants in their consumer files exactly so behavior is
  // unchanged when the vault is empty.
  //
  // Sources (Stage 2 baseline):
  //   compaction.token_threshold           ← src/session/overflow.ts:11 DEFAULT_TRIGGER_TOKENS = 400_000
  //                                          (note: cfg.compaction.trigger_tokens is the existing override path;
  //                                          Policy registry sits BELOW cfg in precedence per established pattern)
  //   compaction.retain_recent_n           ← unset in current code (compaction.ts uses summary boundary, not turn count)
  //                                          → seed default 4 (covers typical "last 2 user/assistant pairs")
  //   compaction.summary_target_tokens     ← unset literal; policy-card §migration says new knob, default 8_000
  //   context-packet.excerpt_words         ← src/session/context-packet.ts:411 standard tier excerpt_words=130
  //   context-packet.link_cap              ← src/session/context-packet.ts:411 standard tier excerpts=3 (link cap)
  //   context-packet.tail_length           ← src/session/context-packet.ts:411 standard tier residue=3
  //   context-packet.{progress,progress_bytes,excerpts,residue}
  //                                        ← src/session/context-packet.ts:411 standard-tier row
  //                                          (narrow/wide stay scaled in code per I2.3)
  //   scheduler.parallel_limit             ← policy default 4
  //   scheduler.dedup_window_ms            ← src/tool/task/budget.ts:193 DELEGATION_TTL_SECONDS = 1800s = 1_800_000ms
  //   budget.turn_cap                      ← no current literal; policy-card §migration introduces new knob, default 50
  //   budget.token_cap                     ← src/tool/task/budget.ts:157 DEFAULT_TASK_BUDGET.tokens_hard = 180_000
  //   budget.token_soft_cap                ← src/tool/task/budget.ts:158 DEFAULT_TASK_BUDGET.tokens_soft = 120_000 (I2.5)
  //   bg-task.ttl_ms                       ← src/tool/task/index.ts:1581 2 * 60 * 60 * 1000 = 7_200_000
  //   bg-task.cleanup_window_ms            ← derived from above; default 7_200_000 (same window)
  //   retrieval.*                          ← Stage 4 — not yet wired
  //   predicate.timeout_ms                 ← Stage 3 — not yet wired; seed 5_000

  type DefaultValues = {
    [D in Domain]: InfoOf<D>["values"]
  }

  export const DEFAULT_POLICY_VALUES: Readonly<DefaultValues> = Object.freeze({
    compaction: Object.freeze({
      token_threshold: 400_000,
      retain_recent_n: 4,
      summary_target_tokens: 8_000,
    }),
    "context-packet": Object.freeze({
      excerpt_words: 130,
      link_cap: 3,
      tail_length: 3,
      progress: 5,
      progress_bytes: 1600,
      excerpts: 3,
      residue: 3,
    }),
    scheduler: Object.freeze({
      parallel_limit: 4,
      dedup_window_ms: 1_800_000,
    }),
    budget: Object.freeze({
      turn_cap: 50,
      token_cap: 180_000,
      token_soft_cap: 120_000,
    }),
    "bg-task": Object.freeze({
      ttl_ms: 7_200_000,
      cleanup_window_ms: 7_200_000,
    }),
    retrieval: Object.freeze({
      tag_weight: 0.4,
      path_weight: 0.3,
      backlink_weight: 0.2,
      recency_half_life_days: 30,
    }),
    predicate: Object.freeze({
      timeout_ms: 5_000,
    }),
    // Default delegation allowlist is qpilot/qgenie only.
    // allowed_providers absent → engine uses the qpilot/qgenie seed default.
    delegation: Object.freeze({
      allowed_providers: [] as string[],
      inherit_from_enabled_providers: true,
    }),
  } as DefaultValues)

  // ── Internal state ───────────────────────────────────────────────────

  type Snapshot = {
    /** domain → frozen Info. */
    byDomain: ReadonlyMap<Domain, Info>
    /** Stable-ordered list (by domain string asc). */
    list: ReadonlyArray<Info>
    errors: ReadonlyArray<LoadError>
  }

  let snapshot: Snapshot = {
    byDomain: new Map(),
    list: Object.freeze([]),
    errors: Object.freeze([]),
  }
  let loaded = false
  let warnedEmpty = false
  const subscribers = new Set<() => void>()

  function vaultDir(): string {
    return vaultPath.atomic("policy")
  }

  // ── Per-key fallback merge (validation rule 3) ───────────────────────
  //
  // policy-card §validation-rules item 3:
  //   "Required key missing in `values` → reason: schema.invalid, lists
  //    missing keys; falls back to engine default for that key only
  //    (other keys preserved)."
  //
  // Implementation: parse the per-domain `values` schema with safeParse;
  // on failure, walk through the issues, replace each invalid/missing
  // key with its DEFAULT_POLICY_VALUES counterpart, re-merge with the
  // raw user values for keys not in error, and treat the merged record
  // as the published values. Forward-compat unknown keys from the raw
  // record are preserved (passthrough()).
  //
  // We accept this is more permissive than Stage-1 registries which
  // dropped the whole card on schema failure. The §validation-rules
  // explicitly allows it.

  function mergeWithDefaults<D extends Domain>(
    domain: D,
    rawValues: Record<string, unknown>,
    perKeyErrors: string[],
  ): InfoOf<D>["values"] {
    const defaults = DEFAULT_POLICY_VALUES[domain] as Record<string, unknown>
    const merged: Record<string, unknown> = { ...rawValues }
    for (const key of Object.keys(defaults)) {
      const v = rawValues[key]
      if (v === undefined) {
        merged[key] = defaults[key]
        perKeyErrors.push(`values.${key} missing — using default ${JSON.stringify(defaults[key])}`)
      }
    }
    return merged as InfoOf<D>["values"]
  }

  /**
   * Validate one record. Returns either a fully-validated Info or a
   * structured LoadError detail. Implements rule 3 (per-key fallback) by
   * doing a two-pass parse: first a strict pass to surface issues, then
   * a permissive merge with defaults to produce a usable record.
   */
  function validateRecord(
    raw: unknown,
    filenameStem: string,
  ): { ok: true; rec: Info } | { ok: false; reason: LoadError["reason"]; detail: string } {
    if (!raw || typeof raw !== "object") {
      return { ok: false, reason: "schema.invalid", detail: "frontmatter is not an object" }
    }
    const obj = raw as Record<string, unknown>
    const domain = obj["domain"]

    // Rule 1: filename stem MUST equal `domain`.
    if (typeof domain !== "string") {
      return { ok: false, reason: "schema.invalid", detail: `domain field is not a string` }
    }
    if (domain !== filenameStem) {
      return {
        ok: false,
        reason: "schema.invalid",
        detail: `domain field "${domain}" must equal filename stem "${filenameStem}"`,
      }
    }
    // Rule 2: domain MUST be in the catalogue.
    const domainParse = Domain.safeParse(domain)
    if (!domainParse.success) {
      return {
        ok: false,
        reason: "schema.invalid",
        detail: `unknown domain "${domain}" — must be one of ${Domain.options.join(", ")}`,
      }
    }
    const d = domainParse.data

    // Rule 3 + 6: per-key merge with defaults; unknown keys preserved.
    const rawValues = (obj["values"] && typeof obj["values"] === "object" ? obj["values"] : {}) as Record<
      string,
      unknown
    >
    const perKeyErrors: string[] = []
    const mergedValues = mergeWithDefaults(d, rawValues, perKeyErrors)

    // Now parse the merged record through the discriminated union to
    // catch type errors on user-supplied (non-defaulted) keys per rule 4.
    const candidate = {
      ...obj,
      values: mergedValues,
      version: typeof obj["version"] === "string" ? obj["version"] : "1.0.0",
    }
    const result = Info.safeParse(candidate)
    if (!result.success) {
      // Rule 4 / 5: type or range mismatch. Drop the offending keys to
      // defaults and retry once. If it still fails, surface as
      // schema.invalid with the full issue list.
      const repaired = { ...mergedValues } as Record<string, unknown>
      for (const issue of result.error.issues) {
        // issue.path is e.g. ["values", "token_threshold"]
        if (issue.path[0] === "values" && typeof issue.path[1] === "string") {
          const key = issue.path[1]
          const defs = DEFAULT_POLICY_VALUES[d] as Record<string, unknown>
          if (key in defs) {
            repaired[key] = defs[key]
            perKeyErrors.push(`values.${key} invalid (${issue.message}) — reset to default`)
          }
        }
      }
      const retry = Info.safeParse({ ...candidate, values: repaired })
      if (!retry.success) {
        return {
          ok: false,
          reason: "schema.invalid",
          detail: retry.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; "),
        }
      }
      const rec = { ...retry.data, _source: "vault" } as Info
      // Note rule 6 unknown keys + perKeyErrors via debug log; not a hard
      // error (card still loads, just degraded).
      if (perKeyErrors.length > 0) {
        log.info("policy.partial-default", { domain: d, file: filenameStem, notes: perKeyErrors })
      }
      return { ok: true, rec }
    }

    // Strict pass succeeded. Tag _source and return.
    const rec = { ...result.data, _source: "vault" } as Info
    if (perKeyErrors.length > 0) {
      log.info("policy.partial-default", { domain: d, file: filenameStem, notes: perKeyErrors })
    }
    return { ok: true, rec }
  }

  /** Scan vault subtree, parse every .md, accumulate Info records + errors. */
  async function loadFromVault(): Promise<{
    records: Map<Domain, Info>
    errors: LoadError[]
  }> {
    const records = new Map<Domain, Info>()
    const errors: LoadError[] = []
    const dir = vaultDir()

    if (!existsSync(dir)) return { records, errors }

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

    const seen = new Set<Domain>()
    for (const filename of dirents.filter((n) => n.endsWith(".md"))) {
      const filenameStem = filename.replace(/\.md$/, "")
      const filePath = path.join(dir, filename)

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

      const result = validateRecord(parsed.data, filenameStem)
      if (!result.ok) {
        errors.push({
          source: "vault",
          path: filePath,
          name: filenameStem,
          reason: result.reason,
          detail: result.detail,
        })
        continue
      }

      const rec = result.rec
      // Rule 8: duplicate domain.
      if (seen.has(rec.domain)) {
        errors.push({
          source: "vault",
          path: filePath,
          name: filenameStem,
          reason: "duplicate",
          detail: `domain "${rec.domain}" already declared by another card; this card excluded`,
        })
        continue
      }
      seen.add(rec.domain)

      records.set(rec.domain, Object.freeze(rec) as Info)
    }

    return { records, errors }
  }

  // ── Public API ───────────────────────────────────────────────────────

  export async function load(): Promise<void> {
    const t0 = Date.now()
    const priorByDomain = snapshot.byDomain // Diff reload output against the previous snapshot.
    const { records, errors } = await loadFromVault()

    if (records.size === 0) {
      if (!warnedEmpty) {
        log.warn("registry.empty", {
          kind: "policy",
          vault_dir: vaultDir(),
          fallback: "DEFAULT_POLICY_VALUES (in-code)",
          message: "policy registry empty — using built-in defaults. Populate <vault>/atomic/policy/ to override.",
        })
        warnedEmpty = true
      }
    }

    const list = Object.freeze([...records.values()].sort((a, b) => a.domain.localeCompare(b.domain)))

    snapshot = {
      byDomain: records,
      list,
      errors: Object.freeze(errors),
    }
    loaded = true

    for (const fn of subscribers) {
      try {
        fn()
      } catch (err) {
        log.warn("onChange.handler.threw", {
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // Publish `registry.reloaded` so registry consumers can react to policy changes.
    // Diff fields by `domain` (canonical key for policy).
    const diff = RegistryEvent.computeDiff(priorByDomain.size === 0 ? null : priorByDomain, records)
    Bus.publish(RegistryEvent.Reloaded, {
      kind: "policy",
      count: records.size,
      errors: errors.length,
      durationMs: Date.now() - t0,
      sourceIds: ["vault"],
      added: diff.added,
      removed: diff.removed,
      changed: diff.changed,
    }).catch((err) => {
      if (RegistryEvent.isBusNotBootstrapped(err)) return
      log.warn("bus.publish.reloaded.failed", {
        kind: "policy",
        err: err instanceof Error ? err.message : String(err),
      })
    })
  }

  /** Stage 7 (I7.1): start fs.watch on the policy vault subtree. */
  export function startWatcher(opts?: { debounceMs?: number }): { dispose(): void } {
    return WatchManager.start({
      kind: "policy",
      dir: vaultDir(),
      onChange: () => reload(),
      debounceMs: opts?.debounceMs,
    })
  }

  /** Stop the policy watcher. Idempotent. */
  export function stopWatcher(): void {
    WatchManager.stop("policy")
  }

  /**
   * Lookup by domain name. Empty-vault degraded path: synthesises a
   * minimal Info from `DEFAULT_POLICY_VALUES[domain]` so callers
   * uniformly read `Policy.get("compaction").values.token_threshold`
   * regardless of whether the vault has been populated.
   *
   * Type narrowing: `D extends Domain` lets the return type project to
   * the discriminated-union member with that exact `domain` literal —
   * `Policy.get("compaction").values.token_threshold` typechecks as
   * `number`, not `unknown`.
   */
  export function get<D extends Domain>(domain: D): InfoOf<D> | undefined
  export function get(domain: string): Info | undefined
  export function get(domain: string): Info | undefined {
    if (!loaded) {
      log.debug("get.before.load", { domain })
    }
    const d = Domain.safeParse(domain)
    if (!d.success) return undefined

    const direct = snapshot.byDomain.get(d.data)
    if (direct) return direct

    // Empty-vault degraded path.
    const defaults = DEFAULT_POLICY_VALUES[d.data]
    return Object.freeze({
      domain: d.data,
      version: "1.0.0",
      values: defaults,
      _source: "default-binding",
    } as Info)
  }

  export function all(): ReadonlyArray<Info> {
    return snapshot.list
  }

  export function errors(): ReadonlyArray<LoadError> {
    return snapshot.errors
  }

  export async function reload(): Promise<void> {
    await load()
  }

  export function onChange(fn: () => void): { dispose(): void } {
    subscribers.add(fn)
    return {
      dispose() {
        subscribers.delete(fn)
      },
    }
  }

  export function provenance(domain: string): Array<{ source: string; fields: string[] }> {
    const d = Domain.safeParse(domain)
    if (!d.success) return []
    const rec = snapshot.byDomain.get(d.data)
    if (!rec) return []
    return [{ source: rec._source ?? "vault", fields: Object.keys(rec).filter((k) => k !== "_source") }]
  }

  /** @internal — test reset hook. */
  export function _resetForTest(): void {
    snapshot = { byDomain: new Map(), list: Object.freeze([]), errors: Object.freeze([]) }
    loaded = false
    warnedEmpty = false
    subscribers.clear()
  }
}
