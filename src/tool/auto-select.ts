/**
 * auto-select.ts
 *
 * [4] Spawn-time memory loading — auto-select relevant notes for subagent context.
 * Extracted into a separate module to avoid circular dependencies and enable
 * isolated testing without loading the full task tool chain.
 */

import * as fs from "fs/promises"
import path from "path"
import { workspaceSymbolQuery } from "@/tool/notes/indexing/client"

// ---------------------------------------------------------------------------
// Stop words — filtered from keyword extraction
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "to",
  "for",
  "in",
  "of",
  "and",
  "or",
  "with",
  "that",
  "this",
  "it",
  "be",
  "as",
  "at",
  "by",
  "from",
])

// ---------------------------------------------------------------------------
// Note folders to scan
// ---------------------------------------------------------------------------

const NOTE_FOLDERS = [
  "atomic",
  "module",
  "architecture",
  "data",
  "derived",
  "decision",
  "flow",
  "skill",
  "thinking",
  "foundation",
]

// ---------------------------------------------------------------------------
// Type preference table — maps todo type to preferred note folder prefixes
// ---------------------------------------------------------------------------

const TYPE_PREFERENCE: Record<string, string[]> = {
  explore: ["architecture", "derived"],
  design: ["architecture", "derived"],
  impl: ["module", "derived"],
  fix: ["module", "derived"],
  refactor: ["module", "derived"],
  test: ["module", "derived"],
  docs: ["atomic", "skill"],
  learn: ["atomic", "skill"],
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AutoSelectOptions {
  todoItem: string
  todoType: string
  taskNoteTags: string[]
  notesRoot: string
  maxNotes?: number
}

export interface AutoSelectedNote {
  link: string
  score: number
  autoSelected: boolean
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function extractKeywords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[\s\W]+/)
      .filter((w) => w.length >= 4 && !STOP_WORDS.has(w)),
  )
}

interface Candidate {
  link: string
  fp: string
  folder: string
}

async function scanFolders(root: string): Promise<Candidate[]> {
  const candidates: Candidate[] = []
  for (const folder of NOTE_FOLDERS) {
    const dir = path.join(root, folder)
    const entries = await fs.readdir(dir).catch(() => [] as string[])
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue
      const name = entry.replace(/\.md$/, "")
      const link = `${folder}/${name}`
      const fp = path.join(dir, entry)
      candidates.push({ link, fp, folder })
    }
  }
  return candidates
}

async function readNoteTags(fp: string): Promise<string[]> {
  const text = await fs.readFile(fp, "utf8").catch(() => null)
  if (!text) return []
  const tagsMatch = text.match(/^tags:\s*\n((?:\s+-\s+.+\n)*)/m)
  return (
    tagsMatch?.[1]
      ?.split("\n")
      .map((l) => l.replace(/^\s+-\s+/, "").trim())
      .filter(Boolean) ?? []
  )
}

// ---------------------------------------------------------------------------
// autoSelectNotes
// ---------------------------------------------------------------------------

/**
 * Auto-select relevant notes for spawn-time memory loading.
 *
 * Strategy:
 *   1. Try LSP workspaceSymbolQuery to get symbol-level candidates.
 *   2. Fall back to folder scan if LSP returns nothing.
 *   3. Score every candidate with fzf scoring + type-preference + tag-overlap.
 *
 * Returns top maxNotes candidates sorted by score descending.
 * On any error returns [] — graceful fallback preserves existing behavior.
 */
export async function autoSelectNotes(opts: AutoSelectOptions): Promise<AutoSelectedNote[]> {
  const { todoItem, todoType, taskNoteTags, notesRoot: root, maxNotes = 3 } = opts
  try {
    const keywords = extractKeywords(todoItem)
    if (keywords.size === 0) return []

    const preferred = new Set(TYPE_PREFERENCE[todoType] ?? [])

    // 1. Try LSP workspace symbols
    let lspLinks: string[] = []
    try {
      const symbols = await workspaceSymbolQuery(todoItem)
      if (symbols.length > 0) {
        lspLinks = symbols.map((s) => {
          // Convert URI to a vault-relative link if possible
          const uri = s.location.uri.replace(/^file:\/\//, "")
          const rel = path.relative(root, uri).replace(/\.md$/, "")
          return rel
        })
      }
    } catch {
      // LSP unavailable — fall through to folder scan
    }

    // 2. Collect folder-scan candidates
    const folderCandidates = await scanFolders(root)

    // 3. Merge: LSP links + folder candidates (dedup by link)
    const seen = new Set<string>()
    const allCandidates: Candidate[] = []

    // Add LSP-derived candidates first (they get a head start in scoring)
    for (const link of lspLinks) {
      if (seen.has(link)) continue
      seen.add(link)
      const folder = link.split("/")[0]
      const fp = path.join(root, link + ".md")
      allCandidates.push({ link, fp, folder })
    }

    // Add folder-scan candidates
    for (const c of folderCandidates) {
      if (seen.has(c.link)) continue
      seen.add(c.link)
      allCandidates.push(c)
    }

    // 4. Score all candidates
    const scored: AutoSelectedNote[] = []

    for (const { link, fp, folder } of allCandidates) {
      // Title match: +1 if any keyword appears in the note filename
      const name = link.split("/").pop() ?? ""
      const nameLower = name.toLowerCase()
      const titleMatch = Array.from(keywords).some((kw) => nameLower.includes(kw)) ? 1 : 0

      // Type preference signal
      let typePreference = 0
      if (preferred.has(folder)) typePreference += 1
      for (const pref of Array.from(preferred)) {
        if (name.startsWith(pref + "-") || name.includes("-" + pref + "-")) {
          typePreference += 1
          break
        }
      }

      // Tag overlap signal
      const tags = await readNoteTags(fp)
      let tagOverlap = 0
      for (const tag of tags) {
        const tagWords = tag.toLowerCase().split(/[\/\-_]+/)
        for (const tw of tagWords) {
          if (tw.length >= 4 && keywords.has(tw)) {
            tagOverlap++
            break
          }
        }
      }

      // Task note tag overlap
      let taskTagOverlap = 0
      for (const tag of taskNoteTags) {
        if (tags.includes(tag)) {
          taskTagOverlap++
          break
        }
      }

      const score = titleMatch * 3 + typePreference * 3 + tagOverlap * 2 + taskTagOverlap * 1

      if (score > 0) {
        scored.push({ link, score, autoSelected: true })
      }
    }

    // Sort descending by score, return top maxNotes
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, maxNotes)
  } catch {
    return []
  }
}
