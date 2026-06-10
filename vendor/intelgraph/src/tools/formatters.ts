/**
 * formatters.ts — Human-readable response formatters for IntelGraph tools.
 *
 * All format* functions are pure: they take raw LSP results and return strings.
 * No backend state dependencies.
 */

import { SYMBOL_KIND, HIGHLIGHT_KIND, FOLD_KIND, displayPath, fmtLocation } from "./schemas.js"
import type { LspDiagnostic } from "../lsp/ports.js"
import { formatReasonChainText } from "./reason-engine/format-reason-chain.js"

export function formatHover(result: any): string {
  if (!result) return "No hover information available."
  const content = result.contents
  if (typeof content === "string") return content
  if (content?.value) return content.value
  if (Array.isArray(content)) {
    return content.map((c: any) => (typeof c === "string" ? c : (c?.value ?? ""))).join("\n")
  }
  return "No hover information available."
}

export function formatDefinition(results: any[], root: string, label = "Definition"): string {
  if (!results.length) return `No ${label.toLowerCase()} found.`
  return results.map((r: any) => `${label}: ${fmtLocation(r, root)}`).join("\n")
}

export function formatReferences(results: any[], root: string): string {
  if (!results.length) return "No references found."
  const lines = results.map((r: any) => `  ${fmtLocation(r, root)}`)
  return `References (${results.length}):\n${lines.join("\n")}`
}

export function formatDocumentSymbol(results: any[]): string {
  if (!results.length) return "No symbols found."
  function renderSymbol(sym: any, indent = 0): string {
    const prefix = "  ".repeat(indent)
    const kind = SYMBOL_KIND[sym.kind] ?? `Kind(${sym.kind})`
    const detail = sym.detail ? ` — ${sym.detail}` : ""
    const line = sym.range?.start?.line != null ? `:${sym.range.start.line + 1}` : ""
    let out = `${prefix}[${kind}] ${sym.name}${detail}${line}`
    if (sym.children?.length) {
      out += "\n" + sym.children.map((c: any) => renderSymbol(c, indent + 1)).join("\n")
    }
    return out
  }
  return results.map((s: any) => renderSymbol(s)).join("\n")
}

export function formatWorkspaceSymbol(results: any[], root: string): string {
  if (!results.length) return "No symbols found."
  return results
    .map((s: any) => {
      const kind = SYMBOL_KIND[s.kind] ?? `Kind(${s.kind})`
      return `[${kind}] ${s.name}  ${fmtLocation(s.location, root)}`
    })
    .join("\n")
}

export function formatIncomingCalls(results: any[], root: string): string {
  if (!results.length) return "No incoming calls."
  return results
    .map((call: any) => {
      const from = call.from ?? call.caller
      const kind = SYMBOL_KIND[from?.kind] ?? "?"
      const loc = fmtLocation({ uri: from?.uri, range: from?.selectionRange ?? from?.range }, root)
      return `  <- [${kind}] ${from?.name ?? "(unknown)"}  at ${loc}`
    })
    .join("\n")
}

export function formatOutgoingCalls(results: any[], root: string): string {
  if (!results.length) return "No outgoing calls."
  return results
    .map((call: any) => {
      const to = call.to ?? call.callee
      const kind = SYMBOL_KIND[to?.kind] ?? "?"
      const loc = fmtLocation({ uri: to?.uri, range: to?.selectionRange ?? to?.range }, root)
      return `  -> [${kind}] ${to?.name ?? "(unknown)"}  at ${loc}`
    })
    .join("\n")
}

export function formatTypeHierarchy(results: any[], root: string, arrow: string): string {
  if (!results.length) return `No ${arrow === "↑" ? "supertypes" : "subtypes"} found.`
  return results
    .map((item: any) => {
      const kind = SYMBOL_KIND[item.kind] ?? "?"
      const loc = fmtLocation({ uri: item.uri, range: item.selectionRange ?? item.range }, root)
      return `  ${arrow} [${kind}] ${item.name}  at ${loc}`
    })
    .join("\n")
}

export function formatDiagnostics(diagMap: Map<string, LspDiagnostic[]>, root: string): string {
  const lines: string[] = []
  for (const [filePath, diags] of diagMap.entries()) {
    if (!diags.length) continue
    lines.push(`${displayPath(filePath, root)}:`)
    for (const d of diags) {
      const severityMap: Record<number, string> = { 1: "ERROR", 2: "WARN", 3: "INFO", 4: "HINT" }
      const sev = severityMap[d.severity ?? 1] ?? "ERROR"
      const line = d.range?.start?.line != null ? d.range.start.line + 1 : "?"
      const col = d.range?.start?.character != null ? d.range.start.character + 1 : "?"
      lines.push(`  ${sev} [${line}:${col}] ${d.message}`)
    }
  }
  return lines.length ? lines.join("\n") : "No diagnostics."
}

