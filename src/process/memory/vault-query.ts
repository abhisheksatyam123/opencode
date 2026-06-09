import * as fs from "fs/promises"
import path from "path"

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

export type SemanticHit = {
  path: string
  score: number
  title?: string
  snippet?: string
}

export type VaultSemanticSearch = (input: { query: string; topK: number; notesRoot: string }) => Promise<SemanticHit[]>

export type PriorWorkNote = {
  path: string
  title: string
  snippet: string
  score: number
  matched_keywords: string[]
}

export type QueryVaultNotesInput = {
  notesRoot: string
  goal: string
  systemComponents: string
  topK?: number
  alreadySelected?: string[]
  semanticSearch?: VaultSemanticSearch
}

export type QueryVaultNotesResult = {
  notes: PriorWorkNote[]
  query_keywords: string[]
  deduped_count: number
  strategy: "semantic" | "keyword" | "none"
}

function extractKeywords(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .split(/[\s\W]+/)
        .filter((w) => w.length >= 4 && !STOP_WORDS.has(w)),
    ),
  )
}

function normalizePath(input: string): string {
  return input
    .replace(/^\[\[/, "")
    .replace(/\]\]$/, "")
    .replace(/^doc\//, "")
    .replace(/\.md$/, "")
    .split("#")[0]
    .trim()
}

function sectionSnippet(text: string, keywords: string[]): string {
  const lines = text.split("\n").map((l) => l.trim())
  const nonEmpty = lines.filter(Boolean)
  if (nonEmpty.length === 0) return ""
  const lowerKeywords = new Set(keywords.map((k) => k.toLowerCase()))
  const hit = nonEmpty.find((line) => {
    const words = line
      .toLowerCase()
      .split(/[\s\W]+/)
      .filter(Boolean)
    return words.some((w) => lowerKeywords.has(w))
  })
  const base = hit ?? nonEmpty.find((l) => !l.startsWith("#")) ?? nonEmpty[0] ?? ""
  return base.length > 220 ? `${base.slice(0, 220)}…` : base
}

async function walkMarkdownFiles(root: string): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const fp = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(fp)
        continue
      }
      if (entry.isFile() && entry.name.endsWith(".md")) out.push(fp)
    }
  }
  await walk(root)
  return out
}

function scoreKeywordMatch(text: string, keywords: string[]): { score: number; matched: string[] } {
  if (keywords.length === 0) return { score: 0, matched: [] }
  const lower = text.toLowerCase()
  const matched = keywords.filter((k) => lower.includes(k.toLowerCase()))
  return { score: matched.length / keywords.length, matched }
}

export async function queryVaultNotes(input: QueryVaultNotesInput): Promise<QueryVaultNotesResult> {
  const topK = input.topK ?? 5
  const queryText = `${input.goal}\n${input.systemComponents}`
  const queryKeywords = extractKeywords(queryText)
  const alreadySelected = new Set((input.alreadySelected ?? []).map(normalizePath))

  if (!queryText.trim() || queryKeywords.length === 0) {
    return { notes: [], query_keywords: queryKeywords, deduped_count: 0, strategy: "none" }
  }

  if (input.semanticSearch) {
    try {
      const semantic = await input.semanticSearch({
        query: queryText,
        topK,
        notesRoot: input.notesRoot,
      })
      const normalized = semantic.map((hit) => ({ ...hit, path: normalizePath(hit.path) }))
      const uniqueByPath = new Map<string, SemanticHit>()
      for (const hit of normalized) {
        const prev = uniqueByPath.get(hit.path)
        if (!prev || hit.score > prev.score) uniqueByPath.set(hit.path, hit)
      }
      const deduped = Array.from(uniqueByPath.values()).filter((hit) => !alreadySelected.has(hit.path))
      deduped.sort((a, b) => b.score - a.score)
      const notes = deduped.slice(0, topK).map((hit) => ({
        path: hit.path,
        title: hit.title ?? path.basename(hit.path),
        snippet: hit.snippet ?? "",
        score: hit.score,
        matched_keywords: queryKeywords.filter((kw) => {
          const s = `${hit.title ?? ""} ${hit.snippet ?? ""}`.toLowerCase()
          return s.includes(kw)
        }),
      }))
      if (notes.length > 0) {
        return {
          notes,
          query_keywords: queryKeywords,
          deduped_count: semantic.length - deduped.length,
          strategy: "semantic",
        }
      }
    } catch {
      // semantic path unavailable → keyword fallback
    }
  }

  const files = await walkMarkdownFiles(input.notesRoot)
  const scored: PriorWorkNote[] = []
  let dedupedCount = 0

  for (const file of files) {
    const rel = path.relative(input.notesRoot, file).replace(/\\/g, "/").replace(/\.md$/, "")
    const notePath = normalizePath(rel)
    if (alreadySelected.has(notePath)) {
      dedupedCount++
      continue
    }
    const text = await fs.readFile(file, "utf8").catch(() => "")
    if (!text) continue
    const { score, matched } = scoreKeywordMatch(text, queryKeywords)
    if (score <= 0) continue
    const title = text.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? path.basename(notePath)
    scored.push({
      path: notePath,
      title,
      snippet: sectionSnippet(text, queryKeywords),
      score,
      matched_keywords: matched,
    })
  }

  scored.sort((a, b) => b.score - a.score)
  return {
    notes: scored.slice(0, topK),
    query_keywords: queryKeywords,
    deduped_count: dedupedCount,
    strategy: "keyword",
  }
}
