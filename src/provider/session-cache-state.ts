// provider/session-cache-state.ts
//
// Per-session latched cache eligibility decisions (parity Fix 2 / gap-14
// adjacent — the "latched session cache state" half of Claude Code's
// setPromptCache1hEligible discipline).
//
// PROVENANCE: pattern ported from
// `instructkr-claude-code/src/bootstrap/state.ts:1700-1706` +
// `src/services/api/claude.ts:393-434` (`should1hCacheTTL`). Claude Code
// uses a process-global `STATE.promptCache1hEligible: boolean | null`
// that is computed ONCE on first cache decision and stuck for the
// process lifetime — flipping mid-process would change the cache_control
// TTL, which busts the server-side prompt cache (~20K tokens per flip).
//
// opencode generalizes the same pattern to per-session: many concurrent
// sessions may run in one opencode process, each potentially against a
// different model/provider, so the latch lives at the SESSION level
// rather than the process level. This still gives the "compute once,
// reuse for the session lifetime" guarantee that makes the cache stable.
//
// THE PROBLEM
// ===========
// `provider/transform.ts:applyCaching` (and the upstream `options()`
// helper that emits `prompt_cache_key` for OpenAI-compatible providers)
// makes several decisions every turn:
//   - Should this provider get cache markers at all?
//   - What TTL? (5m default vs 1h for stable system prefixes)
//   - What cache key string?
//
// Today these are recomputed from scratch on every turn. If anything
// the decision depends on flips mid-session — env var changes, model
// changes (rare but possible), proxy upstream rotation, time-of-day
// rate-limit overage flags — the wire body's cache_control bytes
// CHANGE on the next turn, and the server-side prompt cache misses on
// the recomputed prefix. That's a multi-thousand-token regression for
// every flip.
//
// THE FIX
// =======
// `SessionCacheState.get(sessionID, compute)` runs `compute()` exactly
// once per session, caches the result in a Map, and returns the cached
// result on every subsequent call for the same session. The decision
// is locked in for the session lifetime regardless of what the
// underlying inputs do mid-session.
//
// USAGE PATTERN
// =============
// ```ts
// const decision = SessionCacheState.get(sessionID, () => ({
//   ttl: shouldUse1hTtl(model) ? "1h" : "5m",
//   cacheKeyPrefix: deriveCacheKeyPrefix(sessionID, model),
//   markersEnabled: !CacheFlags.isDisabled(model),
// }))
// ```
//
// On turn 1, `compute()` runs and the decision is captured. On turns
// 2..N, the cached decision is returned — even if `CacheFlags.isDisabled`
// or `shouldUse1hTtl` would now return a different value, the session
// uses the originally-latched decision.
//
// MEMORY BOUNDS
// =============
// The map is bounded by `MAX_SESSIONS` (default 256). When exceeded,
// the OLDEST entry (insertion-ordered, FIFO) is dropped. Each cached
// decision is small (~100 bytes for typical shapes), so 256 sessions
// caps memory at ~25 KB even in pathological multi-session test runs.
// Sessions older than the cap simply recompute on next access — same
// behavior as the very first call, which is safe by design.
//
// THIS IS NOT
// ===========
// Not a generic memoizer. The single-session, single-decision shape is
// deliberate. If you need to cache multiple INDEPENDENT decisions per
// session, call `get(sessionID, compute)` from each call site with
// different `compute` closures — each closure's decision is the
// CALLER'S responsibility to keep distinct (e.g. by passing different
// keys via the `kind` parameter below).

import { Log } from "@/foundation/util/log"

const log = Log.create({ service: "session-cache-state" })

export namespace SessionCacheState {
  /**
   * Maximum number of sessions to keep latched decisions for. Once
   * exceeded, the oldest session's decisions are dropped (insertion-
   * ordered FIFO eviction).
   *
   * The default is generous: opencode rarely runs more than a few
   * dozen concurrent sessions in one process. Caps memory growth on
   * pathological test runs that spawn thousands of sessions.
   */
  export const MAX_SESSIONS = 256

  /**
   * Inner map per session: kind → decision. Allows ONE session to latch
   * multiple INDEPENDENT decisions (e.g. "ttl" + "markers" + "key")
   * each with their own compute closure, without collisions.
   */
  type SessionMap = Map<string, unknown>

