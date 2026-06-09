// src/session/quota.ts — Stage-10 principal-keyed quota accounting.
// -------------------------------------------------------------------------
// Authoritative contracts:
//   project/software/opencode/architecture/scheduler-quota.md       (algorithm)
//   project/software/opencode/specification/schema/quota-state.md    (file shape)
//   project/software/opencode/decision/adr-hierarchical-quota.md     (principal=session_id, aggregation=B)
//   project/software/opencode/specification/schema/policy-card.md    §scheduler + §budget (Stage-10 keys)
//
// Stage-10 of file-loaded-os-roadmap. Adds principal-keyed (session_id)
// quota accounting OVER existing per-task `BudgetEntry` (Stage 2). The two
// counters coexist as orthogonal sub-buckets:
//   • `BudgetEntry`        — keyed by taskNote (intra-task)            kept
//   • `PrincipalEntry`     — keyed by session_id (cross-task)          new
//
// Aggregation (per ADR §Decision): single counter at root
// (`principals[session_id].tokens_used`). Σ-children invariant by
// construction — every PCB in the spawn sub-tree increments the same cell.
// The session_id principal mapping is established at PCB creation time via
// `attributedPrincipal()`; subsequent increments hit the cached value.
//
// File location (per Stage-0.5 vault-as-sole-filesystem):
//   <vault>/state/scheduler/quota.json
//
// Concurrency model:
//   • Single writer per session per process (the session loop owning that
//     session_id). Cross-session races handled via atomic write+rename
//     (`Filesystem.write` already does this — temp+rename pattern).
//   • Last-rename-wins under simultaneous writes — accounting is
//     eventually-consistent; a lost increment is re-applied on the next
//     token event. Acceptable for an accounting file.
//
// Reversibility:
//   • Setting `tokens_quota = null` (or absent policy keys) collapses
//     Stage-10 logic to no-op (Stage-2 behaviour preserved).
//   • Deleting `quota.json` → engine recreates empty on next access;
//     tokens_used resets to 0. Operator-facing reset gesture.
// -------------------------------------------------------------------------

import path from "path"
import { existsSync } from "fs"
import fs from "fs/promises"
import z from "zod"
import { Filesystem } from "@/foundation/util/filesystem"
import { Log } from "@/foundation/util/log"
import { vaultPath } from "@/notes/root"
import { Policy } from "@/permission/policy"
import { ProcessRegistry } from "@/process/registry"
import { Bus } from "@/bus"
import { ProcessEvent } from "@/process/events"
import { RegistryEvent } from "@/bus/registry-events"

export namespace Quota {
  const log = Log.create({ service: "quota" })

  // ── Types (mirrors quota-state.md §Top-level shape + §Principal entry) ──

  export const PrincipalEntry = z.object({
    principal_id: z.string().min(1),
    tokens_used: z.number().int().nonnegative(),
    tokens_quota: z.number().int().nonnegative().nullable(),
    tokens_soft_throttle_at: z.number().int().nonnegative().nullable(),
    preemption_threshold_tokens: z.number().int().nonnegative().nullable(),
    last_serviced_at: z.string().min(1),
    child_pids: z.array(z.string()),
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
  })
  export type PrincipalEntry = z.infer<typeof PrincipalEntry>

  export const QuotaState = z.object({
    version: z.literal(1),
    principals: z.record(z.string(), PrincipalEntry),
    updated_at: z.string().min(1),
  })
  export type QuotaState = z.infer<typeof QuotaState>

  /**
   * Reserved key for orphan PCBs (no parent_pid, no session_id mapping) —
   * engine-level background tasks need a bucket. Per ADR §Consequences.
   */
  export const ENGINE_PRINCIPAL_ID = "__engine__"

  // ── Disk I/O ─────────────────────────────────────────────────────────

  function statePath(): string {
    return vaultPath.state("scheduler", "quota.json")
  }

  function emptyState(): QuotaState {
    return Object.freeze({
      version: 1 as const,
      principals: {},
      updated_at: new Date().toISOString(),
    }) as QuotaState
  }

