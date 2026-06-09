import type { Frontmatter } from "@/tool/notes/types"

// ---------------------------------------------------------------------------
// Helpers — frontmatter parse/serialize (pure, no file I/O)
// ---------------------------------------------------------------------------

export function parseFrontmatter(lines: string[]): { fm: Frontmatter; bodyStart: number } {
  if (lines[0]?.trim() !== "---") return { fm: {}, bodyStart: 0 }
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i
      break
    }
  }
  if (end === -1) return { fm: {}, bodyStart: 0 }

  const fm: Frontmatter = {}
  let i = 1
  while (i < end) {
    const line = lines[i]
    const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/)
    if (!kv) {
      i++
      continue
    }
    const key = kv[1]
    const val = kv[2].trim()
    if (val === "" || val === "|" || val === ">") {
      const items: string[] = []
      i++
      while (i < end && /^\s+-\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s+-\s+/, "").trim())
        i++
      }
      fm[key] = items
    } else {
      fm[key] = val
      i++
    }
  }
  return { fm, bodyStart: end + 1 }
}

export function serializeFrontmatter(fm: Frontmatter): string[] {
  const lines = ["---"]
  for (const [k, v] of Object.entries(fm)) {
    if (v === undefined || v === null) continue
    if (Array.isArray(v)) {
      if (v.length === 0) continue
      lines.push(`${k}:`)
      for (const item of v) lines.push(`  - ${item}`)
    } else {
      lines.push(`${k}: ${v}`)
    }
  }
  lines.push("---")
  return lines
}