export function formatCodeAction(results: any[]): string {
  if (!results.length) return "No code actions available."
  return results
    .map((action: any) => {
      const kind = action.kind ? ` [${action.kind}]` : ""
      const disabled = action.disabled ? ` (disabled: ${action.disabled.reason})` : ""
      return `* ${action.title}${kind}${disabled}`
    })
    .join("\n")
}

export function formatDocumentHighlight(results: any[], filePath: string, root: string): string {
  if (!results.length) return "No highlights found."
  const rel = displayPath(filePath, root)
  return results
    .map((h: any) => {
      const kind = HIGHLIGHT_KIND[h.kind ?? 1] ?? "text"
      const line = h.range?.start?.line != null ? h.range.start.line + 1 : "?"
      const col = h.range?.start?.character != null ? h.range.start.character + 1 : "?"
      const eline = h.range?.end?.line != null ? h.range.end.line + 1 : "?"
      const ecol = h.range?.end?.character != null ? h.range.end.character + 1 : "?"
      return `  [${kind}] ${rel}:${line}:${col} – ${eline}:${ecol}`
    })
    .join("\n")
}

export function formatFoldingRange(results: any[], filePath: string, root: string): string {
  if (!results.length) return "No folding ranges found."
  const rel = displayPath(filePath, root)
  return results
    .map((r: any) => {
      const kind = r.kind ? ` (${FOLD_KIND[r.kind] ?? r.kind})` : ""
      const start = (r.startLine ?? 0) + 1
      const end = (r.endLine ?? 0) + 1
      return `  ${rel}:${start}–${end}${kind}`
    })
    .join("\n")
}

export function formatSignatureHelp(result: any): string {
  if (!result?.signatures?.length) return "No signature help available."
  const active = result.activeSignature ?? 0
  const lines: string[] = []
  result.signatures.forEach((sig: any, i: number) => {
    const marker = i === active ? "▶" : " "
    lines.push(`${marker} ${sig.label}`)
    if (sig.documentation) {
      const doc = typeof sig.documentation === "string" ? sig.documentation : (sig.documentation?.value ?? "")
      if (doc) lines.push(`  ${doc}`)
    }
    if (sig.parameters?.length) {
      const activeParam = result.activeParameter ?? sig.activeParameter ?? 0
      sig.parameters.forEach((p: any, pi: number) => {
        const pmarker = pi === activeParam && i === active ? "  → " : "    "
        const label =
          typeof p.label === "string" ? p.label : Array.isArray(p.label) ? sig.label.slice(p.label[0], p.label[1]) : ""
        const pdoc = typeof p.documentation === "string" ? p.documentation : (p.documentation?.value ?? "")
        lines.push(`${pmarker}param[${pi}]: ${label}${pdoc ? ` — ${pdoc}` : ""}`)
      })
    }
  })
  return lines.join("\n")
}

export function formatRename(workspaceEdit: any, root: string): string {
  if (!workspaceEdit) return "Rename not possible at this position."
  const lines: string[] = ["Rename would change:"]
  // documentChanges (preferred)
  if (workspaceEdit.documentChanges?.length) {
    for (const change of workspaceEdit.documentChanges) {
      const file = displayPath(change.textDocument?.uri ?? "", root)
      const edits = change.edits ?? []
      lines.push(`  ${file}: ${edits.length} edit(s)`)
      for (const e of edits) {
        const line = e.range?.start?.line != null ? e.range.start.line + 1 : "?"
        const col = e.range?.start?.character != null ? e.range.start.character + 1 : "?"
        lines.push(`    line ${line}:${col} → "${e.newText}"`)
      }
    }
  } else if (workspaceEdit.changes) {
    // flat changes map
    for (const [uri, edits] of Object.entries(workspaceEdit.changes as Record<string, any[]>)) {
      const file = displayPath(uri, root)
      lines.push(`  ${file}: ${edits.length} edit(s)`)
      for (const e of edits) {
        const line = e.range?.start?.line != null ? e.range.start.line + 1 : "?"
        const col = e.range?.start?.character != null ? e.range.start.character + 1 : "?"
        lines.push(`    line ${line}:${col} → "${e.newText}"`)
      }
    }
  } else {
    lines.push("  (no changes)")
  }
  return lines.join("\n")
}

export function formatFormat(edits: any[], filePath: string, root: string): string {
  if (!edits.length) return "No formatting changes needed."
  const rel = displayPath(filePath, root)
  return (
    `${rel}: ${edits.length} formatting edit(s)\n` +
    edits
      .slice(0, 10)
      .map((e: any) => {
        const sl = e.range?.start?.line != null ? e.range.start.line + 1 : "?"
        const el = e.range?.end?.line != null ? e.range.end.line + 1 : "?"
        const preview = e.newText.slice(0, 60).replace(/\n/g, "↵")
        return `  lines ${sl}–${el}: "${preview}${e.newText.length > 60 ? "…" : ""}"`
      })
      .join("\n") +
    (edits.length > 10 ? `\n  … and ${edits.length - 10} more` : "")
  )
}

