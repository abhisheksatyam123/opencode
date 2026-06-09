import * as path from "path"
import { cleanPath } from "@/tool/notes/paths"
import { nonFencedLines, stripInlineCode } from "@/tool/notes/headings"

// ---------------------------------------------------------------------------
// Helpers — tag helpers + wiki link helpers (pure, no file I/O)
// ---------------------------------------------------------------------------

export function defaultTags(rel: string): string[] {
  const clean = cleanPath(rel)
  const parts = clean.split("/").filter(Boolean)
  const type = parts[0] ?? ""
  const name = parts.slice(1).join("/")
  const base = path.basename(name || clean)

  if (type === "task") return [`task/${base.replace(/^todo-/, "") || base}`, "status/active"]
  if (type === "atomic") return [`atomic/${base}`, "status/wip"]
  if (type === "derived") return [`derived/${base}`, "status/wip"]
  if (type === "thinking") return [`thinking/${base}`, "status/wip"]
  if (type === "foundation") return [`foundation/${base}`, "status/stable"]
  // legacy
  if (type === "module") return [`module/${base}`, "status/wip"]
  if (type === "architecture") return [`architecture/${base}`, "status/wip"]
  if (type === "concept") return [`concept/${base}`, "status/wip"]
  if (type === "skill") return [`skill/${base}`, "status/wip"]
  return ["status/wip"]
}

export function scanInlineTags(lines: string[], bodyStart: number): string[] {
  const tags = new Set<string>()
  for (const { line: l } of nonFencedLines(lines, bodyStart)) {
    if (/^#{1,6}\s/.test(l)) continue
    const matches = stripInlineCode(l).matchAll(/#([a-zA-Z_][a-zA-Z0-9_\-/]*)/g)
    for (const m of matches) tags.add(m[1])
  }
  return [...tags]
}

export function tagMatches(noteTag: string, filterTag: string): boolean {
  const n = noteTag.toLowerCase()
  const f = filterTag.toLowerCase()
  return n === f || n.startsWith(f + "/")
}

export function noteHasTags(noteTags: string[], filterTags: string[]): boolean {
  return filterTags.every((ft) => noteTags.some((nt) => tagMatches(nt, ft)))
}

export function cleanTag(v: string) {
  return v
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replace(/^#+/, "")
}

export function readTags(v: unknown): string[] {
  if (Array.isArray(v)) {
    return [
      ...new Set(
        v
          .filter((x): x is string => typeof x === "string")
          .map(cleanTag)
          .filter(Boolean),
      ),
    ]
  }
  if (typeof v !== "string") return []
  const t = v.trim()
  if (!t) return []
  if (t.startsWith("[") && t.endsWith("]")) {
    return [...new Set(t.slice(1, -1).split(",").map(cleanTag).filter(Boolean))]
  }
  return [...new Set(t.split(",").map(cleanTag).filter(Boolean))]
}

export function scanWiki(lines: string[], bodyStart: number) {
  const out: { raw: string; line: number }[] = []
  for (const { line, i } of nonFencedLines(lines, bodyStart)) {
    const found = stripInlineCode(line).matchAll(/\[\[([^[\]]+)\]\]/g)
    for (const m of found) out.push({ raw: m[1].trim(), line: i + 1 })
  }
  return out
}

export function skipWiki(raw: string) {
  if (raw.startsWith("#")) return true
  const base = raw.split("|")[0].trim()
  const note = base.split("#")[0].trim()
  if (!note) return true
  if (note.includes("<") || note.includes(">")) return true
  if (note.includes("...")) return true
  return false
}

export function splitWiki(raw: string) {
  const base = raw.split("|")[0].trim()
  const idx = base.indexOf("#")
  if (idx < 0) {
    return {
      note: cleanPath(base),
      anchor: "",
    }
  }
  return {
    note: cleanPath(base.slice(0, idx)),
    anchor: base.slice(idx + 1).trim(),
  }
}

/**
 * Scan lines for cross-note markdown links: [text](doc/path) or [text](doc/path#anchor)
 * Returns only doc/-prefixed links (absolute vault paths).
 * Skips lines inside code fences.
 */
export function scanMarkdownLinks(
  lines: string[],
  bodyStart: number,
): { href: string; text: string; notePath: string; anchor: string; line: number }[] {
  const out: { href: string; text: string; notePath: string; anchor: string; line: number }[] = []
  for (const { line, i } of nonFencedLines(lines, bodyStart)) {
    const found = stripInlineCode(line).matchAll(/\[([^\]]*)\]\((doc\/[^)]*)\)/g)
    for (const m of found) {
      const href = m[2].trim()
      if (skipMarkdownLink(href)) continue
      const { notePath, anchor } = splitMarkdownLink(href)
      out.push({ href, text: m[1], notePath, anchor, line: i + 1 })
    }
  }
  return out
}

/**
 * Returns true if the markdown link href should be skipped.
 * Skips: external URLs, same-note-only anchors, empty hrefs.
 */
export function skipMarkdownLink(href: string): boolean {
  if (!href) return true
  if (/^https?:\/\/|^mailto:/i.test(href)) return true
  if (href.startsWith("#")) return true
  return false
}

/**
 * Split a doc/-prefixed href into notePath + anchor.
 * "project/module/foo#Data-flow" → { notePath: "project/module/foo", anchor: "Data-flow" }
 * "project/module/foo"           → { notePath: "project/module/foo", anchor: "" }
 */
export function splitMarkdownLink(href: string): { notePath: string; anchor: string } {
  // strip leading doc/
  const withoutDoc = href.startsWith("doc/") ? href.slice(4) : href
  const idx = withoutDoc.indexOf("#")
  if (idx < 0) return { notePath: withoutDoc, anchor: "" }
  return { notePath: withoutDoc.slice(0, idx), anchor: withoutDoc.slice(idx + 1) }
}
