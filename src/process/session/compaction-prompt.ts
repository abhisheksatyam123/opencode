// session/compaction-prompt.ts
//
// Compaction prompt building blocks (Phase 1g of the token-efficiency overhaul).
//
// Current compaction contract:
//   1. TOOL_USE_PREAMBLE — tools are available for bounded evidence gathering
//      while the final handoff remains concise and non-mutating.
//   2. STRUCTURED_TEMPLATE — the same two top-level sections used by active
//      task files: `## Tasks` and `## Systems`. Conversation replay and hidden
//      task-note parsers are intentionally not part of the contract.
//   3. `stripAnalysis()` remains as a defensive cleanup for model outputs
//      that include an analysis scratchpad despite the lean prompt.
//
// References (instructkr-claude-code, Claude Code source):
//   src/services/compact/prompt.ts — BASE_COMPACT_PROMPT and formatCompactSummary.
//   Opencode intentionally permits bounded read-only tool use during compaction.

export namespace CompactionPrompt {
  // Tool-use preamble. Goes FIRST in the compaction system prompt so the
  // shared base prompt's tool contract and the summary-specific constraints
  // agree: tools are available, but only for bounded evidence gathering.
  export const TOOL_USE_PREAMBLE = `Tools are available when needed, including bash for bounded read-only inspection. Do not modify files or create notes while generating the handoff summary.

`

  // Trailer reminder. Repeated to fight position bias on long inputs.
  export const TOOL_USE_TRAILER = `
Use tools only when they improve summary accuracy; otherwise answer directly.`

  // Keep the compaction target short and task-local.
  export const ANALYSIS_INSTRUCTION = `Keep only task state and concise facts.`

  // Output shape mirrors active task files and avoids transcript replay.
  export const STRUCTURED_TEMPLATE = `Output only:
## Tasks
## Systems`

  /**
   * Build a full compaction prompt from a notes-aware base prompt by prepending
   * the TOOL_USE_PREAMBLE and appending the structured template + analysis
   * instruction + trailer reminder. The returned string is what gets sent as
   * the user-message body in compaction.ts.
   */
  export function build(notesAwareBasePrompt: string): string {
    return [
      TOOL_USE_PREAMBLE,
      notesAwareBasePrompt,
      "",
      ANALYSIS_INSTRUCTION,
      "",
      STRUCTURED_TEMPLATE,
      TOOL_USE_TRAILER,
    ].join("\n")
  }

  // Match the reference impl's analysis regex. Single-shot replace; if the
  // model produced multiple analysis blocks (rare) only the first is stripped
  // — anything beyond is treated as content the model deliberately kept.
  const ANALYSIS_RX = /<analysis>[\s\S]*?<\/analysis>\s*/

  /**
   * Strip the <analysis> drafting scratchpad from a model summary. Idempotent
   * and forgiving — if the model didn't produce an analysis block (or wrapped
   * it in different tags) the input is returned untouched.
   */
  export function stripAnalysis(summary: string): string {
    return summary
      .replace(ANALYSIS_RX, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  }

  /**
   * Pull the inner content of the <summary>...</summary> wrapper, falling back
   * to the analysis-stripped text when the model omitted the wrapper. Mirrors
   * the reference impl's `formatCompactSummary` shape.
   */
  export function extractSummary(rawText: string): string {
    const stripped = stripAnalysis(rawText)
    const match = stripped.match(/<summary>([\s\S]*?)<\/summary>/)
    if (match && match[1] !== undefined) return match[1].trim()
    return stripped
  }
}
