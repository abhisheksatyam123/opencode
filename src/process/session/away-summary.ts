// session/away-summary.ts
//
// Generates a short "while you were away" recap when a user resumes a
// long-idle session. The recap is 1-3 short sentences naming the
// high-level task and the concrete next step — designed for the TUI
// "welcome back" card or the CLI session-list view.
//
// PROVENANCE: ported from
// `instructkr-claude-code/src/services/awaySummary.ts` (74 LOC). The
// reference takes Claude Code's `Message[]` shape and calls
// `queryModelWithoutStreaming` against the small/fast model. Opencode's
// adaptation:
//
//   - Takes `MessageV2.WithParts[]` (opencode's message shape) instead
//     of Claude's `Message[]`
//   - Uses `ForkedAgent.run` (opencode's one-shot non-tool agent
//     primitive) instead of the reference's queryModelWithoutStreaming
//   - Takes `currentMemory: string | null` explicitly so the caller
//     decides where the memory comes from (notes vault read, in-memory
//     cache, etc.) — the reference auto-fetches via
//     `getSessionMemoryContent()` which assumes a singleton store
//   - Truncates messages to the last 30 (same constant as the reference)
//     to keep the prompt small enough to fit in the small/fast model's
//     context
//   - Returns null on abort, empty input, or any error — never throws
//

import type { ModelMessage } from "ai"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { MessageV2 } from "@/process/session/message-v2"
import { ForkedAgent } from "@/process/session/forked-agent"
import { Log } from "@/foundation/util/log"

export namespace AwaySummary {
  const log = Log.create({ service: "session.away-summary" })

  // Recap only needs recent context — truncate to avoid "prompt too long"
  // on large sessions. 30 messages ≈ ~15 exchanges, plenty for "where
  // we left off." Same constant as the reference impl.
  export const RECENT_MESSAGE_WINDOW = 30

  // Default wall-clock cap. The recap is short — 30 seconds is generous.
  // Reference has no cap; we add one so a stuck call never wedges the
  // resume flow.
  const DEFAULT_TIMEOUT_MS = 30_000

  /**
   * Build the recap prompt. Exposed for testing.
   *
   * The instructions are intentionally curt: the model should produce
   * 1-3 short sentences naming the task and the next step. Status
   * reports and commit recaps are explicitly excluded so we don't
   * waste tokens on summary-of-summary content.
   */
  export function buildPrompt(memory: string | null): string {
    const memoryBlock = memory ? `Context:\n${memory}\n\n` : ""
    return (
      `${memoryBlock}The user stepped away and is coming back. Write exactly 1-3 short sentences. ` +
      `Start by stating the high-level task — what they are building or debugging, not implementation details. ` +
      `Next: the concrete next step. Skip status reports and commit recaps.`
    )
  }

  export type GenerateInput = {
    /** Conversation to feed in. The function truncates to the last RECENT_MESSAGE_WINDOW messages. */
    messages: MessageV2.WithParts[]
    /** Model to use. Should be a small/fast model — recap is short. */
    model: Provider.Model
    /** Agent definition (for forked-agent permission/system prompt inheritance). */
    agent: Agent.Info
    /** Session ID for log correlation. */
    sessionID: string
    /**
     * Optional broader context. When present it is prefixed to the recap prompt.
     */
    currentMemory?: string | null
    /** Wall-clock cap. Default 30 seconds. */
    timeoutMs?: number
    /** Caller abort signal — typically the parent session's abort. */
    parentAbort?: AbortSignal
  }

  /**
   * Generate a short session recap for the "while you were away" card.
   * Returns null on:
   *   - empty input (no messages)
   *   - abort (timeout or parentAbort fired)
   *   - any error (logged, swallowed — recap is best-effort)
   *
   * The function NEVER throws. Callers can safely render its return
   * value as text without try/catch.
   */
  export async function generate(input: GenerateInput): Promise<string | null> {
    if (input.messages.length === 0) {
      return null
    }

    try {
      // Truncate to recent window. The slice happens BEFORE the model
      // conversion so we don't pay the conversion cost for messages
      // that won't be used.
      const recent = input.messages.slice(-RECENT_MESSAGE_WINDOW)
      const modelMessages: ModelMessage[] = await MessageV2.toModelMessages(recent, input.model, {
        stripMedia: true,
      })

      const result = await ForkedAgent.run({
        model: input.model,
        agent: input.agent,
        parentSessionID: input.sessionID,
        label: "away-summary",
        // Empty system — let the agent's default system prompt apply.
        // The recap prompt does all the work.
        system: [],
        messages: modelMessages,
        prompt: buildPrompt(input.currentMemory ?? null),
        tools: {},
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        parentAbort: input.parentAbort,
      })

      if (result.aborted) {
        log.info("away-summary aborted", { sessionID: input.sessionID, durationMs: result.durationMs })
        return null
      }

      const text = result.text.trim()
      if (text.length === 0) {
        log.warn("away-summary produced empty text", { sessionID: input.sessionID })
        return null
      }

      log.info("away-summary generated", {
        sessionID: input.sessionID,
        textLength: text.length,
        durationMs: result.durationMs,
      })

      return text
    } catch (err) {
      log.error("away-summary generation failed", {
        sessionID: input.sessionID,
        err: (err as Error)?.message,
      })
      return null
    }
  }
}
