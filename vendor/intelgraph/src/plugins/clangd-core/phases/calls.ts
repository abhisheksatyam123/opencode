/**
 * phases/calls.ts — Phase 2: direct call edges via clangd outgoingCalls.
 *
 * For each function symbol, asks clangd for its outgoing calls and emits
 * `calls` edges. Reusable across any C/C++ project.
 */

import type { FileSymbolMap, PhaseCtx } from "./types.js"

interface RawCallHierarchyOutgoing {
  to?: { name?: unknown }
  name?: unknown
}

export async function* extractCalls(
  ctx: PhaseCtx,
  fileSymbols: FileSymbolMap,
) {
  for (const [file, symbols] of fileSymbols.entries()) {
    if (ctx.signal.aborted) return
    const text = ctx.workspace.readFile(file)
    if (!text) continue

    for (const sym of symbols) {
      if (sym.kind !== "function" || !sym.location) continue
      if (sym.metadata?._astFallback) continue

      const result = await ctx.lsp.outgoingCalls(
        sym.location.filePath,
        text,
        sym.location.line - 1,
        (sym.location.column ?? 1) - 1,
      )
      ctx.metrics.timing("lsp.outgoingCalls", result.durationMs)
      if (result.error) {
        ctx.metrics.count(`lsp.outgoingCalls.error.${result.error.class}`)
        continue
      }
      const calls = (result.value ?? []) as RawCallHierarchyOutgoing[]
      for (const call of calls) {
        const item = call.to ?? call
        const name = String((item as { name?: unknown }).name ?? "")
        if (!name) continue
        yield ctx.edge({
          payload: {
            edgeKind: "calls",
            srcSymbolName: sym.name,
            dstSymbolName: name,
            confidence: 1.0,
            derivation: "clangd",
            evidence: { sourceKind: "clangd_response", location: sym.location },
          },
        })
        ctx.metrics.count("edges.calls")
      }
    }
  }
}
