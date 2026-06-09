// session/token-estimate.ts
//
// Pre-call request-token estimator (Phase 1d of the token-efficiency overhaul).
//
// Today opencode discovers context overflow REACTIVELY: it sends the request,
// the API rejects it, the catch block fires `compaction.create()` with
// `overflow: true`, the compactor runs, and the loop retries. That round-trip
// costs one full failed API call plus the compaction LLM run plus the retry
// — easily 30+ seconds and a five-figure token bill on long sessions.
//
// This module provides a cheap pre-call estimate so the loop can decide to
// compact BEFORE the failing call. The estimate is intentionally rough — the
// goal is not to predict the API's exact tokenization, just to catch the
// "we're about to blow the window" case before paying the round-trip.
//
// References:
//   instructkr-claude-code/src/utils/tokens/* — Claude Code's tokenizer choice
//   notes pattern of "char/token ratio + small constant for envelope overhead"

import type { ModelMessage } from "ai"
import type { Tool } from "ai"
import type { Provider } from "@/provider/provider"
import { Token } from "@/foundation/util/token"
import { ProviderTransform } from "@/provider/transform"

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object"
}

export namespace TokenEstimate {
  // Empirical char-to-token ratios. The reference implementation uses ~3.5
  // chars/token for Anthropic (English text) and ~4 for OpenAI. We default
  // to 3.5 because Claude is the dominant provider in opencode and the ratio
  // is also the more conservative (under-estimate would be worse — it would
  // fail to trigger pre-call compaction).
  export const CHARS_PER_TOKEN = 3.5

  // Per-message envelope overhead (role, type, attachments wrapper). Trivial
  // but adds up across hundreds of messages. Same number Claude Code uses.
  export const PER_MESSAGE_OVERHEAD_TOKENS = 4

  // Per-tool envelope overhead (name + description wrapping). Each tool def
  // burns at least this many tokens even before the schema is serialized.
  export const PER_TOOL_OVERHEAD_TOKENS = 16

  /**
   * Cheap rough-pass estimate of the total input tokens for a request. This
   * is NOT a tokenizer — it's a string-length heuristic intended to catch
   * the "this request is going to overflow" case 80% of the time without
   * requiring a tokenizer dependency or an API round-trip to count_tokens.
   *
   * Sums:
   *   1. system prompt strings → length / CHARS_PER_TOKEN
   *   2. message bodies → length / CHARS_PER_TOKEN, plus per-message envelope
   *   3. tool defs → JSON-stringified length / CHARS_PER_TOKEN, plus per-tool envelope
   *
   * The result is comparable against `model.limit.input - reserved` to decide
   * whether to compact before the call.
   */
  export function estimate(input: { system: string[]; messages: ModelMessage[]; tools: Record<string, Tool> }): number {
    let total = 0

    for (const s of input.system) {
      total += Token.estimate(s)
    }

    for (const msg of input.messages) {
      total += PER_MESSAGE_OVERHEAD_TOKENS
      if (typeof msg.content === "string") {
        total += Token.estimate(msg.content)
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          const item: unknown = part
          // Walk a small set of known content shapes; anything else is JSON-
          // stringified for a worst-case estimate. Tool calls and tool results
          // dominate the token bill on long sessions, so they get explicit
          // handling for accuracy.
          if (record(item) && typeof item.text === "string") {
            total += Token.estimate(item.text)
          } else if (record(item) && "input" in item) {
            // tool-call: input gets JSON-stringified by the SDK
            try {
              total += Token.estimate(JSON.stringify(item.input ?? ""))
            } catch {
              // ignore — circular ref or other JSON failure
            }
          } else if (record(item) && "output" in item) {
            // tool-result: output may be string or object
            const out = item.output
            if (typeof out === "string") {
              total += Token.estimate(out)
            } else if (record(out) && typeof out.text === "string") {
              total += Token.estimate(out.text)
            } else {
              try {
                total += Token.estimate(JSON.stringify(out ?? ""))
              } catch {
                // ignore
              }
            }
          } else {
            // Fallback worst-case estimate
            try {
              total += Token.estimate(JSON.stringify(part))
            } catch {
              // ignore
            }
          }
        }
      }
    }

    for (const [name, tool] of Object.entries(input.tools)) {
      total += PER_TOOL_OVERHEAD_TOKENS
      total += Token.estimate(name)
      // Description and inputSchema dominate the per-tool budget.
      const definition = tool as unknown
      try {
        total += Token.estimate(JSON.stringify(record(definition) ? (definition.description ?? "") : ""))
        total += Token.estimate(JSON.stringify(record(definition) ? (definition.inputSchema ?? "") : ""))
      } catch {
        // ignore
      }
    }

    return total
  }

  /**
   * Decide whether the estimated input would overflow the model's usable
   * context window. Returns the estimated total and a boolean for the
   * decision so callers can log both.
   */
  export function wouldOverflow(input: {
    system: string[]
    messages: ModelMessage[]
    tools: Record<string, Tool>
    model: Provider.Model
    reservedTokens?: number
  }): { estimated: number; overflow: boolean; usable: number } {
    // Mirror overflow.ts: if context is unknown/unlimited (0), never overflow.
    const context = input.model.limit.context
    if (!context) return { estimated: 0, overflow: false, usable: 0 }

    const estimated = estimate({ system: input.system, messages: input.messages, tools: input.tools })

    // Mirror overflow.ts's `reserved` + `usable` calculation exactly so the
    // pre-call estimate and the post-call check use the same threshold.
    // The old code used a flat 20k reserved against `context - 20k`, which
    // diverged from overflow.ts's `context - maxOutputTokens(model)` and
    // caused the estimator to fire much earlier (or always, when context=0).
    //
    // When reservedTokens is explicitly provided, use it directly.
    // Otherwise mirror overflow.ts: reserve maxOutputTokens(model) tokens.
    const maxOutput = ProviderTransform.maxOutputTokens(input.model)
    const reserved = input.reservedTokens !== undefined ? input.reservedTokens : maxOutput
    const usable = input.model.limit.input ? input.model.limit.input - reserved : context - reserved

    return { estimated, overflow: estimated >= usable, usable }
  }
}
