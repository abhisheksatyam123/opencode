/**
 * phases/field-access.ts — Phase 4: struct field read/write edges via tree-sitter.
 *
 * Walks each function body for field_expression nodes (ptr->field, obj.field).
 * LHS of assignment → writes_field; otherwise → reads_field.
 *
 * Generic C/C++ logic — no project-specific knowledge.
 */

import { parseSourceWith, findAllNodes } from "../../../tools/pattern-detector/c-parser.js"
import type { FileSymbolMap, PhaseCtx } from "./types.js"

interface FieldEdge {
  edgeKind: "reads_field" | "writes_field"
  enclosingFn: string
  fieldName: string
  structExpr: string
  accessLine: number
  file: string
}

export async function* extractFieldAccess(ctx: PhaseCtx, fileSymbols: FileSymbolMap) {
  for (const [file, symbols] of fileSymbols.entries()) {
    if (ctx.signal.aborted) return
    const text = ctx.workspace.readFile(file)
    if (!text) continue

    const fnRanges: Array<{ name: string; startLine: number; endLine: number }> = []
    for (const sym of symbols) {
      if (sym.kind === "function" && sym.location) {
        fnRanges.push({ name: sym.name, startLine: sym.location.line - 1, endLine: sym.location.line - 1 + 500 })
      }
    }

    // Parse once, extract all field-access data, then delete the tree
    const fieldEdges =
      parseSourceWith(text, (root): FieldEdge[] => {
        const edges: FieldEdge[] = []
        const fieldExprs = findAllNodes(root, "field_expression")
        for (const fe of fieldExprs) {
          const fieldNode = fe.childForFieldName?.("field")
          const argNode = fe.childForFieldName?.("argument")
          if (!fieldNode || !argNode) continue

          const fieldName = fieldNode.text
          const structExpr = argNode.text?.slice(0, 60)
          if (!fieldName || !structExpr) continue

          const accessLine = fe.startPosition?.row ?? 0

          let edgeKind: "reads_field" | "writes_field" = "reads_field"
          const parent = fe.parent
          if (parent?.type === "assignment_expression") {
            const lhs = parent.childForFieldName?.("left")
            if (lhs && lhs.id === fe.id) edgeKind = "writes_field"
          }

          let enclosingFn = "(file-scope)"
          for (const fn of fnRanges) {
            if (accessLine >= fn.startLine && accessLine <= fn.endLine) {
              enclosingFn = fn.name
              break
            }
          }

          edges.push({ edgeKind, enclosingFn, fieldName, structExpr, accessLine, file })
        }
        return edges
      }) ?? []

    for (const e of fieldEdges) {
      yield ctx.edge({
        payload: {
          edgeKind: e.edgeKind,
          srcSymbolName: e.enclosingFn,
          dstSymbolName: `${e.structExpr}.${e.fieldName}`,
          confidence: 0.85,
          derivation: "clangd",
          metadata: { structExpr: e.structExpr, fieldName: e.fieldName, accessPath: `${e.structExpr}.${e.fieldName}` },
          evidence: { sourceKind: "file_line", location: { filePath: e.file, line: e.accessLine + 1 } },
        },
      })
      ctx.metrics.count(`edges.${e.edgeKind}`)
    }
  }
}
