/**
 * phases/containment.ts — Phase 6: contains + imports edges via tree-sitter.
 *
 * Emits:
 *   - `contains` edges: each source file "contains" its top-level
 *     functions, structs, enums, typedefs, global variables.
 *   - `imports` edges: each #include directive creates an import edge
 *     from the including file to the included file.
 *
 * Generic C/C++ logic — no project-specific knowledge.
 */

import { parseSourceWith, findAllNodes } from "../../../tools/pattern-detector/c-parser.js"
import type { FileSymbolMap, PhaseCtx } from "./types.js"

interface IncludeEdge { includePath: string; line: number }

export async function* extractContainment(
  ctx: PhaseCtx,
  files: string[],
  fileSymbols: FileSymbolMap,
) {
  for (const file of files) {
    if (ctx.signal.aborted) return
    const text = ctx.workspace.readFile(file)
    if (!text) continue

    // Emit contains edges: file → each top-level symbol
    const symbols = fileSymbols.get(file) ?? []
    for (const sym of symbols) {
      yield ctx.edge({
        payload: {
          edgeKind: "contains",
          srcSymbolName: file,
          dstSymbolName: sym.name,
          confidence: 1.0,
          derivation: "clangd",
          evidence: {
            sourceKind: "file_line",
            location: sym.location ?? { filePath: file, line: 1 },
          },
        },
      })
      ctx.metrics.count("edges.contains")
    }

    // Emit imports edges: #include directives
    // Parse once, extract includes as plain JS, delete tree immediately
    const includes = parseSourceWith(text, (root): IncludeEdge[] => {
      const results: IncludeEdge[] = []
      const nodes = findAllNodes(root, "preproc_include")
      for (const inc of nodes) {
        let includePath: string | null = null
        for (let i = 0; i < inc.childCount; i++) {
          const child = inc.child(i)
          if (child?.type === "string_literal" || child?.type === "system_lib_string") {
            includePath = child.text?.replace(/^[<"]|[>"]$/g, "") ?? null
            break
          }
        }
        if (!includePath) continue
        results.push({ includePath, line: (inc.startPosition?.row ?? 0) + 1 })
      }
      return results
    })

    if (includes && includes.length > 0) {
      for (const inc of includes) {
        yield ctx.edge({
          payload: {
            edgeKind: "imports",
            srcSymbolName: file,
            dstSymbolName: inc.includePath,
            confidence: 1.0,
            derivation: "clangd",
            evidence: { sourceKind: "file_line", location: { filePath: file, line: inc.line } },
          },
        })
        ctx.metrics.count("edges.imports")
      }
    } else {
      // Fallback: regex-based #include detection when tree-sitter unavailable
      const lines = text.split("\n")
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^\s*#\s*include\s*[<"]([^>"]+)[>"]/)
        if (m) {
          yield ctx.edge({
            payload: {
              edgeKind: "imports",
              srcSymbolName: file,
              dstSymbolName: m[1],
              confidence: 1.0,
              derivation: "clangd",
              evidence: { sourceKind: "file_line", location: { filePath: file, line: i + 1 } },
            },
          })
          ctx.metrics.count("edges.imports")
        }
      }
    }
  }
}
