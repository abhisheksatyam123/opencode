// session/tool-use-summary.ts
//
// Generates a short, git-commit-subject-style label describing what
// a batch of completed tool calls accomplished. The label is designed
// to fit on one line in a sidebar/notification (~30 chars) and uses
// past-tense verbs.
//
// Examples (from the reference impl):
//   - "Searched in auth/"
//   - "Fixed NPE in UserService"
//   - "Created signup endpoint"
//   - "Read config.json"
//   - "Ran failing tests"
//
// PROVENANCE: ported from
// `instructkr-claude-code/src/services/toolUseSummary/toolUseSummaryGenerator.ts`
// (~112 LOC). The reference uses Claude Code's `queryHaiku` against
// the small/fast model with prompt caching enabled.
//
// OPENCODE ADAPTATION:
//
//   - Takes a simple {name, input, output} array so callers can
//     build it from any source (MessageV2.ToolPart, batch tool result,
//     subagent output, etc.) — the reference uses Claude Code's
//     internal ToolInfo type
//   - Uses ForkedAgent.run instead of queryHaiku (opencode's
//     equivalent for one-shot non-tool LLM calls)
//   - System prompt + user prompt builder both exposed for testing
//     (the reference inlines them as constants)
//   - Returns null on empty input, abort, or any error — never throws

import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { ForkedAgent } from "@/process/session/forked-agent"
import { Log } from "@/foundation/util/log"

export namespace ToolUseSummary {
  const log = Log.create({ service: "session.tool-use-summary" })

  // Default wall-clock cap. Summaries are short — 20 seconds is plenty.
  // Reference has no cap; we add one so a stuck call never wedges
  // the caller.
  const DEFAULT_TIMEOUT_MS = 20_000

  // Truncation cap for input/output JSON serialization. Keeps the
  // prompt small so the small/fast model can answer in one round.
  // Same constant as the reference impl.
  export const MAX_FIELD_LENGTH = 300

  // Optional context prefix length cap. The reference truncates the
  // last assistant text to 200 chars before prefixing it.
  export const CONTEXT_PREFIX_LENGTH = 200

  // System prompt — verbatim from the reference. The git-commit-subject
  // analogy is the load-bearing instruction; the past-tense verb +
  // distinctive noun rule shapes the output style.
  export const SYSTEM_PROMPT =
    `Write a short summary label describing what these tool calls accomplished. ` +
    `It appears as a single-line row in a mobile app and truncates around 30 characters, ` +
    `so think git-commit-subject, not sentence.\n\n` +
    `Keep the verb in past tense and the most distinctive noun. ` +
    `Drop articles, connectors, and long location context first.\n\n` +
    `Examples:\n` +
    `- Searched in auth/\n` +
    `- Fixed NPE in UserService\n` +
    `- Created signup endpoint\n` +
    `- Read config.json\n` +
    `- Ran failing tests`

  /** Minimal tool descriptor — just enough for the prompt builder. */
  export type ToolInfo = {
    name: string
    input: unknown
    output: unknown
  }

  /**
   * JSON-serialize a value, truncating to maxLength chars (with "..." suffix
   * when truncated). Returns "[unable to serialize]" on JSON.stringify
   * failure (typically circular refs). Exposed for testing.
   */
  export function truncateJson(value: unknown, maxLength = MAX_FIELD_LENGTH): string {
    try {
      const str = JSON.stringify(value)
      // JSON.stringify can return undefined for things like
      // functions or symbols at the top level — treat as unserializable.
      if (str === undefined) return "[unable to serialize]"
      if (str.length <= maxLength) return str
      return str.slice(0, maxLength - 3) + "..."
    } catch {
      return "[unable to serialize]"
    }
  }

  /**
   * Build the user prompt: optional context prefix + the per-tool
   * "Tool: X / Input: Y / Output: Z" block per tool, separated by
   * blank lines, ending with "Label:". Exposed for testing.
   */
  export function buildPrompt(input: { tools: readonly ToolInfo[]; lastAssistantText?: string }): string {
    const toolSummaries = input.tools
      .map((t) => `Tool: ${t.name}\nInput: ${truncateJson(t.input)}\nOutput: ${truncateJson(t.output)}`)
      .join("\n\n")
    const contextPrefix = input.lastAssistantText
      ? `User's intent (from assistant's last message): ${input.lastAssistantText.slice(0, CONTEXT_PREFIX_LENGTH)}\n\n`
      : ""
    return `${contextPrefix}Tools completed:\n\n${toolSummaries}\n\nLabel:`
  }

  export type GenerateInput = {
    tools: readonly ToolInfo[]
    /** Model to use. Should be a small/fast model — labels are short. */
    model: Provider.Model
    /** Agent definition (for forked-agent permission/system prompt inheritance). */
    agent: Agent.Info
    /** Session ID for log correlation. */
    sessionID: string
    /**
     * Optional last-assistant-message text for context. The first 200
     * chars are prefixed to the prompt so the model knows what the
     * tools were trying to accomplish.
     */
    lastAssistantText?: string
    /** Wall-clock cap. Default 20 seconds. */
    timeoutMs?: number
    /** Caller abort signal — typically the parent session's abort. */
    parentAbort?: AbortSignal
  }

  /**
   * Generate a short label for a completed tool batch. Returns null on:
   *   - empty input (no tools)
   *   - abort (timeout or parentAbort fired)
   *   - any error (logged, swallowed — labels are non-critical)
   *
   * The function NEVER throws.
   */
  export async function generate(input: GenerateInput): Promise<string | null> {
    if (input.tools.length === 0) {
      return null
    }

    try {
      const result = await ForkedAgent.run({
        model: input.model,
        agent: input.agent,
        parentSessionID: input.sessionID,
        label: "tool-use-summary",
        // System prompt — passed as a single-element array because
        // ForkedAgent.run accepts string[] (concatenates fragments).
        system: [SYSTEM_PROMPT],
        // Empty messages — the user prompt does all the work.
        messages: [],
        prompt: buildPrompt({ tools: input.tools, lastAssistantText: input.lastAssistantText }),
        tools: {},
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        parentAbort: input.parentAbort,
      })

      if (result.aborted) {
        log.info("tool-use-summary aborted", { sessionID: input.sessionID, durationMs: result.durationMs })
        return null
      }

      const label = result.text.trim()
      if (label.length === 0) {
        log.warn("tool-use-summary produced empty text", { sessionID: input.sessionID })
        return null
      }

      log.info("tool-use-summary generated", {
        sessionID: input.sessionID,
        toolCount: input.tools.length,
        labelLength: label.length,
        durationMs: result.durationMs,
      })

      return label
    } catch (err) {
      log.error("tool-use-summary generation failed", {
        sessionID: input.sessionID,
        err: (err as Error)?.message,
      })
      return null
    }
  }
}