  /**
   * Read `quota.json` from disk. Missing file → empty state. Corrupt file
   * → empty state + WARN (per quota-state.md §Validation rules — defensive
   * read, never crash).
   */
  export async function read(): Promise<QuotaState> {
    const p = statePath()
    if (!existsSync(p)) return emptyState()
    let raw: string
    try {
      raw = await Filesystem.readText(p)
    } catch (err) {
      log.warn("read.io.failed", {
        path: p,
        err: err instanceof Error ? err.message : String(err),
      })
      return emptyState()
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      log.warn("read.parse.failed", {
        path: p,
        err: err instanceof Error ? err.message : String(err),
      })
      return emptyState()
    }
    return validate(parsed)
  }

  /**
   * Validate a raw object against the QuotaState schema, applying the
   * §Validation rules (defensive — corrupt entries don't crash, just
   * degrade silently with WARN; valid entries are preserved).
   */
  function validate(raw: unknown): QuotaState {
    if (!raw || typeof raw !== "object") {
      log.warn("validate.not-object")
      return emptyState()
    }
    const obj = raw as Record<string, unknown>

    // Rule 1: top-level version === 1 (forward-compat).
    if (obj["version"] !== 1) {
      log.warn("validate.version.mismatch", { found: obj["version"], expected: 1 })
      return emptyState()
    }

    const rawPrincipals = (
      obj["principals"] && typeof obj["principals"] === "object" ? obj["principals"] : {}
    ) as Record<string, unknown>
    const principals: Record<string, PrincipalEntry> = {}

    for (const [key, val] of Object.entries(rawPrincipals)) {
      const result = PrincipalEntry.safeParse(val)
      if (!result.success) {
        log.warn("validate.principal.invalid", {
          principal_id: key,
          issues: result.error.issues.map((i) => `${i.path.join("@/process/session") || "<root>"}: ${i.message}`).join("; "),
        })
        continue
      }
      const entry = result.data
      // Rule 2: principal_id matches map key.
      if (entry.principal_id !== key) {
        log.warn("validate.principal.key.mismatch", { key, principal_id: entry.principal_id })
        continue
      }
      principals[key] = entry
    }

    return Object.freeze({
      version: 1 as const,
      principals,
      updated_at: typeof obj["updated_at"] === "string" ? (obj["updated_at"] as string) : new Date().toISOString(),
    }) as QuotaState
  }

  /**
   * Write `quota.json` atomically. Per quota-state.md §Concurrency: rely on
   * `Filesystem.write` (which uses temp+rename internally) for atomicity.
   * Last-rename-wins under simultaneous writes; lost increments re-apply
   * via the next token event (eventual consistency).
   */
  export async function write(state: QuotaState): Promise<void> {
    const p = statePath()
    // mkdir -p the state subdirectory if needed.
    await fs.mkdir(path.dirname(p), { recursive: true })
    const next: QuotaState = {
      ...state,
      updated_at: new Date().toISOString(),
    }
    await Filesystem.write(p, JSON.stringify(next, null, 2) + "\n")
  }

  // ── Defaults resolution (per quota-state.md §Defaults resolution) ─────

  /**
   * Resolve Stage-10 default values from the Policy L3 registry. All
   * Stage-10 keys are additive + nullable — absent policy keys collapse
   * to `null`, which disables the corresponding feature (per ADR
   * §Reversibility).
   *
   * The Policy registry's per-key fallback (§validation rule 3) means we
   * never observe undefined here — but we defensively coalesce to `null`
   * to match the schema's nullable semantics.
   */
  function defaultPrincipalCaps(): {
    tokens_quota: number | null
    tokens_soft_throttle_at: number | null
    preemption_threshold_tokens: number | null
  } {
    const budget = Policy.get("budget")
    const scheduler = Policy.get("scheduler")
    // The Policy values are typed via discriminated union; Stage-10 keys
    // were added as additive `passthrough()` fields so they may be absent.
    // Coalesce undefined → null (the schema's "disabled" sentinel).
    const budgetValues = budget?.values as Record<string, unknown> | undefined
    const schedValues = scheduler?.values as Record<string, unknown> | undefined
    return {
      tokens_quota:
        typeof budgetValues?.["token_quota_per_user"] === "number"
          ? (budgetValues["token_quota_per_user"] as number)
          : null,
      tokens_soft_throttle_at:
        typeof budgetValues?.["soft_throttle_at"] === "number" ? (budgetValues["soft_throttle_at"] as number) : null,
      preemption_threshold_tokens:
        typeof schedValues?.["preemption_threshold_tokens"] === "number"
          ? (schedValues["preemption_threshold_tokens"] as number)
          : null,
    }
  }

