// session/token-budget.ts
//
// Per-session token-budget tracker (Phase 1c of the token-efficiency overhaul).
// Mirrors instructkr-claude-code/src/query/tokenBudget.ts. The tracker watches
// turn-level token deltas and tells the prompt loop when to stop iterating —
// either because the per-task budget is exhausted, or because the agent has
// fallen into a diminishing-returns loop (multiple consecutive steps producing
// almost no new content).
//
// Diminishing-returns detection is the headline reason this module exists. A
// runaway agent loop with token-rich tool results but tiny model outputs is
// invisible to plain budget tracking — the tokens are spent but no new work
// happens. The tracker catches this by comparing successive deltas and bailing
// once `continuationCount >= 3 && deltaTokens < 500 && lastDeltaTokens < 500`.
//
// Subagent sessions skip the tracker entirely: the parent session owns the
// budget so a child running on its own would double-count.

import type { BudgetEntry } from "@/tool/task/port"

export namespace TokenBudget {
  // Same constants as the reference impl. The 0.9 completion threshold gives
  // the agent room to wrap up a final tool call before the loop forces a
  // stop. The 500-token diminishing threshold is "smaller than a single
  // average tool result" — anything below that means the agent isn't
  // producing meaningful new content.
  export const COMPLETION_THRESHOLD = 0.9
  export const DIMINISHING_THRESHOLD = 500
  // Number of consecutive small-delta steps that flips the diminishing-returns
  // flag. <3 is too jumpy (a single small step can be a tool-only round); >3
  // wastes budget on a clearly-stuck agent.
  export const DIMINISHING_RUN_LENGTH = 3

  export type BudgetTracker = {
    continuationCount: number
    lastDeltaTokens: number
    lastGlobalTurnTokens: number
    startedAt: number
  }

  export function create(): BudgetTracker {
    return {
      continuationCount: 0,
      lastDeltaTokens: 0,
      lastGlobalTurnTokens: 0,
      startedAt: Date.now(),
    }
  }

  export type ContinueDecision = {
    action: "continue"
    nudgeMessage: string
    continuationCount: number
    pct: number
    turnTokens: number
    budget: number
  }

  export type StopDecision = {
    action: "stop"
    reason: "no-budget" | "budget-exhausted" | "diminishing-returns"
    completionEvent: {
      continuationCount: number
      pct: number
      turnTokens: number
      budget: number
      diminishingReturns: boolean
      durationMs: number
    } | null
  }

  export type Decision = ContinueDecision | StopDecision

  /**
   * Decide whether the loop should continue or stop based on the current
   * turn-token count and the configured budget.
   *
   * @param tracker         Mutable tracker state — updated in place when the
   *                        decision is "continue".
   * @param isSubagent      True for child sessions; tracker is bypassed and
   *                        "stop" is returned with reason="no-budget" so the
   *                        caller falls back to its existing termination logic.
   * @param budget          Hard cap in tokens, or null when no budget is set.
   * @param globalTurnTokens Cumulative tokens consumed in the current turn so
   *                        far (input + output + reasoning across all assistant
   *                        messages spawned by the current user message).
   */
  export function check(
    tracker: BudgetTracker,
    isSubagent: boolean,
    budget: number | null,
    globalTurnTokens: number,
  ): Decision {
    if (isSubagent || budget === null || budget <= 0) {
      return { action: "stop", reason: "no-budget", completionEvent: null }
    }

    const turnTokens = globalTurnTokens
    const pct = Math.round((turnTokens / budget) * 100)
    const deltaSinceLastCheck = globalTurnTokens - tracker.lastGlobalTurnTokens

    const isDiminishing =
      tracker.continuationCount >= DIMINISHING_RUN_LENGTH &&
      deltaSinceLastCheck < DIMINISHING_THRESHOLD &&
      tracker.lastDeltaTokens < DIMINISHING_THRESHOLD

    if (!isDiminishing && turnTokens < budget * COMPLETION_THRESHOLD) {
      tracker.continuationCount++
      tracker.lastDeltaTokens = deltaSinceLastCheck
      tracker.lastGlobalTurnTokens = globalTurnTokens
      return {
        action: "continue",
        nudgeMessage: continuationMessage(pct, turnTokens, budget),
        continuationCount: tracker.continuationCount,
        pct,
        turnTokens,
        budget,
      }
    }

    if (isDiminishing || tracker.continuationCount > 0) {
      return {
        action: "stop",
        reason: isDiminishing ? "diminishing-returns" : "budget-exhausted",
        completionEvent: {
          continuationCount: tracker.continuationCount,
          pct,
          turnTokens,
          budget,
          diminishingReturns: isDiminishing,
          durationMs: Date.now() - tracker.startedAt,
        },
      }
    }

    return { action: "stop", reason: "budget-exhausted", completionEvent: null }
  }

  /**
   * Build the budget-warning string we inject as a synthetic system reminder
   * when the loop continues. Mirrors the reference impl's
   * `getBudgetContinuationMessage` shape: short, factual, and actionable.
   */
  export function continuationMessage(pct: number, turnTokens: number, budget: number): string {
    return [
      `<budget-status>`,
      `Token budget: ${turnTokens.toLocaleString()} / ${budget.toLocaleString()} (${pct}%).`,
      pct >= 75
        ? `You are approaching the budget cap. Wrap up the current step and prefer concise actions.`
        : `Continue with the next step.`,
      `</budget-status>`,
    ].join("\n")
  }

  /**
   * Convenience: pull the active budget cap (hard preferred, soft as fallback)
   * out of a BudgetEntry. Returns null when no cap is set so callers can skip
   * the tracker entirely.
   */
  export function capFromEntry(entry: BudgetEntry | undefined): number | null {
    if (!entry) return null
    return entry.tokens_hard ?? entry.tokens_soft ?? null
  }
}
