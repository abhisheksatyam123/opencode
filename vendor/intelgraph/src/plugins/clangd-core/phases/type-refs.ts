/**
 * phases/type-refs.ts — Phase 7: references_type + field_of_type + aggregates
 * edges via tree-sitter.
 *
 * Emits:
 *   - `references_type`: function parameters/return types reference structs/enums
 *   - `field_of_type`: struct fields reference their declared types
 *   - `aggregates`: struct aggregates another struct (rolled up from field_of_type)
 *
 * Generic C/C++ logic — no project-specific knowledge.
 */

import { parseSourceWith, findAllNodes, walkAst } from "../../../tools/pattern-detector/c-parser.js"
import type { FileSymbolMap, PhaseCtx } from "./types.js"

interface TypeRefEdge {
  edgeKind: "references_type" | "field_of_type" | "aggregates"
  src: string
  dst: string
  line: number
  metadata?: Record<string, unknown>
}

export async function* extractTypeRefs(ctx: PhaseCtx, fileSymbols: FileSymbolMap) {
  // Build a set of known struct/enum/typedef names for matching
  const knownTypes = new Set<string>()
  for (const syms of fileSymbols.values()) {
    for (const s of syms) {
      if (s.kind === "struct" || s.kind === "enum" || s.kind === "typedef") {
        knownTypes.add(s.name)
      }
    }
  }
  if (knownTypes.size === 0) return

  for (const [file] of fileSymbols.entries()) {
    if (ctx.signal.aborted) return
    const text = ctx.workspace.readFile(file)
    if (!text) continue

    // Parse once, extract all type-ref data as plain JS, delete tree immediately
    const edges =
      parseSourceWith(text, (root): TypeRefEdge[] => {
        const results: TypeRefEdge[] = []

        // ── references_type: function declarations ──────────────────────────
        const funcDefs = findAllNodes(root, "function_definition")
        for (const funcDef of funcDefs) {
          let funcName: string | null = null
          const declarator = funcDef.childForFieldName?.("declarator")
          if (declarator) {
            walkAst(declarator, (n: any) => {
              if (!funcName && n.type === "identifier") funcName = n.text
            })
          }
          if (!funcName) continue

          const sigEnd = funcDef.childForFieldName?.("body")?.startPosition?.row ?? funcDef.endPosition?.row ?? 0
          const sigStartRow = funcDef.startPosition?.row ?? 0
          const sigText = text
            .split("\n")
            .slice(sigStartRow, sigEnd + 1)
            .join(" ")

          const emittedTypes = new Set<string>()
          for (const typeName of knownTypes) {
            if (sigText.includes(typeName) && !emittedTypes.has(typeName)) {
              emittedTypes.add(typeName)
              results.push({ edgeKind: "references_type", src: funcName, dst: typeName, line: sigStartRow + 1 })
            }
          }
        }

        // ── field_of_type + aggregates: struct field declarations ────────────
        const structSpecs = findAllNodes(root, "struct_specifier")
        const emittedAggregates = new Set<string>()

        for (const spec of structSpecs) {
          let structName: string | null = null
          for (let i = 0; i < spec.childCount; i++) {
            const child = spec.child(i)
            if (child?.type === "type_identifier") {
              structName = child.text
              break
            }
          }
          if (!structName) continue

          const fieldList = spec.children?.find((c: any) => c.type === "field_declaration_list")
          if (!fieldList) continue

          const fieldDecls = findAllNodes(fieldList, "field_declaration")
          for (const fd of fieldDecls) {
            let fieldName: string | null = null
            const fdDeclarator = fd.childForFieldName?.("declarator")
            if (fdDeclarator) {
              walkAst(fdDeclarator, (n: any) => {
                if (!fieldName && n.type === "field_identifier") fieldName = n.text
              })
            }
            if (!fieldName) continue

            let fieldType: string | null = null
            const typeNode = fd.childForFieldName?.("type")
            if (typeNode) {
              walkAst(typeNode, (n: any) => {
                if (!fieldType && n.type === "type_identifier" && knownTypes.has(n.text)) {
                  fieldType = n.text
                }
              })
            }

            if (fieldType) {
              results.push({
                edgeKind: "field_of_type",
                src: `${structName}.${fieldName}`,
                dst: fieldType,
                line: (fd.startPosition?.row ?? 0) + 1,
                metadata: { containment: "direct" },
              })

              const aggKey = `${structName}:${fieldType}`
              if (!emittedAggregates.has(aggKey)) {
                emittedAggregates.add(aggKey)
                results.push({
                  edgeKind: "aggregates",
                  src: structName,
                  dst: fieldType,
                  line: (spec.startPosition?.row ?? 0) + 1,
                })
              }
            }
          }
        }

        return results
      }) ?? []

    for (const e of edges) {
      yield ctx.edge({
        payload: {
          edgeKind: e.edgeKind,
          srcSymbolName: e.src,
          dstSymbolName: e.dst,
          confidence: 0.85,
          derivation: "clangd",
          ...(e.metadata ? { metadata: e.metadata } : {}),
          evidence: { sourceKind: "file_line", location: { filePath: file, line: e.line } },
        },
      })
      ctx.metrics.count(`edges.${e.edgeKind}`)
    }
  }
}
