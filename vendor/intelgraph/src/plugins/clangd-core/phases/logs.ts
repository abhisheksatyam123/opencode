/**
 * phases/logs.ts — Phase 3: log-event edges via tree-sitter AST walk.
 *
 * Walks each file's AST looking for call_expression nodes whose callee
 * matches a log macro from any active pack. Emits logs_event edges with
 * format string, log level, and subsystem.
 *
 * Generic C/C++ logic — the log-macro list comes from the pack's
 * logMacros field, not from this module.
 */

import { parseSourceWith, findAllNodes } from "../../../tools/pattern-detector/c-parser.js"
import type { LogMacroDef } from "../packs/types.js"
import type { FileSymbolMap, PhaseCtx } from "./types.js"

interface LogEdge {
  enclosingFn: string
  calleeName: string
  callLine: number
  level: string
  template: string
  subsystem: string | null
  macro: string
  file: string
}

export async function* extractLogs(ctx: PhaseCtx, fileSymbols: FileSymbolMap, logMacroMap: Map<string, LogMacroDef>) {
  if (logMacroMap.size === 0) return

  for (const [file, symbols] of fileSymbols.entries()) {
    if (ctx.signal.aborted) return
    const text = ctx.workspace.readFile(file)
    if (!text) continue

    // Function line ranges for attribution.
    // Sort by startLine and use the next function's startLine as each function's endLine
    // to avoid false attribution when functions are densely packed.
    const fnRangesUnsorted: Array<{ name: string; startLine: number }> = []
    for (const sym of symbols) {
      if (sym.kind === "function" && sym.location) {
        fnRangesUnsorted.push({ name: sym.name, startLine: sym.location.line - 1 })
      }
    }
    fnRangesUnsorted.sort((a, b) => a.startLine - b.startLine)
    const fnRanges: Array<{ name: string; startLine: number; endLine: number }> = fnRangesUnsorted.map((fn, i) => ({
      name: fn.name,
      startLine: fn.startLine,
      endLine: i + 1 < fnRangesUnsorted.length ? fnRangesUnsorted[i + 1].startLine - 1 : fn.startLine + 10000,
    }))

    // Parse once, extract all log edges, then delete the tree immediately
    const logEdges =
      parseSourceWith(text, (root): LogEdge[] => {
        const edges: LogEdge[] = []
        const callNodes = findAllNodes(root, "call_expression")
        for (const callNode of callNodes) {
          const fnNode = callNode.childForFieldName?.("function")
          if (!fnNode) continue
          const calleeName =
            fnNode.type === "identifier"
              ? fnNode.text
              : fnNode.type === "field_expression"
                ? fnNode.childForFieldName?.("field")?.text
                : null
          if (!calleeName) continue

          const macroDef = logMacroMap.get(calleeName)
          if (!macroDef) continue

          const argsNode = callNode.childForFieldName?.("arguments")
          if (!argsNode) continue
          const argTexts: string[] = []
          for (let i = 0; i < argsNode.childCount; i++) {
            const child = argsNode.child(i)
            if (!child || child.type === "(" || child.type === ")" || child.type === ",") continue
            argTexts.push(child.text.trim())
          }

          const formatStr = argTexts[macroDef.formatArgIndex]
          const template = formatStr
            ? formatStr
                .replace(/^"(.*)"$/, "$1")
                .replace(/^'(.*)'$/, "$1")
                .slice(0, 200)
            : calleeName

          const callLine = callNode.startPosition?.row ?? 0
          let enclosingFn = "(file-scope)"
          for (const fn of fnRanges) {
            if (callLine >= fn.startLine && callLine <= fn.endLine) {
              enclosingFn = fn.name
              break
            }
          }

          let subsystem = macroDef.subsystem ?? null
          if (!subsystem && template) {
            const m = template.match(/^([A-Z][A-Z0-9_]{1,8})\s*:/)
            if (m) subsystem = m[1]
          }

          edges.push({
            enclosingFn,
            calleeName,
            callLine,
            level: macroDef.level,
            template,
            subsystem,
            macro: calleeName,
            file,
          })
        }
        return edges
      }) ?? []

    for (const e of logEdges) {
      yield ctx.edge({
        payload: {
          edgeKind: "logs_event",
          srcSymbolName: e.enclosingFn,
          dstSymbolName: `log:${e.calleeName}:${e.callLine + 1}`,
          confidence: 0.9,
          derivation: "clangd",
          metadata: { level: e.level, template: e.template, subsystem: e.subsystem, macro: e.macro },
          evidence: { sourceKind: "file_line", location: { filePath: e.file, line: e.callLine + 1 } },
        },
      })
      ctx.metrics.count("edges.logs_event")
    }
  }
}
