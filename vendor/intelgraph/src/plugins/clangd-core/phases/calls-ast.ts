/**
 * phases/calls-ast.ts — AST-based direct call extraction fallback.
 *
 * Extracts `calls` edges via tree-sitter when clangd LSP is unavailable.
 * Walks every function_definition in each file and collects all
 * call_expression → callee name edges within the function body.
 *
 * Emits edges only where the callee appears to be a real function (either
 * defined in fileSymbols, OR declared in the same file). This avoids
 * flooding the graph with macro/keyword false positives while still capturing
 * calls to functions declared in the same translation unit (including local
 * static functions and same-file forward declarations).
 */

import { parseSourceWith, findAllNodes, walkAst } from "../../../tools/pattern-detector/c-parser.js"
import type { FileSymbolMap, PhaseCtx } from "./types.js"
import { disabledPreprocessorLineSet, isLineInDisabledPreprocessorRegion } from "./preprocessor.js"

interface RawCall {
  caller: string
  callee: string
  line: number
}

export async function* extractCallsAst(ctx: PhaseCtx, fileSymbols: FileSymbolMap) {
  // Build set of all known function names from Phase 1 symbol extraction
  // (includes functions found in all .c and .h files in the extraction budget).
  const knownFunctions = new Set<string>()
  for (const syms of fileSymbols.values()) {
    for (const s of syms) {
      if (s.kind === "function") knownFunctions.add(s.name)
    }
  }
  if (knownFunctions.size === 0) return

  for (const [file] of fileSymbols.entries()) {
    if (ctx.signal.aborted) return
    const text = ctx.workspace.readFile(file)
    if (!text) continue

    const disabledLines = disabledPreprocessorLineSet(text)
    const calls =
      parseSourceWith(text, (root): RawCall[] => {
        const results: RawCall[] = []

        // Build a per-file set of callable names: includes globally known functions
        // plus any function-like identifiers declared in THIS file (forward decls,
        // inline helpers, macros expanded to function names in same TU).
        // We do a single pre-pass over all call_expressions in the file to collect
        // callee names that are also defined/declared in this file.
        const fileLocalFns = new Set<string>(knownFunctions)

        // Add functions defined or declared in this file (even if not yet in knownFunctions
        // because they're LOCAL/STATIC and only visible here).
        const allDefs = findAllNodes(root, "function_definition")
        for (const fd of allDefs) {
          const fnLine = (fd.startPosition?.row ?? 0) + 1
          if (isLineInDisabledPreprocessorRegion(disabledLines, fnLine)) continue
          const decl = fd.childForFieldName?.("declarator")
          let inner = decl
          while (inner && inner.type === "pointer_declarator") {
            inner = inner.childForFieldName?.("declarator") ?? inner.firstChild ?? undefined
          }
          if (inner?.type === "function_declarator") {
            const nameNode = inner.childForFieldName?.("declarator") ?? inner.firstChild
            const name = nameNode?.text?.replace(/[^a-zA-Z0-9_]/g, "")
            if (name && name.length > 1) fileLocalFns.add(name)
          }
        }

        const funcDefs = findAllNodes(root, "function_definition")
        for (const funcDef of funcDefs) {
          const fnLine = (funcDef.startPosition?.row ?? 0) + 1
          if (isLineInDisabledPreprocessorRegion(disabledLines, fnLine)) continue
          // Get the function name
          let callerName: string | null = null
          const declarator = funcDef.childForFieldName?.("declarator")
          if (declarator) {
            walkAst(declarator, (n: any) => {
              if (!callerName && n.type === "identifier") callerName = n.text
            })
          }
          if (!callerName) continue

          // Walk all call_expressions inside the function body
          const body = funcDef.childForFieldName?.("body")
          if (!body) continue

          const callExprs = findAllNodes(body, "call_expression")
          const seenCallees = new Set<string>()
          for (const callExpr of callExprs) {
            const fnNode = callExpr.childForFieldName?.("function")
            if (!fnNode) continue

            let calleeName: string | null = null
            if (fnNode.type === "identifier") {
              calleeName = fnNode.text
            } else if (fnNode.type === "field_expression") {
              // ptr->method or struct.method — extract field name
              const field = fnNode.childForFieldName?.("field")
              calleeName = field?.text ?? null
            } else if (fnNode.type === "parenthesized_expression") {
              // (*fn_ptr)(args) — skip function pointer calls
              continue
            }

            if (!calleeName || !fileLocalFns.has(calleeName)) continue
            if (seenCallees.has(calleeName)) continue
            seenCallees.add(calleeName)

            const callLine = (callExpr.startPosition?.row ?? 0) + 1
            if (isLineInDisabledPreprocessorRegion(disabledLines, callLine)) continue
            results.push({ caller: callerName, callee: calleeName, line: callLine })
          }
        }

        return results
      }) ?? []

    for (const call of calls) {
      yield ctx.edge({
        payload: {
          edgeKind: "calls",
          srcSymbolName: call.caller,
          dstSymbolName: call.callee,
          confidence: 0.85,
          derivation: "clangd",
          evidence: { sourceKind: "file_line", location: { filePath: file, line: call.line } },
        },
      })
      ctx.metrics.count("edges.calls")
    }
  }
}
