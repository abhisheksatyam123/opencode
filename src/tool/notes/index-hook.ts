import * as fs from "fs/promises"
import * as path from "path"
import { existsSync } from "fs"
import { parseFrontmatter } from "@/tool/notes/frontmatter"
import { parseBlockRefs, parseHeadings, buildIndexLines } from "@/tool/notes/headings"
import { rootBase } from "@/tool/notes/paths"

const MARKDOWN_EXTENSIONS = new Set([".md", ".mdx", ".markdown"])
const MAX_INDEX_PASSES = 8

export type MarkdownNoteIndexResult =
  | { indexed: true; changed: boolean; file: string }
  | { indexed: false; changed: false; file: string; reason: string }

function isMarkdownFile(fp: string) {
  return MARKDOWN_EXTENSIONS.has(path.extname(fp).toLowerCase())
}

function isInside(child: string, parent: string) {
  const rel = path.relative(parent, child)
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel))
}

function autoIndexScope(fp: string): { ok: true } | { ok: false; reason: string } {
  const file = path.resolve(fp)
  const root = path.resolve(rootBase())
  if (!isInside(file, root)) return { ok: false, reason: "outside-scope" }
  const atomicAgentRoot = path.join(root, "atomic", "agents")
  if (isInside(file, atomicAgentRoot)) return { ok: false, reason: "atomic-agents" }
  return { ok: true }
}

export function shouldAutoIndexMarkdownNote(fp: string) {
  const file = path.resolve(fp)
  if (!isMarkdownFile(file)) return false
  return autoIndexScope(file).ok
}

function locateIndexBlock(lines: string[]) {
  let start = -1
  let end = -1
  for (let i = 0; i < lines.length; i++) {
    if (!/^## Index\s*$/.test(lines[i])) continue
    start = i
    end = lines.length
    for (let j = i + 1; j < lines.length; j++) {
      if (/^##\s+/.test(lines[j])) {
        end = j
        break
      }
    }
    break
  }
  return start >= 0 ? { start, end } : undefined
}

function stripIndexBlock(lines: string[]) {
  const block = locateIndexBlock(lines)
  if (!block) return lines.slice()
  const next = lines.slice()
  next.splice(block.start, block.end - block.start)
  while (block.start < next.length && next[block.start]?.trim() === "" && next[block.start - 1]?.trim() === "") {
    next.splice(block.start, 1)
  }
  return next
}

function indexInsertPosition(lines: string[]) {
  const { bodyStart } = parseFrontmatter(lines)
  let pos = bodyStart
  while (pos < lines.length && lines[pos]?.trim() === "") pos++
  if (pos < lines.length && /^#\s+/.test(lines[pos] ?? "")) pos++
  while (pos < lines.length && lines[pos]?.trim() === "") pos++
  return pos
}

function withIndexBlock(lines: string[], indexLines: string[]) {
  const base = stripIndexBlock(lines)
  const pos = indexInsertPosition(base)
  const block = ["## Index", "", ...indexLines, ""]
  const next = base.slice()
  next.splice(pos, 0, ...block)
  return next
}

export function buildMarkdownNoteWithIndex(lines: string[]) {
  let next = withIndexBlock(lines, [])
  for (let pass = 0; pass < MAX_INDEX_PASSES; pass++) {
    const indexLines = buildIndexLines(parseHeadings(next), parseBlockRefs(next), 4)
    const candidate = withIndexBlock(next, indexLines)
    if (candidate.join("\n") === next.join("\n")) return candidate
    next = candidate
  }
  return next
}

export async function ensureMarkdownNoteIndex(fp: string): Promise<MarkdownNoteIndexResult> {
  const file = path.resolve(fp)
  if (!isMarkdownFile(file)) return { indexed: false, changed: false, file, reason: "not-markdown" }
  if (!existsSync(file)) return { indexed: false, changed: false, file, reason: "missing" }
  const scope = autoIndexScope(file)
  if (!scope.ok) return { indexed: false, changed: false, file, reason: scope.reason }

  const before = await fs.readFile(file, "utf8")
  const trailingNewline = before.endsWith("\n")
  const normalized = before.replace(/\r\n/g, "\n")
  const lines = normalized.split("\n")
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()

  const after = buildMarkdownNoteWithIndex(lines).join("\n") + (trailingNewline ? "\n" : "")
  if (after === normalized) return { indexed: true, changed: false, file }
  await fs.writeFile(file, after, "utf8")
  return { indexed: true, changed: true, file }
}
