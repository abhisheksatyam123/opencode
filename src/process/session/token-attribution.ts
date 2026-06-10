// session/token-attribution.ts
//
// Per-tool token attribution analyzer (parity gap-12).
//
// PROVENANCE: ported from
// `instructkr-claude-code/src/utils/analyzeContext.ts`
// (functions `processAssistantMessage`, `processUserMessage`,
// `approximateMessageTokens` plus the `MessageBreakdown.toolCallsByType`
// data shape).
//
// Why we DIDN'T cp the source file directly:
//
//   * `analyzeContext.ts` is 1382 LOC of UI machinery built around
//     Anthropic's Message type — `tool_use_id` lookups, attachment
//     blocks, system prompt section breakdown, microcompact-aware
//     accounting, theme colors for the `/ctx_viz` UI command. Almost
//     none of this is portable to opencode's MessageV2 / TUI.
//
//   * Claude's algorithm needs a `tool_use_id → tool_name` lookup map
//     because Anthropic splits tool name (on the assistant side) from
//     tool result (on the user side). opencode's MessageV2.ToolPart
//     has the tool NAME directly on every part regardless of state, so
//     the analyzer is half the size and doesn't need the map at all.
//
// What we KEPT:
//
//   * The bucket structure: per-tool `{ input, output, total, calls }`
//     plus session-level totals.
//   * The "JSON-stringify the part body before counting" pattern, which
//     matches how the Anthropic API actually serializes the request.
//   * The "unknown" fallback for tool parts missing a name.
//
// Use cases:
//
//   * `/ctx_viz` style debugging: which tools are eating the most
//     context on long sessions?
//   * Compaction guidance: when the loop is about to compact, show
//     which tools should be pruned first.
//   * Per-tool budget enforcement (gap-12 follow-up): cap a tool to
//     N tokens per turn and reject calls beyond that.

import { Token } from "@/foundation/util/token"
import type { MessageV2 } from "@/process/session/message-v2"

export namespace TokenAttribution {
  /** Per-tool token bucket. All counts are best-effort estimates from
   * `Token.estimate()` (the same heuristic the rest of opencode uses
   * for cheap pre-call sizing). */
  export type ToolBucket = {
    /** Tool identifier (e.g. "read", "edit", "bash"). The literal
     * `"unknown"` is used when a part lacks a name. */
    name: string
    /** Number of times this tool was invoked in the input messages. */
    calls: number
    /** Estimated tokens consumed by tool inputs (the JSON arguments
     * the model emitted to call the tool). */
    inputTokens: number
    /** Estimated tokens consumed by tool outputs (what the tool
     * returned to the model). Includes error strings on error parts. */
    outputTokens: number
    /** `inputTokens + outputTokens` — convenience for sorting. */
    totalTokens: number
  }

  /** Full breakdown for a session or message slice. */
  export type Breakdown = {
    /** Per-tool buckets, sorted by `totalTokens` descending. */
    tools: ToolBucket[]
    /** Sum of `inputTokens` across all tools. */
    totalInputTokens: number
    /** Sum of `outputTokens` across all tools. */
    totalOutputTokens: number
    /** Sum of `totalTokens` across all tools. */
    totalTokens: number
    /** Total number of tool invocations counted across all tools. */
    totalCalls: number
  }

