// provider/cache-break-detector.ts
//
// Slim port of Claude Code's promptCacheBreakDetection.ts (727 LOC).
// This is the observability layer for opencode's prompt caching: it
// captures per-turn cache snapshots and detects sharp drops in
// cache-hit ratio, attributing each break to a specific cause.
//
// PROVENANCE: design intent ported from
// `instructkr-claude-code/src/services/api/promptCacheBreakDetection.ts`.
// The reference is 727 LOC of detailed per-tool schema diffing,
// pendingChanges tracking, and Anthropic-internal telemetry plumbing.
// The opencode port is intentionally slim (~150 LOC) — opencode doesn't
// have GrowthBook flags, beta header drift, or per-tool schema diffing
// (yet), so the slim version covers the 4 most common break causes
// with the simplest possible state shape.
//
// THE PROBLEM
// ===========
// For direct Anthropic, opencode sees `cache_read_input_tokens` in the
// usage block and can verify caching is working. For qpilot/qgenie
// (server-side proxies), opencode reads the OpenAI-compatible
// `usage.cachedTokens` field instead — but the question is the same:
// "is the cache_ratio staying high turn-to-turn, or is it crashing?"
//
// Without observability, opencode users can't tell whether:
//   - Their prompt is drifting bytes (system, tools)
//   - The proxy is misconfigured server-side
//   - The model changed mid-session
//   - Something else
//
// THE FIX
// =======
// `record(snapshot)` captures one turn's cache stats + content hashes.
// On the SECOND and subsequent records for the same session, it diffs
// the previous snapshot against the current one. If `cachedRatio` drops
// by more than the break threshold (default 40 percentage points), it
// returns a `BreakAnalysis` naming the most likely cause:
//
//   - "first_turn"      → no previous turn to compare (always returned for turn 1)
//   - "model_change"    → modelID or providerID changed mid-session
//   - "system_drift"    → systemHash changed since last turn
//   - "tools_drift"     → toolsHash changed since last turn
//   - "provider_break"  → none of the above; the proxy/upstream lost the cache
//                         for unknown reasons (deployment / TTL / rate limit)
//   - "no_break"        → cachedRatio held steady or improved; no analysis needed
//
// The caller (typically session/llm.ts after streamText completes)
// passes the snapshot in fire-and-forget; the result is logged + can
// be inspected via `getHistory(sessionID)` for the debug command path.
//
// USAGE
// =====
//
//   const snapshot: TurnSnapshot = {
//     sessionID,
//     turnNumber,
//     timestamp: Date.now(),
//     inputTokens: usage.inputTokens,
//     cachedTokens: usage.cachedTokens ?? 0,
//     cachedRatio: usage.cachedTokens / usage.inputTokens,
//     systemHash: Hash.djb2(systemPromptText),
//     toolsHash: Hash.djb2(JSON.stringify(canonicalTools)),
//     modelID: model.id,
//     providerID: model.providerID,
//   }
//   const analysis = CacheBreakDetector.record(snapshot)
//   if (analysis && analysis.cause !== "no_break" && analysis.cause !== "first_turn") {
//     log.warn("cache break detected", analysis)
//   }
//
// STATE BOUND
// ===========
// Per-session history is bounded to MAX_HISTORY_PER_SESSION (default 20)
// turns. When the bound is exceeded, the oldest snapshot is dropped.
// This caps memory growth at ~3 KB per session for any practical workload.

import { Log } from "@/foundation/util/log"

export namespace CacheBreakDetector {
  const log = Log.create({ service: "provider.cache-break-detector" })

  /** Snapshot of one turn's cache state + content hashes. */
  export type TurnSnapshot = {
    sessionID: string
    turnNumber: number
    timestamp: number
    inputTokens: number
    cachedTokens: number
    /** cachedTokens / inputTokens, clamped to [0, 1]. NaN-safe (0 if inputTokens === 0). */
    cachedRatio: number
    /** Hash of the system prompt text. djb2 (or any deterministic hash). */
    systemHash: string
    /** Hash of the canonicalized tools array. */
    toolsHash: string
    modelID: string
    providerID: string
  }

  /**
   * Why the cache_read ratio dropped between two turns. Mutually exclusive —
   * the detector picks the highest-priority cause first (model_change >
   * system_drift > tools_drift > provider_break).
   */
  export type BreakCause =
    | "first_turn" // no previous turn — always returned for turn 1
    | "model_change" // modelID or providerID changed mid-session
    | "system_drift" // system prompt bytes changed
    | "tools_drift" // tools array bytes changed
    | "provider_break" // none of the above; proxy/upstream lost the cache
    | "no_break" // cachedRatio held steady or improved

  export type BreakAnalysis = {
    sessionID: string
    cause: BreakCause
    prevCachedRatio: number
    currCachedRatio: number
    /** percentage points dropped (e.g. 0.45 means cache_ratio fell 45 pp) */
    drop: number
    details: {
      modelChanged: boolean
      systemChanged: boolean
      toolsChanged: boolean
      prevTurn?: number
      currTurn: number
    }
  }

  // Tunable: drops smaller than this threshold are NOT classified as breaks.
  // 0.40 means we tolerate up to a 40-percentage-point drop before flagging
  // (e.g. 0.95 → 0.55 is not a break, but 0.95 → 0.30 is).
  export const BREAK_THRESHOLD = 0.4

  // Bounded per-session history.
  export const MAX_HISTORY_PER_SESSION = 20

  // Module-level state. Map<sessionID, snapshot[]>.
  const history = new Map<string, TurnSnapshot[]>()

