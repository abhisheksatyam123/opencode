import type { Heading, BlockRef } from "@/tool/notes/types"
import { NEED } from "@/tool/notes/types"
import { cleanPath } from "@/tool/notes/paths"

// ---------------------------------------------------------------------------
// Helpers — heading/block-ref parsing, index building, section helpers
// ---------------------------------------------------------------------------

export function toAnchor(text: string) {
  return text
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}

export function stripInlineCode(line: string) {
  return line.replace(/`[^`]*`/g, "")
}

/** Yield `{ line, i }` for every line not inside a fenced code block. */
export function* nonFencedLines(lines: string[], start = 0): Generator<{ line: string; i: number }> {
  let fence = false
  for (let i = start; i < lines.length; i++) {
    if (/^```|^~~~/.test(lines[i])) {
      fence = !fence
      continue
    }
    if (!fence) yield { line: lines[i], i }
  }
}

export function parseHeadings(lines: string[]): Heading[] {
  const out: Heading[] = []
  for (const { line: l, i } of nonFencedLines(lines)) {
    if (/^>\s*\[!/.test(l)) continue
    if (/^>/.test(l)) continue
    const m = l.match(/^(#{1,6})\s+(.+?)(?:\s+#+\s*)?$/)
    if (!m) continue
    out.push({ level: m[1].length, text: m[2].trim(), anchor: toAnchor(m[2].trim()), line: i + 1 })
  }
  return out
}

export function parseBlockRefs(lines: string[]): BlockRef[] {
  const out: BlockRef[] = []
  for (const { line, i } of nonFencedLines(lines)) {
    const m = line.match(/\s\^([a-zA-Z0-9-]+)\s*$/) || line.match(/^\^([a-zA-Z0-9-]+)\s*$/)
    if (m) out.push({ id: m[1], line: i + 1 })
  }
  return out
}

export function buildIndexLines(headings: Heading[], blockRefs: BlockRef[], depth: number): string[] {
  const body = headings.filter((h) => h.level >= 2 && h.level <= depth)
  if (body.length === 0 && blockRefs.length === 0) return []
  const min = body.length > 0 ? Math.min(...body.map((h) => h.level)) : 2
  const lines: string[] = []
  for (const h of body) {
    lines.push(`${"  ".repeat(h.level - min)}- [${h.text}](#${h.anchor}) — L${h.line}`)
  }
  if (depth >= 4) {
    for (const b of blockRefs) {
      lines.push(`    - [^${b.id}](#^${b.id}) — L${b.line}`)
    }
  }
  return lines
}

export function hasH2(headings: Heading[], section: string) {
  const low = section.toLowerCase()
  return headings.some((h) => h.level === 2 && h.text.toLowerCase() === low)
}

export function sectionSlice(lines: string[], headings: Heading[], section: string) {
  const low = section.toLowerCase()
  const head = headings.find((h) => h.level === 2 && h.text.toLowerCase() === low)
  if (!head) return { line: 1, body: [] as string[] }
  let end = lines.length
  for (const h of headings) {
    if (h.level !== 2) continue
    if (h.line <= head.line) continue
    end = h.line - 1
    break
  }
  return { line: head.line, body: lines.slice(head.line, end) }
}

// Map a logical doc/-relative path to the note kind that drives schema and
// audit. The vault has both top-level atom kinds (`atomic/...`, `concept/...`)
// and nested kinds inside subfolders (`atomic/concept/...`, `atomic/skill/...`).
// The order of checks below mirrors retrieval priority: nested → top-level →
// project-shape → holistic surface.
export function noteKind(rel: string): keyof typeof NEED | "" {
  const parts = cleanPath(rel).split("/").filter(Boolean)
  if (!parts.length) return ""

  // Nested atomic subfolder: atomic/concept/X, atomic/skill/Y, etc.
  if (parts[0] === "atomic" && parts.length > 1) {
    const inner = parts[1]
    if (inner in NEED) return inner as keyof typeof NEED
    return "atomic"
  }

  // Canonical project-rooted shape: project/software/<project>/<kind>/<name>
  // Some callsites pass this full path (or a normalized variant containing it).
  const projectRootIx = parts.findIndex((p, i) => p === "project" && parts[i + 1] === "software")
  if (projectRootIx >= 0) {
    const projectKind = parts[projectRootIx + 3]
    if (projectKind && projectKind in NEED) return projectKind as keyof typeof NEED
  }

  // Canonical scratchpad task shape: scratchpad/task/<project>/<state>/todo-<slug>
  const scratchIx = parts.findIndex((p, i) => p === "scratchpad" && parts[i + 1] === "task")
  if (scratchIx >= 0) return "task"

  // Top-level kind folder.
  const kind = parts[0]
  if (kind in NEED) return kind as keyof typeof NEED
  return ""
}

export function hasSignal(lines: string[]) {
  return lines.some((line) => {
    const row = line.trim()
    if (!row) return false
    if (/^(?:-|[*+]|[0-9]+\.)\s*(todo|tbd|none|n\/a)\b/i.test(row)) return false
    if (/^(todo|tbd|none|n\/a)\b/i.test(row)) return false
    return true
  })
}

export function hasWiki(lines: string[]) {
  return lines.some((line) => /\[\[[^[\]]+\]\]/.test(line))
}

/**
 * Returns true if any line contains either a [[wikilink]] or a [text](doc/...) markdown link.
 * Used by audit to check Composition, Related, Applied-in sections.
 */
export function hasLink(lines: string[]): boolean {
  if (hasWiki(lines)) return true
  return lines.some((l) => /\[[^\]]*\]\(doc\/[^)]+\)/.test(l))
}

export function hasReduceWord(line: string) {
  return /\b(reducible|irreducible|partially reducible|reduction|recompute|recomputation)\b/i.test(line)
}

export function hasAbstractWord(line: string) {
  return /\b(abstraction|abstract|pattern|reusable conclusion|stored result)\b/i.test(line)
}

export function hasToolWord(line: string) {
  return /\b(tool|workflow primitive|pattern-extractor|classifier)\b/i.test(line)
}

export function reduceSignal(lines: string[]) {
  return lines.some((line) => {
    const row = line.trim()
    if (!row) return false
    return hasReduceWord(row) || hasAbstractWord(row)
  })
}

export function flowNote(rel: string, tags: string[]) {
  if (!rel.startsWith("module/") && !rel.startsWith("architecture/")) return false
  const key = rel.replace(/^(module|architecture)\//, "").toLowerCase()
  if (key.startsWith("flow-") || key.startsWith("flow/")) return true
  if (key.includes("/flow-") || key.includes("/flow/")) return true
  return tags.some((tag) => {
    const row = tag.toLowerCase()
    return row === "flow" || row.startsWith("flow/")
  })
}

export function hasAnchor(anchor: string, section: string) {
  if (!anchor) return false
  if (anchor.toLowerCase() === section.toLowerCase()) return true
  const s = toAnchor(section)
  return anchor
    .split("#")
    .filter(Boolean)
    .some((item) => {
      if (item.startsWith("^")) return item.toLowerCase() === section.toLowerCase()
      return toAnchor(item) === s
    })
}

export interface DuplicateSectionIssue {
  heading: string // exact heading text, e.g. "## Tasks" or "### Backend"
  level: number // 1-6
  count: number // how many times it appears (≥2)
  firstLine: number // 1-indexed line of first occurrence
  lines: number[] // 1-indexed lines of ALL occurrences
}

/**
 * Scan `lines` for duplicate H2/H3 headings (outside fenced code blocks).
 * Returns one issue per heading text that appears more than once.
 * Pure function — no I/O.
 */
export function detectDuplicateSections(lines: string[]): DuplicateSectionIssue[] {
  const seen = new Map<string, { level: number; lines: number[] }>()
  for (const { line: l, i } of nonFencedLines(lines)) {
    const m = l.match(/^(#{2,3})\s+(.+?)(?:\s+#+\s*)?$/)
    if (!m) continue
    const level = m[1].length
    const text = m[2].trim()
    const key = `${"#".repeat(level)} ${text}`
    const entry = seen.get(key)
    if (entry) {
      entry.lines.push(i + 1)
    } else {
      seen.set(key, { level, lines: [i + 1] })
    }
  }
  const issues: DuplicateSectionIssue[] = []
  for (const [key, { level, lines: ls }] of seen) {
    if (ls.length < 2) continue
    issues.push({
      heading: key,
      level,
      count: ls.length,
      firstLine: ls[0],
      lines: ls,
    })
  }
  return issues
}

// ---------------------------------------------------------------------------
// Task-leaf duplicate detection (H4+ `#### [<id>] ...` headings)
// ---------------------------------------------------------------------------

export interface DuplicateTaskLeafIssue {
  /** Numeric leaf ID extracted from `#### [N] ...`, e.g. "7" */
  id: string
  /** Full heading text, e.g. "#### [7] Do the thing" */
  heading: string
  /** How many times this leaf ID appears (≥2) */
  count: number
  /** 1-indexed line of first occurrence */
  firstLine: number
  /** 1-indexed lines of ALL occurrences */
  lines: number[]
}

/**
 * Scan `lines` for duplicate task-leaf headings of the form `#### [<id>] ...`
 * (H4 or deeper, outside fenced code blocks). Returns one issue per leaf ID
 * that appears more than once.
 *
 * Matches any heading level ≥ H4 whose text starts with `[<id>]`, where id
 * supports numeric, dotted, and alphanumeric task IDs (e.g. `[1v]`, `[2.4]`, `[2.A]`).
 * Pure function — no I/O.
 */
export function detectDuplicateTaskLeaves(lines: string[]): DuplicateTaskLeafIssue[] {
  // Map from leaf id → { heading text of first occurrence, lines[] }
  const seen = new Map<string, { heading: string; lines: number[] }>()
  for (const { line: l, i } of nonFencedLines(lines)) {
    // Match H4–H6 headings whose text begins with [<id>] (numeric/dotted/alnum)
    const m = l.match(/^(#{4,6})\s+\[([0-9]+[a-zA-Z]?(?:\.[0-9A-Za-z]+)*)\]\s+(.+?)(?:\s+#+\s*)?$/)
    if (!m) continue
    const id = m[2]
    const fullHeading = `${"#".repeat(m[1].length)} [${id}] ${m[3].trim()}`
    const entry = seen.get(id)
    if (entry) {
      entry.lines.push(i + 1)
    } else {
      seen.set(id, { heading: fullHeading, lines: [i + 1] })
    }
  }
  const issues: DuplicateTaskLeafIssue[] = []
  for (const [id, { heading, lines: ls }] of seen) {
    if (ls.length < 2) continue
    issues.push({
      id,
      heading,
      count: ls.length,
      firstLine: ls[0],
      lines: ls,
    })
  }
  return issues
}