  /**
   * Outer map: sessionID → inner map. Insertion-ordered (Map iteration
   * order is insertion order in JavaScript) so FIFO eviction is trivial.
   */
  const sessions = new Map<string, SessionMap>()

  /**
   * Latch a decision for a session under a specific kind.
   *
   * On the FIRST call for a given (sessionID, kind) pair, runs
   * `compute()` and stores the result. On every subsequent call for
   * the same (sessionID, kind), returns the cached result without
   * invoking `compute()`.
   *
   * The result type T is inferred from the compute closure's return
   * type. The cache stores the value as `unknown` internally and casts
   * back on read — this is safe because the SAME compute closure (or
   * a closure returning the same type) should always be passed for
   * the same (sessionID, kind) pair. Mixing types under one kind is a
   * caller bug; the cast is intentionally unchecked.
   *
   * @param sessionID The session id this decision belongs to.
   * @param kind A string discriminator for the decision (e.g. "ttl",
   *             "cacheKey", "markers"). Lets one session latch multiple
   *             independent decisions.
   * @param compute A pure function returning the decision. Called at
   *                most once per (sessionID, kind) pair.
   * @returns The latched decision.
   */
  export function get<T>(sessionID: string, kind: string, compute: () => T): T {
    if (!sessionID) {
      // No sessionID → no latching (each call recomputes). This
      // matches the safest fallback: caller gets a fresh decision
      // every time, no memory consumed, no surprising behavior.
      return compute()
    }
    let sessionMap = sessions.get(sessionID)
    if (sessionMap === undefined) {
      // Enforce MAX_SESSIONS cap before inserting a new session.
      // Eviction is FIFO on insertion order: drop the oldest entry.
      if (sessions.size >= MAX_SESSIONS) {
        const oldest = sessions.keys().next().value
        if (oldest !== undefined) {
          sessions.delete(oldest)
          log.info("evicted oldest session for cap", {
            evicted: oldest,
            cap: MAX_SESSIONS,
          })
        }
      }
      sessionMap = new Map()
      sessions.set(sessionID, sessionMap)
    }
    if (sessionMap.has(kind)) {
      return sessionMap.get(kind) as T
    }
    const value = compute()
    sessionMap.set(kind, value)
    return value
  }

  /**
   * Look up a previously-latched decision without latching a new one.
   * Returns undefined if not yet latched.
   *
   * Useful for diagnostics + the debug command path; production code
   * should always go through `get(sessionID, kind, compute)`.
   */
  export function peek<T>(sessionID: string, kind: string): T | undefined {
    const sessionMap = sessions.get(sessionID)
    if (sessionMap === undefined) return undefined
    return sessionMap.get(kind) as T | undefined
  }

  /**
   * Clear latched decisions for ONE session (when sessionID is given)
   * or for ALL sessions (when called with no args).
   *
   * Used by:
   *   - Test isolation (afterEach in unit tests)
   *   - Session cleanup paths (session ended → drop the latch)
   *   - The `opencode debug clear-cache-state` debug command
   */
  export function clear(sessionID?: string): void {
    if (sessionID === undefined) {
      sessions.clear()
      return
    }
    sessions.delete(sessionID)
  }

  /**
   * Inspect the current latched-state map. Read-only snapshot for
   * tests + debug commands. Returns counts only — the cached values
   * themselves are not exposed (caller-specific shapes).
   */
  export function state(): {
    sessionCount: number
    totalDecisions: number
    sessionIDs: readonly string[]
  } {
    let totalDecisions = 0
    for (const sessionMap of sessions.values()) {
      totalDecisions += sessionMap.size
    }
    return {
      sessionCount: sessions.size,
      totalDecisions,
      sessionIDs: Array.from(sessions.keys()),
    }
  }

  /**
   * List the kinds of decisions latched for a single session.
   * Empty array if the session has nothing latched.
   *
   * Useful for the debug command + cache-state inspector tests.
   */
  export function kinds(sessionID: string): readonly string[] {
    const sessionMap = sessions.get(sessionID)
    if (sessionMap === undefined) return []
    return Array.from(sessionMap.keys())
  }
}