  /**
   * Record a turn snapshot + return a break analysis vs the previous
   * turn for the same sessionID. Returns null if turnNumber < 1 or
   * if the snapshot has invalid input tokens.
   */
  export function record(snapshot: TurnSnapshot): BreakAnalysis | null {
    if (snapshot.turnNumber < 1) return null

    // Sanity-clamp the cached ratio in case the caller didn't normalize.
    const safeRatio = Number.isFinite(snapshot.cachedRatio) ? Math.max(0, Math.min(1, snapshot.cachedRatio)) : 0
    const normalized: TurnSnapshot = { ...snapshot, cachedRatio: safeRatio }

    const turns = history.get(snapshot.sessionID) ?? []
    const prev = turns[turns.length - 1]

    // Append + bound.
    turns.push(normalized)
    if (turns.length > MAX_HISTORY_PER_SESSION) turns.shift()
    history.set(snapshot.sessionID, turns)

    // First turn — no comparison possible.
    if (!prev) {
      const analysis: BreakAnalysis = {
        sessionID: snapshot.sessionID,
        cause: "first_turn",
        prevCachedRatio: 0,
        currCachedRatio: safeRatio,
        drop: 0,
        details: {
          modelChanged: false,
          systemChanged: false,
          toolsChanged: false,
          currTurn: snapshot.turnNumber,
        },
      }
      return analysis
    }

    // Compute drop. drop > 0 means the ratio FELL.
    const drop = prev.cachedRatio - safeRatio

    const modelChanged = prev.modelID !== snapshot.modelID || prev.providerID !== snapshot.providerID
    const systemChanged = prev.systemHash !== snapshot.systemHash
    const toolsChanged = prev.toolsHash !== snapshot.toolsHash

    // Below threshold → no break.
    if (drop < BREAK_THRESHOLD) {
      return {
        sessionID: snapshot.sessionID,
        cause: "no_break",
        prevCachedRatio: prev.cachedRatio,
        currCachedRatio: safeRatio,
        drop,
        details: {
          modelChanged,
          systemChanged,
          toolsChanged,
          prevTurn: prev.turnNumber,
          currTurn: snapshot.turnNumber,
        },
      }
    }

    // Pick the highest-priority cause. Priority order:
    //   model_change > system_drift > tools_drift > provider_break
    let cause: BreakCause = "provider_break"
    if (modelChanged) cause = "model_change"
    else if (systemChanged) cause = "system_drift"
    else if (toolsChanged) cause = "tools_drift"

    const analysis: BreakAnalysis = {
      sessionID: snapshot.sessionID,
      cause,
      prevCachedRatio: prev.cachedRatio,
      currCachedRatio: safeRatio,
      drop,
      details: { modelChanged, systemChanged, toolsChanged, prevTurn: prev.turnNumber, currTurn: snapshot.turnNumber },
    }

    log.warn("cache break detected", {
      sessionID: snapshot.sessionID,
      cause,
      drop: Math.round(drop * 100) / 100,
      prev: prev.cachedRatio,
      curr: safeRatio,
    })

    return analysis
  }

  /** Read-only view of the bounded history for a session. */
  export function getHistory(sessionID: string): readonly TurnSnapshot[] {
    return history.get(sessionID) ?? []
  }

  /**
   * Run record-style analysis over the FULL recorded history of a session.
   * Useful for debug commands that want to surface every break that
   * happened, not just the latest one.
   */
  export function analyze(sessionID: string): BreakAnalysis[] {
    const turns = history.get(sessionID) ?? []
    if (turns.length === 0) return []
    const out: BreakAnalysis[] = []
    for (let i = 0; i < turns.length; i++) {
      const curr = turns[i]
      const prev = i > 0 ? turns[i - 1] : undefined
      if (!prev) {
        out.push({
          sessionID: curr.sessionID,
          cause: "first_turn",
          prevCachedRatio: 0,
          currCachedRatio: curr.cachedRatio,
          drop: 0,
          details: { modelChanged: false, systemChanged: false, toolsChanged: false, currTurn: curr.turnNumber },
        })
        continue
      }
      const drop = prev.cachedRatio - curr.cachedRatio
      const modelChanged = prev.modelID !== curr.modelID || prev.providerID !== curr.providerID
      const systemChanged = prev.systemHash !== curr.systemHash
      const toolsChanged = prev.toolsHash !== curr.toolsHash
      let cause: BreakCause = "no_break"
      if (drop >= BREAK_THRESHOLD) {
        cause = "provider_break"
        if (modelChanged) cause = "model_change"
        else if (systemChanged) cause = "system_drift"
        else if (toolsChanged) cause = "tools_drift"
      }
      out.push({
        sessionID: curr.sessionID,
        cause,
        prevCachedRatio: prev.cachedRatio,
        currCachedRatio: curr.cachedRatio,
        drop,
        details: { modelChanged, systemChanged, toolsChanged, prevTurn: prev.turnNumber, currTurn: curr.turnNumber },
      })
    }
    return out
  }

  /**
   * Test escape hatch: clear all history. With no arg, wipes everything.
   * With a sessionID, only clears that session's history.
   */
  export function reset(sessionID?: string): void {
    if (sessionID) history.delete(sessionID)
    else history.clear()
  }

  /** Inspector for tests + debug commands. */
  export function state(): { sessions: number; totalSnapshots: number } {
    let total = 0
    for (const turns of history.values()) total += turns.length
    return { sessions: history.size, totalSnapshots: total }
  }
}