  // ── Principal lifecycle ─────────────────────────────────────────────

  /**
   * Ensure a principal entry exists for `session_id`, seeding from policy
   * defaults if missing. Idempotent. Returns the (possibly newly-seeded)
   * entry.
   *
   * Per quota-state.md §Defaults resolution.
   */
  export async function ensurePrincipal(session_id: string): Promise<PrincipalEntry> {
    const state = await read()
    const existing = state.principals[session_id]
    if (existing) return existing
    const caps = defaultPrincipalCaps()
    const now = new Date().toISOString()
    const entry: PrincipalEntry = {
      principal_id: session_id,
      tokens_used: 0,
      tokens_quota: caps.tokens_quota,
      tokens_soft_throttle_at: caps.tokens_soft_throttle_at,
      preemption_threshold_tokens: caps.preemption_threshold_tokens,
      last_serviced_at: now,
      child_pids: [],
      created_at: now,
      updated_at: now,
    }
    const next: QuotaState = {
      ...state,
      principals: { ...state.principals, [session_id]: entry },
    }
    await write(next)
    return entry
  }

  // ── Token accounting (single write site — aggregation B) ─────────────

  /**
   * Increment a principal's `tokens_used` by `delta`. Creates the entry
   * via policy defaults if absent. Σ-children invariant maintained by
   * construction: all descendants of a PCB increment the same cell
   * (single counter at root per ADR §Decision aggregation B).
   *
   * Returns the post-increment entry.
   */
  export async function incrementPrincipal(session_id: string, delta: number): Promise<PrincipalEntry> {
    if (delta < 0) {
      log.warn("incrementPrincipal.negative.delta", { session_id, delta })
      delta = 0
    }
    const state = await read()
    const existing = state.principals[session_id]
    const caps = existing
      ? {
          tokens_quota: existing.tokens_quota,
          tokens_soft_throttle_at: existing.tokens_soft_throttle_at,
          preemption_threshold_tokens: existing.preemption_threshold_tokens,
        }
      : defaultPrincipalCaps()
    const now = new Date().toISOString()
    const next_entry: PrincipalEntry = existing
      ? {
          ...existing,
          tokens_used: existing.tokens_used + delta,
          updated_at: now,
        }
      : {
          principal_id: session_id,
          tokens_used: delta,
          tokens_quota: caps.tokens_quota,
          tokens_soft_throttle_at: caps.tokens_soft_throttle_at,
          preemption_threshold_tokens: caps.preemption_threshold_tokens,
          last_serviced_at: now,
          child_pids: [],
          created_at: now,
          updated_at: now,
        }
    const next: QuotaState = {
      ...state,
      principals: { ...state.principals, [session_id]: next_entry },
    }
    await write(next)
    return next_entry
  }

  // ── Hierarchical attribution (per ADR §Decision + scheduler-quota.md
  //                              §Hierarchical aggregation) ─────────────

  /**
   * Side-map cache populated at PCB-creation (Stage 10 / I10.3).
   *
   * Purpose: collapse the O(depth) parent_pid walk into O(1) lookup. The
   * cache holds the resolved session_id for every PCB the engine has
   * spawned this process lifetime. Populated eagerly via the
   * `process.spawned` Bus subscription (see `subscribe()` below); evicted
   * on `process.exited`.
   *
   * Invariants:
   *   • Cache miss is ALWAYS safe — falls back to the lazy walk + populates.
   *     Disabling the cache (`_disableCacheForTest = true`) MUST yield
   *     byte-identical attribution for any pcb (parity property).
   *   • Cache eviction on exit is a hint, not a correctness requirement —
   *     stale entries cost only memory; they never produce wrong attribution
   *     because session_id never changes for a given pid in our model
   *     (a pid is single-spawn per process-registry contract).
   */
  const principalCache = new Map<string, string>()
  let cacheDisabled = false