export function formatInlayHints(hints: any[], filePath: string, root: string): string {
  if (!hints.length) return "No inlay hints in this range."
  const rel = displayPath(filePath, root)
  return hints
    .map((h: any) => {
      const line = h.position?.line != null ? h.position.line + 1 : "?"
      const col = h.position?.character != null ? h.position.character + 1 : "?"
      const label = Array.isArray(h.label)
        ? h.label.map((p: any) => (typeof p === "string" ? p : (p.value ?? ""))).join("")
        : String(h.label ?? "")
      const kind = h.kind === 1 ? "type" : h.kind === 2 ? "param" : "hint"
      return `  [${kind}] ${rel}:${line}:${col}  ${label}`
    })
    .join("\n")
}

export function formatReasonChain(
  result: {
    reasonPaths: import("./reason-engine/contracts.js").ReasonPath[]
    usedLlm: boolean
    rejected: number
    cacheHit: boolean
    cacheMismatchedFiles: string[]
  },
  symbol: string,
  filePath: string,
  root: string,
): string {
  return formatReasonChainText(result, symbol, filePath, (p) => displayPath(p, root))
}

export function formatIntelligenceResponse(
  res: import("../intelligence/contracts/query-request.js").NormalizedQueryResponse,
): string {
  const lines: string[] = []
  lines.push(`Intent:    ${res.intent}`)
  lines.push(`Status:    ${res.status}`)
  lines.push(`Provenance: ${res.provenance.path}`)
  if (res.provenance.deterministicAttempts.length > 0) {
    lines.push(`Enrichers: ${res.provenance.deterministicAttempts.join(", ")}`)
  }
  if (res.provenance.llmUsed) lines.push("LLM:       used (last resort)")
  lines.push("")

  if (res.status === "error" || res.status === "not_found") {
    if (res.errors?.length) lines.push(`Errors: ${res.errors.join("; ")}`)
    else lines.push("No results found.")
    return lines.join("\n")
  }

  const nodes = res.data.nodes
  if (nodes.length === 0) {
    lines.push("No results found.")
    return lines.join("\n")
  }

  if (
    res.intent === "find_module_summary" ||
    res.intent === "find_class_summary" ||
    res.intent === "find_type_summary" ||
    res.intent === "find_api_summary" ||
    res.intent === "find_entity_summary" ||
    res.intent === "find_workspace_health"
  ) {
    const row = nodes[0] ?? {}
    lines.push(`Summary: ${String((row as { canonical_name?: unknown }).canonical_name ?? "(unknown)")}`)
    for (const [k, v] of Object.entries(row)) {
      if (
        k === "canonical_name" ||
        k === "kind" ||
        k === "caller" ||
        k === "callee" ||
        k === "edge_kind" ||
        k === "confidence" ||
        k === "derivation"
      ) {
        continue
      }
      if (v != null && v !== "") lines.push(`  ${k}: ${JSON.stringify(v)}`)
    }
    return lines.join("\n")
  }

  if (
    res.intent === "analyze_problematic_modules" ||
    res.intent === "analyze_god_classes" ||
    res.intent === "analyze_type_health" ||
    res.intent === "analyze_dead_code" ||
    res.intent === "suggest_refactors" ||
    res.intent === "generate_health_report" ||
    res.intent === "generate_action_plan" ||
    res.intent === "compare_snapshots"
  ) {
    lines.push(`Results (${nodes.length}):`)
    for (const node of nodes.slice(0, 50)) {
      const name = String((node as { canonical_name?: unknown }).canonical_name ?? "")
      const parts: string[] = [`  ${name}`]
      for (const [k, v] of Object.entries(node)) {
        if (k === "canonical_name" || k === "kind" || v == null || v === "") continue
        parts.push(`    ${k}: ${JSON.stringify(v)}`)
      }
      lines.push(parts.join("\n"))
    }
    if (nodes.length > 50) lines.push(`  ... and ${nodes.length - 50} more`)
    return lines.join("\n")
  }

  lines.push(`Results (${nodes.length}):`)
  for (const node of nodes.slice(0, 50)) {
    const parts: string[] = []
    for (const [k, v] of Object.entries(node)) {
      if (v != null && v !== "") parts.push(`${k}=${JSON.stringify(v)}`)
    }
    lines.push(`  ${parts.join("  ")}`)
  }
  if (nodes.length > 50) lines.push(`  ... and ${nodes.length - 50} more`)

  if (res.data.edges.length > 0) {
    lines.push("", `Edges (${res.data.edges.length}):`)
    for (const e of res.data.edges.slice(0, 20)) {
      lines.push(`  ${JSON.stringify(e)}`)
    }
  }

  return lines.join("\n")
}
