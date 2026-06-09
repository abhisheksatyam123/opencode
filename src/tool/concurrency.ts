// tool/concurrency.ts
//
// Tool concurrency-safety classifier (gap-3 partial port).
//
// PROVENANCE: the concept comes from
// `instructkr-claude-code/src/services/tools/StreamingToolExecutor.ts`
// where each tool definition exposes an `isConcurrencySafe(input)`
// method and the executor groups concurrency-safe tools into parallel
// batches while serializing exclusive ones. opencode's tool dispatch
// chain is structured differently (Tool.Def + Tool.wrap, no centralized
// executor), so the classifier lives in its own module rather than as
// a method on each tool definition.
//
// SCOPE OF THIS PORT:
//   - Add `Tool.Def.concurrencySafe` annotation field (see tool/tool.ts)
//   - This module's `Concurrency.isSafe(toolID, args)` consumes the
//     annotation OR falls back to a curated default list for built-in
//     tools that haven't been annotated yet
//   - The actual parallel-dispatch wiring (the executor that groups
//     tools and runs concurrency-safe batches in parallel) is a
//     follow-up iteration. Without that wiring, this module is purely
//     informational — but landing the classifier first means tool
//     authors can declare safety NOW so the wiring lands clean.
//
// DEFAULT CLASSIFICATION POLICY:
//   - Explicitly annotated read-only work: SAFE (idempotent, no state)
//   - Shell, file mutations, mode switches, durable-state writes: UNSAFE
//   - Subagent dispatch and notes-vault writes: UNSAFE
//   - Unknown tools: UNSAFE (default-deny)
//
// The default list reflects opencode's built-in tools as of this commit.
// Tool authors should explicitly set `concurrencySafe` on their Tool.Def
// rather than relying on the default — explicit annotations survive
// renames and never go out of date silently.

import type { Tool } from "@/tool/tool"

export namespace Concurrency {
  /**
   * Default concurrency-safety classification for opencode's built-in
   * tools. Curated based on each tool's semantics:
   *
   *   SAFE   — read-only, idempotent, no shared mutable state
   *   UNSAFE — mutates files, shell state, mode flags, durable storage,
   *            or spawns subagents
   *
   * Tools NOT in this map fall through to the default-deny policy in
   * `isSafe()` below.
   */
  export const DEFAULTS: Record<string, boolean> = {
    // Shell execution may read, write, spawn processes, or mutate cwd-local
    // state. Bash has its own command-level annotation when a call is known
    // to be safe; the default remains exclusive.
    bash: false,

    // Subagent dispatch spawns child sessions with their own permission
    // contexts and side effects. Always exclusive by default.
    task: false,
  }

  /**
   * Decide whether a tool is safe to run in parallel with sibling
   * concurrent-safe tools.
   *
   * Resolution order:
   *   1. If `def.concurrencySafe` is set (boolean OR function), use it.
   *      A function form is called with the args so the tool can decide
   *      based on the specific input (e.g. read-only bash commands can
   *      run in parallel while mutating bash commands stay exclusive).
   *   2. Otherwise look up the toolID in `DEFAULTS`.
   *   3. Otherwise default-deny (UNSAFE) — the conservative answer for
   *      any tool we don't recognize.
   *
   * The boolean answer is the input the dispatch layer needs to decide
   * whether to add this tool to the current parallel batch or start a
   * new exclusive group.
   */
  export function isSafe(toolID: string, def?: Tool.Def<any, any>, args?: unknown): boolean {
    // 1. Tool-supplied annotation wins
    if (def?.concurrencySafe !== undefined) {
      const annotation = def.concurrencySafe
      if (typeof annotation === "boolean") return annotation
      if (typeof annotation === "function") {
        try {
          return Boolean(annotation(args as any))
        } catch {
          // Defensive: if the function throws (bad args, etc.), fall
          // back to default-deny rather than crash the dispatcher.
          return false
        }
      }
    }

    // 2. Curated default for built-in tools
    if (toolID in DEFAULTS) return DEFAULTS[toolID]!

    // 3. Default-deny for anything else
    return false
  }

  /**
   * Group a sequence of tool calls into ordered concurrency batches.
   * Each batch is either:
   *   - One or more concurrency-safe tools that may run in parallel, OR
   *   - A single concurrency-UNSAFE tool that must run alone
   *
   * The grouping preserves the original order: tool N+1 only joins
   * tool N's batch if BOTH are safe; otherwise N+1 starts a new batch.
   * This matches the reference impl's behavior — parallel-safe tools
   * cluster, exclusive tools force a flush.
   *
   * The dispatch layer can iterate batches in order, awaiting all tools
   * in each batch before starting the next. This gives the streaming
   * behavior: as long as the model emits a run of safe tools, they all
   * fire concurrently; an unsafe tool acts as a barrier.
   *
   * @example
   *   const safe = { concurrencySafe: true }
   *   group([
   *     { id: "bash", args: { command: "pwd" }, def: safe },
   *     { id: "bash", args: { command: "ls" }, def: safe }, // joins batch 1
   *     { id: "task", args: {} },                            // exclusive batch 2
   *     { id: "bash", args: { command: "git status" }, def: safe }, // batch 3
   *   ])
   *   // → [
   *   //     [{bash}, {bash}], // batch 1: parallel
   *   //     [{task}],         // batch 2: exclusive
   *   //     [{bash}],         // batch 3: parallel
   *   //   ]
   */
  export type ToolCall<TArgs = unknown> = {
    id: string
    args: TArgs
    def?: Tool.Def<any, any>
  }

  export function group<T extends ToolCall>(calls: T[]): T[][] {
    const batches: T[][] = []
    let current: T[] = []
    let currentIsParallel = false

    for (const call of calls) {
      const safe = isSafe(call.id, call.def, call.args)
      if (current.length === 0) {
        // Starting a fresh batch — adopt the safety mode of the first tool
        current.push(call)
        currentIsParallel = safe
        continue
      }
      // Extending an existing batch is only allowed when:
      //   - the current batch is parallel (safe)
      //   - AND the incoming tool is also safe
      // Any other combination forces a flush.
      if (currentIsParallel && safe) {
        current.push(call)
      } else {
        batches.push(current)
        current = [call]
        currentIsParallel = safe
      }
    }
    if (current.length > 0) batches.push(current)
    return batches
  }
}