  /**
   * Walk-only attribution — the O(depth) algorithm, used both as cache
   * miss fallback AND as the "disable cache" parity reference.
   *
   * Cycle guard: bounded by `visited` Set; on cycle detection falls back
   * to current pcb's session_id + WARN (per scheduler-quota.md §Failure
   * modes).
   *
   * Orphan handling: if pcb has parent_pid set but the parent is missing
   * from the registry (reaped, etc.), use the current pcb's own
   * session_id — the chain just terminates earlier than expected.
   */
  function walkPrincipal(pcb: ProcessRegistry.PCB): string {
    const visited = new Set<string>([pcb.pid])
    let cur: ProcessRegistry.PCB | undefined = pcb
    while (cur && cur.parent_pid) {
      if (visited.has(cur.parent_pid)) {
        log.warn("attributedPrincipal.cycle.detected", { pid: pcb.pid, at: cur.pid })
        return cur.session_id
      }
      const parent = ProcessRegistry.get(cur.parent_pid)
      if (!parent) break // chain terminates — use current cur.session_id (= pcb's via inheritance).
      visited.add(parent.pid)
      cur = parent
    }
    return cur?.session_id ?? pcb.session_id
  }

  /**
   * Resolve a PCB's principal_id (= root session_id of its spawn chain).
   *
   * Fast path: O(1) cache hit when the side-map cache has been populated
   * by a prior `cachePrincipal(pcb)` (typically via the spawn-event
   * subscription). Slow path: O(depth) walk + populate, identical to the
   * I10.1 implementation.
   *
   * Behaviour is identical with or without the cache (parity property);
   * the cache is purely an optimization.
   */
  export function attributedPrincipal(pcb: ProcessRegistry.PCB): string {
    if (!cacheDisabled) {
      const cached = principalCache.get(pcb.pid)
      if (cached) return cached
    }
    const principal = walkPrincipal(pcb)
    if (!cacheDisabled) principalCache.set(pcb.pid, principal)
    return principal
  }

  /**
   * Eagerly seed the side-map cache for a PCB. Called by the
   * `process.spawned` Bus subscriber (`subscribe()`). Idempotent: a
   * second call with the same pid is a no-op (a pid never re-binds to
   * a different principal during its lifetime, per Stage-8 PCB contract).
   *
   * Returns the resolved principal_id so callers can chain
   * `addChildPid` without re-walking.
   */
  export function cachePrincipal(pcb: ProcessRegistry.PCB): string {
    const existing = principalCache.get(pcb.pid)
    if (existing) return existing
    const principal = walkPrincipal(pcb)
    if (!cacheDisabled) principalCache.set(pcb.pid, principal)
    return principal
  }

  /**
   * Drop a pid from the side-map cache. Called by the `process.exited`
   * Bus subscriber. Idempotent.
   */
  export function evictPrincipal(pid: string): void {
    principalCache.delete(pid)
  }

  // ── Cap checks (per scheduler-quota.md §Dispatch flow) ───────────────

  export type PrincipalCheck =
    | { ok: true; entry: PrincipalEntry; throttled: false }
    | { ok: true; entry: PrincipalEntry; throttled: true; soft_at: number }
    | { ok: false; entry: PrincipalEntry; reason: "capped"; tokens_used: number; tokens_quota: number }