  /**
   * Walk the parts of every message and produce a per-tool token
   * attribution breakdown. Pure function — no I/O, no plugin hooks,
   * no instrumentation. Safe to call on any historical message log.
   *
   * The accounting uses `Token.estimate()` (a char/token heuristic)
   * rather than a real tokenizer. The output should be treated as a
   * RELATIVE signal — "tool A is roughly 3× tool B" — not an absolute
   * billing number.
   */
  export function analyze(messages: Iterable<MessageV2.WithParts>): Breakdown {
    const buckets = new Map<string, ToolBucket>()

    for (const msg of messages) {
      for (const part of msg.parts) {
        if (part.type !== "tool") continue

        const name = part.tool || "unknown"
        const bucket = ensureBucket(buckets, name)
        bucket.calls += 1

        const state = part.state
        // `input` is present on running/completed/error states. The
        // pending state has no input yet.
        if ("input" in state && state.input !== undefined) {
          bucket.inputTokens += Token.estimate(safeStringify(state.input))
        }
        // `output` is only on completed; `error` is only on error.
        // We bucket both into outputTokens because from a context-cost
        // perspective they look identical to the model.
        if ("output" in state && typeof state.output === "string") {
          bucket.outputTokens += Token.estimate(state.output)
        } else if ("error" in state && typeof state.error === "string") {
          bucket.outputTokens += Token.estimate(state.error)
        }
        bucket.totalTokens = bucket.inputTokens + bucket.outputTokens
      }
    }

    const tools = Array.from(buckets.values()).sort((a, b) => b.totalTokens - a.totalTokens)
    let totalInputTokens = 0
    let totalOutputTokens = 0
    let totalTokens = 0
    let totalCalls = 0
    for (const t of tools) {
      totalInputTokens += t.inputTokens
      totalOutputTokens += t.outputTokens
      totalTokens += t.totalTokens
      totalCalls += t.calls
    }

    return {
      tools,
      totalInputTokens,
      totalOutputTokens,
      totalTokens,
      totalCalls,
    }
  }

  /**
   * Render a `Breakdown` as a small human-readable table. Useful for
   * `/ctx_viz`-style debug commands and Worklog notes. The format is
   * intentionally line-oriented for grep-ability.
   *
   * @example
   *   tool             calls    in_tok   out_tok   total
   *   bash                 7      1240     85432   86672
   *   read                12      4810      6210   11020
   *   grep                 5       820      3120    3940
   *   ────────────────────────────────────────────────────
   *   total               24      6870     94762  101632
   */
  export function format(breakdown: Breakdown, options: { topN?: number } = {}): string {
    const top = options.topN ? breakdown.tools.slice(0, options.topN) : breakdown.tools
    const colName = Math.max(8, ...top.map((t) => t.name.length))
    const header =
      pad("tool", colName) +
      " " +
      pad("calls", 7) +
      " " +
      pad("in_tok", 9) +
      " " +
      pad("out_tok", 9) +
      " " +
      pad("total", 9)
    const lines: string[] = [header]
    for (const t of top) {
      lines.push(
        pad(t.name, colName) +
          " " +
          pad(String(t.calls), 7) +
          " " +
          pad(String(t.inputTokens), 9) +
          " " +
          pad(String(t.outputTokens), 9) +
          " " +
          pad(String(t.totalTokens), 9),
      )
    }
    lines.push("─".repeat(colName + 1 + 7 + 1 + 9 + 1 + 9 + 1 + 9))
    lines.push(
      pad("total", colName) +
        " " +
        pad(String(breakdown.totalCalls), 7) +
        " " +
        pad(String(breakdown.totalInputTokens), 9) +
        " " +
        pad(String(breakdown.totalOutputTokens), 9) +
        " " +
        pad(String(breakdown.totalTokens), 9),
    )
    return lines.join("\n")
  }

  // ── helpers ────────────────────────────────────────────────────────

  function ensureBucket(map: Map<string, ToolBucket>, name: string): ToolBucket {
    let bucket = map.get(name)
    if (!bucket) {
      bucket = { name, calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 }
      map.set(name, bucket)
    }
    return bucket
  }

  function safeStringify(value: unknown): string {
    try {
      return JSON.stringify(value) ?? ""
    } catch {
      // Circular ref or other JSON failure — fall back to a worst-case
      // estimate based on the toString.
      return String(value ?? "")
    }
  }

  function pad(s: string, width: number): string {
    if (s.length >= width) return s
    return s + " ".repeat(width - s.length)
  }
}
