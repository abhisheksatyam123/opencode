/**
 * phases/symbols.ts — Phase 1: symbol + type extraction via clangd LSP.
 *
 * Walks each discovered file, calls documentSymbol to get the LSP symbol
 * list, maps LSP symbol kinds to our internal kinds (function, struct,
 * enum, typedef, field, param), and yields symbol + type facts.
 *
 * Reusable across any C/C++ project — no project-specific knowledge.
 */

import type { SymbolRow } from "../../../intelligence/contracts/common.js"
import { parseSourceWith, findAllNodes } from "../../../tools/pattern-detector/c-parser.js"
import type { FileSymbolMap, PhaseCtx } from "./types.js"
import { disabledPreprocessorLineSet, isLineInDisabledPreprocessorRegion } from "./preprocessor.js"

// LSP SymbolKind → internal kind
function mapLspSymbolKind(k: number): SymbolRow["kind"] {
  switch (k) {
    case 12: return "function"
    case 23: return "struct"
    case 10: return "enum"
    case 26: return "typedef"
    case 13: return "field"
    case 14: return "param"
    default: return "function"
  }
}

interface RawLspSymbol {
  name?: unknown
  kind?: unknown
  containerName?: unknown
  location?: { range?: { start?: { line?: unknown; character?: unknown } } }
  range?: { start?: { line?: unknown; character?: unknown } }
}

/**
 * Phase 1: extract symbols and types from each file via clangd LSP.
 * Populates fileSymbols map as a side effect for use by later phases.
 */
export async function* extractSymbols(
  ctx: PhaseCtx,
  files: string[],
  fileSymbols: FileSymbolMap,
) {
  for (const file of files) {
    if (ctx.signal.aborted) return

    const text = ctx.workspace.readFile(file)
    if (!text) continue

    const disabledLines = disabledPreprocessorLineSet(text)
    const result = await ctx.lsp.documentSymbol(file, text)
    ctx.metrics.timing("lsp.documentSymbol", result.durationMs)
    if (result.error) {
      ctx.metrics.count(`lsp.documentSymbol.error.${result.error.class}`)
      continue
    }
    // Support both wrapped ({value: [...], durationMs}) and plain array results
    const raw = (Array.isArray(result) ? result : (result.value ?? [])) as RawLspSymbol[]
    const lspReturnedSymbols = raw.length > 0
    const symbolsForFile: SymbolRow[] = []

    for (const s of raw) {
      const range = s.range ?? s.location?.range
      const start = range?.start
      const line = ((start?.line as number | undefined) ?? 0) + 1
      if (isLineInDisabledPreprocessorRegion(disabledLines, line)) {
        ctx.metrics.count("symbols.skipped.preprocessor_disabled")
        continue
      }
      const symbolRow: SymbolRow = {
        kind: mapLspSymbolKind((s.kind as number) ?? 12),
        name: String(s.name ?? ""),
        qualifiedName: s.containerName
          ? `${String(s.containerName)}::${String(s.name)}`
          : undefined,
        location: {
          filePath: file,
          line,
          column: ((start?.character as number | undefined) ?? 0) + 1,
        },
      }
      if (!symbolRow.name) continue
      symbolsForFile.push(symbolRow)

      yield ctx.symbol({ payload: symbolRow })
      ctx.metrics.count(`symbols.${symbolRow.kind}`)

      if (symbolRow.kind === "struct" || symbolRow.kind === "enum" || symbolRow.kind === "typedef") {
        yield ctx.type({
          payload: { kind: symbolRow.kind, spelling: symbolRow.name, symbolName: symbolRow.name },
        })
      }
    }

    // When LSP returns no symbols (stub or unavailable), fall back to
    // tree-sitter to extract at least function definitions. This ensures
    // Phases 3-5 have function boundary data and Phase 5 has a populated
    // knownFunctions set for callback detection.
    // Only fall back when LSP itself returned nothing — if LSP returned
    // non-function symbols (structs etc.), respect that and do not inject
    // synthetic function symbols that would trigger outgoingCalls.
    if (!lspReturnedSymbols && symbolsForFile.length === 0) {
      const text2 = ctx.workspace.readFile(file)
      if (text2) {
        const extracted = parseSourceWith(text2, (root) => {
          const results: typeof symbolsForFile = []
          for (const fnDef of findAllNodes(root, "function_definition")) {
            const declNode = fnDef.childForFieldName?.("declarator")
            let inner = declNode
            while (inner && inner.type === "pointer_declarator") {
              inner = inner.childForFieldName?.("declarator") ?? inner.firstChild ?? undefined
            }
            const nameNode = inner?.type === "function_declarator"
              ? (inner.childForFieldName?.("declarator") ?? inner.firstChild)
              : inner
            const rawName = nameNode?.text ?? ""
            const name = rawName.replace(/[^a-zA-Z0-9_]/g, "")
            if (!name) continue
            const startLine = (fnDef.startPosition?.row ?? 0) + 1
            if (isLineInDisabledPreprocessorRegion(disabledLines, startLine)) continue
            results.push({
              kind: "function",
              name,
              location: { filePath: file, line: startLine, column: 1 },
              metadata: { _astFallback: true },
            })
          }
          return results
        })
        if (extracted && extracted.length > 0) {
          symbolsForFile.push(...extracted)
          ctx.metrics.count("symbols.ast_fallback", extracted.length)
          // Persist AST-fallback symbols as graph nodes so they are queryable
          // via find_symbol_at_location and appear in who_calls_api result
          // nodes. Without this yield, fallback symbols only populate the
          // in-memory knownFunctions set but are not written to the DB.
          for (const row of extracted) {
            yield ctx.symbol({ payload: row })
          }
        }
      }
    }

    fileSymbols.set(file, symbolsForFile)
  }
}