  /**
   * Inspect a principal's quota state without mutating disk. Returns the
   * scheduler-relevant decision triple per scheduler-quota.md §Dispatch
   * flow steps 3-4:
   *
   *   tokens_used >= tokens_quota         → ok=false, reason=capped
   *   tokens_used >= tokens_soft_throttle → ok=true, throttled=true
   *   else                                → ok=true, throttled=false
   *
   * `null` caps are sentinels meaning "feature off" (no cap, no throttle).
   * Per ADR §Reversibility — Stage-10 logic collapses to no-op when caps
   * are null, preserving Stage-2 behaviour.
   */
  export function principalCheck(entry: PrincipalEntry): PrincipalCheck {
    if (entry.tokens_quota !== null && entry.tokens_used >= entry.tokens_quota) {
      return {
        ok: false,
        entry,
        reason: "capped",
        tokens_used: entry.tokens_used,
        tokens_quota: entry.tokens_quota,
      }
    }
    if (entry.tokens_soft_throttle_at !== null && entry.tokens_used >= entry.tokens_soft_throttle_at) {
      return {
        ok: true,
        entry,
        throttled: true,
        soft_at: entry.tokens_soft_throttle_at,
      }
    }
    return { ok: true, entry, throttled: false }
  }

  // ── Fair-share helpers (per scheduler-quota.md §Fair-share flow) ─────

  /**
   * Update `last_serviced_at` to NOW for the principals from whom the
   * scheduler drew candidates in the just-returned batch. Drives
   * oldest-first round-robin.
   */
  export async function markServiced(session_ids: ReadonlyArray<string>): Promise<void> {
    if (session_ids.length === 0) return
    const state = await read()
    const now = new Date().toISOString()
    const principals = { ...state.principals }
    let changed = false
    for (const sid of session_ids) {
      const cur = principals[sid]
      if (!cur) continue
      principals[sid] = { ...cur, last_serviced_at: now, updated_at: now }
      changed = true
    }
    if (!changed) return
    await write({ ...state, principals })
  }

  // ── Child-pid maintenance (per quota-state.md §Field schema) ─────────

  /**
   * Add a pid to a principal's `child_pids` set. Idempotent. Used by the
   * spawn hook (I10.3) to track active PCBs per principal for the
   * preemption sweep's targeting decision.
   */
  export async function addChildPid(session_id: string, pid: string): Promise<void> {
    const state = await read()
    const cur = state.principals[session_id]
    if (!cur) {
      // Lazily create the principal first.
      await ensurePrincipal(session_id)
      return addChildPid(session_id, pid)
    }
    if (cur.child_pids.includes(pid)) return // idempotent
    const next_entry: PrincipalEntry = {
      ...cur,
      child_pids: [...cur.child_pids, pid],
      updated_at: new Date().toISOString(),
    }
    await write({ ...state, principals: { ...state.principals, [session_id]: next_entry } })
  }

  /**
   * Remove a pid from a principal's `child_pids`. Called on PCB reap
   * (per quota-state.md §Crash recovery — child_pids pruned against
   * live PCB set after `ProcessRegistry.reload()`).
   */
  export async function removeChildPid(session_id: string, pid: string): Promise<void> {
    const state = await read()
    const cur = state.principals[session_id]
    if (!cur) return
    if (!cur.child_pids.includes(pid)) return // idempotent
    const next_entry: PrincipalEntry = {
      ...cur,
      child_pids: cur.child_pids.filter((p) => p !== pid),
      updated_at: new Date().toISOString(),
    }
    await write({ ...state, principals: { ...state.principals, [session_id]: next_entry } })
  }

  /**
   * Prune `child_pids` across all principals against the live PCB set.
   * Called on engine boot after `ProcessRegistry.reload()` (per
   * quota-state.md §Crash recovery).
   */
  export async function pruneStaleChildPids(): Promise<void> {
    const state = await read()
    const live = new Set(ProcessRegistry.list().map((p) => p.pid))
    const principals = { ...state.principals }
    let changed = false
    for (const [sid, entry] of Object.entries(principals)) {
      if (sid === ENGINE_PRINCIPAL_ID) continue
      const filtered = entry.child_pids.filter((p) => live.has(p))
      if (filtered.length === entry.child_pids.length) continue
      principals[sid] = {
        ...entry,
        child_pids: filtered,
        updated_at: new Date().toISOString(),
      }
      changed = true
    }
    if (!changed) return
    await write({ ...state, principals })
  }

  // ── Bus subscription (Stage 10 / I10.3 — eager cache population) ───

