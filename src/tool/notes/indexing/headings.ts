import { pathToFileURL } from "url"
import { LSP } from "@/provider/lsp"
import type { Heading } from "@/tool/notes/types"
import { readLines } from "@/tool/notes/io"
import { toAnchor } from "@/tool/notes/headings"
import { hasLsp, touch } from "@/tool/notes/indexing/client"

// ---------------------------------------------------------------------------
// LSP-backed heading reader.
//
// Calls textDocument/documentSymbol on the file and walks the returned symbol
// tree to extract H1..H6 headings with their line numbers and anchors.
// Falls back to plain markdown parsing only when no LSP is connected (the
// caller — see ops-read.ts — handles that fallback).
// ---------------------------------------------------------------------------

export function linesToHeading(lines: string[], line: number, name: string): Heading | undefined {
  const text = lines[line]
  if (!text) return
  const head = text.match(/^(#{1,6})\s+(.*)$/)
  if (!head) return
  const value = (head[2] || "").trim() || name.trim()
  return {
    level: head[1].length,
    text: value,
    anchor: toAnchor(value),
    line: line + 1,
  }
}

export function flatSymbol(list: any[], out: any[] = []) {
  for (const item of list) {
    if (!item) continue
    out.push(item)
    if (Array.isArray(item.children)) flatSymbol(item.children, out)
  }
  return out
}

export async function readLspHeadings(fp: string): Promise<Heading[]> {
  if (!(await hasLsp(fp))) return []
  await touch(fp)
  const lines = await readLines(fp)
  const uri = pathToFileURL(fp).href
  const symbols = await LSP.documentSymbol(uri).catch(() => [])
  const out = flatSymbol(symbols)
    .map((item) => {
      const line = item.range?.start?.line ?? item.location?.range?.start?.line
      const name = typeof item.name === "string" ? item.name : ""
      if (typeof line !== "number") return
      return linesToHeading(lines, line, name)
    })
    .filter((x): x is Heading => Boolean(x))

  const map = new Map<number, Heading>()
  for (const item of out) map.set(item.line, item)
  return [...map.values()].sort((a, b) => a.line - b.line)
}