  /**
   * Track active disposers so `subscribe()` is idempotent. Re-subscribing
   * after a disposer ran is safe and recreates the listeners.
   */
  let busDisposers: Array<() => void> | null = null

  /**
   * Subscribe to ProcessEvent.{Spawned,Exited} so the side-map cache and
   * `child_pids` set stay aligned with the live PCB population.
   *
   *   • on `process.spawned` → `cachePrincipal(pcb)` + `addChildPid(principal, pid)`
   *   • on `process.exited`  → `evictPrincipal(pid)` + `removeChildPid(principal, pid)`
   *
   * Idempotent: a second call before `dispose()` is a no-op (returns the
   * same disposer). Bus-not-bootstrapped is downgraded to silent skip
   * (test contexts where the Effect runtime isn't wired) — same pattern
   * as `ProcessRegistry.publishProcessEvent`.
   *
   * The `child_pids` write hits disk via `addChildPid`; failures are
   * logged but never thrown — the Bus subscriber contract is
   * fire-and-forget per Stage 8 §Idempotency.
   */
  export function subscribe(): { dispose(): void } {
    if (busDisposers) {
      return { dispose: () => disposeAllListeners() }
    }
    const disposers: Array<() => void> = []
    try {
      const u1 = Bus.subscribe(ProcessEvent.Spawned, async (ev) => {
        const pcb = ev.properties.pcb
        try {
          const principal = cachePrincipal(pcb)
          await addChildPid(principal, pcb.pid)
        } catch (err) {
          log.warn("subscribe.spawned.handler.failed", {
            pid: pcb.pid,
            err: err instanceof Error ? err.message : String(err),
          })
        }
      })
      const u2 = Bus.subscribe(ProcessEvent.Exited, async (ev) => {
        const pid = ev.properties.pid
        const session_id = ev.properties.key.session_id
        // Resolve principal for child_pids cleanup. The pid is already
        // in zombie/reaped territory by the time we see Exited, so the
        // cache (if populated) is our best source. Fall back to the
        // event's session_id (= pcb.session_id, NOT necessarily the
        // attributed principal). Prefer cache.
        const principal = principalCache.get(pid) ?? session_id
        evictPrincipal(pid)
        try {
          await removeChildPid(principal, pid)
        } catch (err) {
          log.warn("subscribe.exited.handler.failed", {
            pid,
            err: err instanceof Error ? err.message : String(err),
          })
        }
      })
      disposers.push(typeof u1 === "function" ? u1 : () => {})
      disposers.push(typeof u2 === "function" ? u2 : () => {})
    } catch (err) {
      if (RegistryEvent.isBusNotBootstrapped(err)) {
        // Bus not wired (likely a test context). Subscription silently
        // skipped — caller still gets a valid disposer that no-ops.
        busDisposers = []
        return { dispose: () => disposeAllListeners() }
      }
      throw err
    }
    busDisposers = disposers
    return { dispose: () => disposeAllListeners() }
  }

  function disposeAllListeners(): void {
    if (!busDisposers) return
    for (const d of busDisposers) {
      try {
        d()
      } catch {
        // best-effort
      }
    }
    busDisposers = null
  }

  // ── Test seam ────────────────────────────────────────────────────────

  /**
   * @internal — clear quota.json on disk. Sibling tests mirror the
   * `_resetForTest` pattern in `Policy._resetForTest` and
   * `ProcessRegistry._resetForTest`. Real callers MUST NOT use this.
   */
  export async function _resetForTest(): Promise<void> {
    const p = statePath()
    if (existsSync(p)) {
      try {
        await fs.unlink(p)
      } catch {
        // best-effort
      }
    }
    principalCache.clear()
    cacheDisabled = false
    disposeAllListeners()
  }

  /** @internal — toggle cache for parity tests. */
  export function _setCacheDisabledForTest(disabled: boolean): void {
    cacheDisabled = disabled
    if (disabled) principalCache.clear()
  }

  /** @internal — inspect cache size for tests. */
  export function _cacheSizeForTest(): number {
    return principalCache.size
  }
}
