import * as path from "path"
import { existsSync } from "fs"
import { fileURLToPath } from "url"
import { LSP } from "@/provider/lsp"
import { NEED } from "@/tool/notes/types"
import { cleanPath, resolveReadPath, noteRel, inRoots } from "@/tool/notes/paths"
import { parseFrontmatter, serializeFrontmatter } from "@/tool/notes/frontmatter"
import { parseHeadings, parseBlockRefs, toAnchor, sectionSlice, hasAnchor, nonFencedLines } from "@/tool/notes/headings"
import { readTags, scanInlineTags, noteHasTags, tagMatches, scanWiki, skipWiki, splitWiki } from "@/tool/notes/tags"
import { readLines, listFiles, noteDescription, getNoteTags } from "@/tool/notes/io"
import { readLspHeadings, opLink, workspaceSymbolQuery } from "@/tool/notes/indexing"
import { scoreQuery } from "@/tool/notes/fzf"
import { hasReduceWord, hasAbstractWord, hasToolWord } from "@/tool/notes/headings"
import { classifyLine, scopeLine, noteTarget, validReductionKind, validReductionScope } from "@/tool/notes/schema"

// Re-export opAudit from ops-audit for backward compatibility
export { opAudit } from "@/tool/notes/ops-audit"

// Re-export opLink from indexing for backward compatibility
export { opLink } from "@/tool/notes/indexing"

// ---------------------------------------------------------------------------
// Operations — read-only
// ---------------------------------------------------------------------------

export async function opList(type: string, filterTags: string[]): Promise<string> {
  const types =
    type === "all"
      ? [
          "task",
          "atomic",
          "concept",
          "principle",
          "pattern",
          "reference",
          "literature",
          "skill",
          "module",
          "architecture",
          "data",
          "derived",
          "decision",
          "diagram",
          "flow",
          "moc",
          "question",
          "log",
          "journal",
        ]
      : [type]
  const out: string[] = []
  const rows = new Map<string, string[]>()
  const sharedRows = new Map<string, string[]>()
  for (const t of types) {
    rows.set(t, [])
    sharedRows.set(t, [])
  }

  for (const fp of await listFiles(type)) {
    const rel = noteRel(fp)
    // shared:: notes go into sharedRows
    const isShared = rel.startsWith("shared::")
    const cleanRel = isShared ? rel.slice(8) : rel
    const parts = cleanRel.split("/")
    const isScratchpadTask = parts[0] === "scratchpad" && parts[1] === "task"
    const t = isScratchpadTask ? "task" : parts[0]
    const name = isScratchpadTask ? cleanRel : parts.slice(1).join("/")
    const target = isShared ? sharedRows : rows
    if (!target.has(t)) continue
    const lines = await readLines(fp)
    const { fm, bodyStart } = parseFrontmatter(lines)
    const fmTags = readTags(fm.tags)
    // Skip redirect stubs — they are navigation aids, not content notes
    if (fmTags.includes("status/redirect")) continue
    const allTags = [...new Set([...fmTags, ...scanInlineTags(lines, bodyStart)])]
    if (filterTags.length > 0 && !noteHasTags(allTags, filterTags)) continue
    const desc = await noteDescription(fp)
    const tagStr = fmTags.length > 0 ? `  [${fmTags.map((tg) => `#${tg}`).join(" ")}]` : ""
    const prefix = isShared ? "shared::doc" : "doc"
    const displayPath = isScratchpadTask ? `${prefix}/${name}` : `${prefix}/${t}/${name}`
    target.get(t)!.push(desc ? `  ${displayPath}  —  ${desc}${tagStr}` : `  ${displayPath}${tagStr}`)
  }

  // project notes first
  for (const t of types) {
    const list = rows.get(t) ?? []
    if (list.length === 0) continue
    out.push(`${t}/`)
    out.push(...list)
  }

  // shared notes under a distinct shared/ header
  const hasShared = types.some((t) => (sharedRows.get(t) ?? []).length > 0)
  if (hasShared) {
    out.push("shared/")
    for (const t of types) {
      const list = sharedRows.get(t) ?? []
      if (list.length === 0) continue
      out.push(`  ${t}/`)
      out.push(...list)
    }
  }

  return out.length ? out.join("\n") : "No notes found."
}

export async function opIndex(rel: string, depth: number, section: string | undefined): Promise<string> {
  const fp = resolveReadPath(rel)
  if (!existsSync(fp)) return `Note not found: ${rel}`

  const lines = await readLines(fp)
  const indexedHeadings = await readLspHeadings(fp)
  const headings = indexedHeadings.length ? indexedHeadings : parseHeadings(lines)
  const blockRefs = parseBlockRefs(lines)
  let subset = headings.filter((h) => h.level <= depth)

  if (section) {
    const s = toAnchor(section)
    const root = subset.find((h) => h.level === 2 && (h.anchor === s || h.text.toLowerCase() === section.toLowerCase()))
    if (!root) return `Section "${section}" not found in ${rel}`
    const ri = subset.indexOf(root)
    const children = [root]
    for (let i = ri + 1; i < subset.length; i++) {
      if (subset[i].level === 2) break
      children.push(subset[i])
    }
    subset = children
  }

  if (subset.length === 0 && blockRefs.length === 0) return `No headings at depth ${depth} in ${rel}`

  const min = subset.length > 0 ? Math.min(...subset.map((h) => h.level)) : 2
  const rows = subset.map(
    (h) => `${"  ".repeat(h.level - min)}[L${h.line}] ${"#".repeat(h.level)} ${h.text}  (#${h.anchor})`,
  )

  if (depth >= 4 && blockRefs.length > 0) {
    rows.push("")
    rows.push("Block refs:")
    for (const b of blockRefs) rows.push(`  [L${b.line}] ^${b.id}`)
  }

  return rows.join("\n")
}

export async function opRead(
  rel: string,
  section: string | undefined,
  line: number | undefined,
  context: number,
): Promise<string> {
  const fp = resolveReadPath(rel)
  if (!existsSync(fp)) return `Note not found: ${rel}`
  const lines = await readLines(fp)

  if (line !== undefined) {
    const start = Math.max(0, line - 1)
    const end = Math.min(lines.length, start + context)
    return lines
      .slice(start, end)
      .map((l, i) => `${start + i + 1}: ${l}`)
      .join("\n")
  }

  if (section) {
    const s = toAnchor(section)
    const indexedHeadings = await readLspHeadings(fp)
    const headings = indexedHeadings.length ? indexedHeadings : parseHeadings(lines)
    const target = headings.find((h) => h.anchor === s || h.text.toLowerCase() === section.toLowerCase())
    if (!target) return `Section "${section}" not found in ${rel}`
    const start = target.line - 1
    let end = lines.length
    for (let i = start + 1; i < lines.length; i++) {
      const m = lines[i].match(/^(#{1,6})\s/)
      if (m && m[1].length <= target.level) {
        end = i
        break
      }
    }
    return lines
      .slice(start, end)
      .map((l, i) => `${start + i + 1}: ${l}`)
      .join("\n")
  }

  const indexedHeadings = await readLspHeadings(fp)
  const headings = indexedHeadings.length ? indexedHeadings : parseHeadings(lines)
  const first = headings.find((h) => h.level === 2 && h.anchor !== "index")
  const end = first
    ? (() => {
        const next = headings.find((h) => h.level === 2 && h.line > first.line)
        return next ? next.line - 1 : Math.min(lines.length, first.line + context)
      })()
    : Math.min(lines.length, 60)

  return lines
    .slice(0, end)
    .map((l, i) => `${i + 1}: ${l}`)
    .join("\n")
}

export async function opSearch(query: string, type: string, filterTags: string[]): Promise<string> {
  const files = await listFiles(type)
  if (files.length === 0) return "No notes found."

  let re: RegExp
  try {
    re = new RegExp(query || "@/tool/notes", "i")
  } catch {
    re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
  }

  // headingPath helper — shared across phases
  const headingPath = (headings: ReturnType<typeof parseHeadings>, lineNo: number): string => {
    const ancestors: ReturnType<typeof parseHeadings> = []
    for (const h of headings) {
      if (h.line > lineNo) break
      while (ancestors.length > 0 && ancestors[ancestors.length - 1].level >= h.level) ancestors.pop()
      ancestors.push(h)
    }
    return ancestors
      .filter((h) => h.level >= 2)
      .map((h) => `${"#".repeat(h.level)} ${h.text}`)
      .join(" > ")
  }

  // ---------------------------------------------------------------------------
  // Phase 1: candidate file selection
  // ---------------------------------------------------------------------------

  // Phase 1a: indexing workspace-symbol query — get files with matching symbols
  const symbolMatches = await workspaceSymbolQuery(query).catch(() => [])
  const symbolMatchedFiles = new Set<string>()
  for (const sym of symbolMatches) {
    try {
      const { fileURLToPath } = await import("url")
      const fp = fileURLToPath(sym.location.uri)
      symbolMatchedFiles.add(fp)
    } catch {
      // ignore malformed URIs
    }
  }

  // Phase 1b: fzf filename scoring — only when symbol query returned no hits
  const fzfFiles = new Set<string>()
  if (symbolMatchedFiles.size === 0) {
    for (const fp of files) {
      const rel = noteRel(fp)
      if (scoreQuery(query, rel) > 0) fzfFiles.add(fp)
    }
  }

  // Candidate set: symbol hits + fzf filename hits + all files as fallback
  const candidateFiles =
    symbolMatchedFiles.size > 0 || fzfFiles.size > 0
      ? files.filter((fp) => symbolMatchedFiles.has(fp) || fzfFiles.has(fp))
      : files // fallback: scan all files

  // ---------------------------------------------------------------------------
  // Phase 2: per-file regex scan + fzf ranking
  // ---------------------------------------------------------------------------

  type Hit = { score: number; text: string }
  const hits: Hit[] = []

  for (const fp of candidateFiles) {
    const lines = await readLines(fp)
    const { fm, bodyStart } = parseFrontmatter(lines)
    const fmTags = readTags(fm.tags)
    const allTags = [...fmTags, ...scanInlineTags(lines, bodyStart)]

    if (filterTags.length > 0 && !noteHasTags(allTags, filterTags)) continue

    const headings = parseHeadings(lines)
    const rel = noteRel(fp)

    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue
      const ctx = headingPath(headings, i + 1)
      const target = `${rel} ${ctx} ${lines[i]}`
      const score = scoreQuery(query, target)
      hits.push({
        score,
        text: `doc/${rel}  [L${i + 1}]  ${ctx}\n  ${lines[i].trim().slice(0, 120)}`,
      })
    }
  }

  // If candidate-file scan found nothing and we used a restricted set, fall back to full scan
  if (hits.length === 0 && (symbolMatchedFiles.size > 0 || fzfFiles.size > 0)) {
    for (const fp of files) {
      if (candidateFiles.includes(fp)) continue
      const lines = await readLines(fp)
      const { fm, bodyStart } = parseFrontmatter(lines)
      const fmTags = readTags(fm.tags)
      const allTags = [...fmTags, ...scanInlineTags(lines, bodyStart)]

      if (filterTags.length > 0 && !noteHasTags(allTags, filterTags)) continue

      const headings = parseHeadings(lines)
      const rel = noteRel(fp)

      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue
        const ctx = headingPath(headings, i + 1)
        const target = `${rel} ${ctx} ${lines[i]}`
        const score = scoreQuery(query, target)
        hits.push({
          score,
          text: `doc/${rel}  [L${i + 1}]  ${ctx}\n  ${lines[i].trim().slice(0, 120)}`,
        })
      }
    }
  }

  // Sort by score descending, return top 20
  hits.sort((a, b) => b.score - a.score)
  const top = hits.slice(0, 20).map((h) => h.text)

  return top.length ? top.join("\n\n") : `No matches${query ? ` for "${query}"` : ""}.`
}

export async function opTagsRead(
  type: string,
  notePath: string | undefined,
  filterTag: string | undefined,
): Promise<string> {
  if (notePath) {
    const fp = resolveReadPath(notePath)
    if (!existsSync(fp)) return `Note not found: ${notePath}`
    const lines = await readLines(fp)
    const { fm, bodyStart } = parseFrontmatter(lines)
    const fmTags = readTags(fm.tags)
    const inline = scanInlineTags(lines, bodyStart)
    const all = [...new Set([...fmTags, ...inline])]
    if (all.length === 0) return `No tags found in ${notePath}`
    return `Tags in doc/${notePath}:\n${all.map((t) => `  #${t}`).join("\n")}`
  }

  const files = await listFiles(type)
  const tagMap = new Map<string, string[]>()

  for (const fp of files) {
    const rel = noteRel(fp)
    const tags = await getNoteTags(fp)
    for (const tag of tags) {
      if (!tagMap.has(tag)) tagMap.set(tag, [])
      tagMap.get(tag)!.push(`doc/${rel}`)
    }
  }

  if (filterTag) {
    const out: string[] = []
    for (const [tag, notes] of tagMap) {
      if (!tagMatches(tag, filterTag)) continue
      out.push(`#${tag}  (${notes.length} note${notes.length !== 1 ? "s" : ""})`)
      for (const n of notes) out.push(`  ${n}`)
    }
    return out.length ? out.join("\n") : `No notes tagged #${filterTag} or #${filterTag}/*.`
  }

  if (tagMap.size === 0) return "No tags found across notes."
  const sorted = [...tagMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  const out: string[] = []
  for (const [tag, notes] of sorted) {
    out.push(`#${tag}  (${notes.length} note${notes.length !== 1 ? "s" : ""})`)
    for (const n of notes) out.push(`  ${n}`)
  }
  return out.join("\n")
}

export async function opFrontmatterRead(rel: string): Promise<string> {
  const fp = resolveReadPath(rel)
  if (!existsSync(fp)) return `Note not found: ${rel}`
  const lines = await readLines(fp)
  const { fm } = parseFrontmatter(lines)
  if (Object.keys(fm).length === 0) return `No frontmatter in doc/${rel}`
  return serializeFrontmatter(fm).join("\n")
}

export async function opRefs(rel: string, section: string | undefined): Promise<string> {
  const note = cleanPath(rel)
  const goal = section ? `doc/${note}#${section}` : `doc/${note}`
  const rows = new Map<string, string>()
  const add = (fp: string, line: number, text: string) => {
    const key = `${fp}:${line}`
    if (rows.has(key)) return
    rows.set(key, `doc/${fp} [L${line}] ${text}`)
  }

  const link = section ? `[[doc/${note}#${section}]]` : `[[doc/${note}]]`
  const res = JSON.parse(await opLink(link)) as {
    path?: string
    line?: number
    exists?: boolean
  }
  let hasIndexClient = false
  if (res.exists && res.path && res.path !== "(current note)" && typeof res.line === "number" && res.line > 0) {
    hasIndexClient = await import("@/provider/lsp").then((m) => m.LSP.hasClients(res.path!).catch(() => false))
    if (hasIndexClient) {
      const refs = (await LSP.references({
        file: res.path!,
        line: res.line - 1,
        character: 2,
      }).catch(() => [])) as { uri?: string; range?: { start?: { line?: number } } }[]
      for (const item of refs) {
        if (!item.uri) continue
        const fp = fileURLToPath(item.uri)
        if (!existsSync(fp)) continue
        if (!inRoots(fp)) continue
        const line = (item.range?.start?.line ?? 0) + 1
        if (path.resolve(fp) === path.resolve(res.path!) && line === res.line) continue
        const lines = await readLines(fp).catch(() => [])
        const text = (lines[line - 1] || "").trim() || "[reference]"
        add(noteRel(fp), line, text.slice(0, 160))
      }
    }
  }

  if (rows.size === 0) {
    for (const fp of await listFiles("all")) {
      const lines = await readLines(fp)
      const { bodyStart } = parseFrontmatter(lines)
      const links = scanWiki(lines, bodyStart)
      for (const item of links) {
        if (skipWiki(item.raw)) continue
        const hit = splitWiki(item.raw)
        if (hit.note !== note) continue
        if (section && !hasAnchor(hit.anchor, section)) continue
        const text = (lines[item.line - 1] || "").trim() || `[[${item.raw}]]`
        add(noteRel(fp), item.line, text.slice(0, 160))
      }
    }
  }

  if (rows.size === 0) return `No references found for ${goal}.`
  return [`References for ${goal}:`, ...[...rows.values()].sort()].join("\n")
}

export async function opExtract(rel: string, section: string | undefined): Promise<string> {
  const fp = resolveReadPath(rel)
  if (!existsSync(fp)) return `Note not found: ${rel}`

  const lines = await readLines(fp)
  const { fm } = parseFrontmatter(lines)
  const heads = parseHeadings(lines)

  // Determine which lines to scan
  let body: { text: string; lineNo: number }[] = []
  const { bodyStart } = parseFrontmatter(lines)
  if (section) {
    const s = toAnchor(section)
    const target = heads.find((h) => h.anchor === s || h.text.toLowerCase() === section.toLowerCase())
    if (!target) return `Section "${section}" not found in ${rel}`
    const start = target.line - 1
    let end = lines.length
    for (let i = start + 1; i < lines.length; i++) {
      const m = lines[i].match(/^(#{1,6})\s/)
      if (m && m[1].length <= target.level) {
        end = i
        break
      }
    }
    body = lines.slice(start, end).map((text, i) => ({ text, lineNo: start + i + 1 }))
  } else {
    body = lines.slice(bodyStart).map((text, i) => ({ text, lineNo: bodyStart + i + 1 }))
  }

  type Candidate = { kind: string; scope: string; line: number; text: string; suggestion: string }
  const candidates: Candidate[] = []
  const bodyTexts = body.map((b) => b.text)

  for (const { line: text, i } of nonFencedLines(bodyTexts)) {
    if (/^#{1,6}\s/.test(text)) continue
    const row = text.trim()
    if (!row) continue
    if (!hasReduceWord(row) && !hasAbstractWord(row) && !hasToolWord(row)) continue

    const kind = classifyLine(row)
    const scope = scopeLine(row)
    const target = noteTarget(kind, scope)

    candidates.push({
      kind,
      scope,
      line: body[i].lineNo,
      text: row.slice(0, 160),
      suggestion: `Store as ${kind} abstraction in ${target}`,
    })
  }

  // Also surface existing reduction metadata from frontmatter
  const meta: string[] = []
  if (validReductionKind(fm.reduction_kind)) meta.push(`reduction_kind: ${fm.reduction_kind}`)
  if (validReductionScope(fm.reduction_scope)) meta.push(`reduction_scope: ${fm.reduction_scope}`)

  if (candidates.length === 0 && meta.length === 0) {
    return [
      `No reduction candidates found in doc/${rel}${section ? `#${section}` : ""}.`,
      "",
      "Suggestion: add abstraction, pattern, or reducibility language to key sections so future tasks can retrieve instead of recompute.",
    ].join("\n")
  }

  const out: string[] = [
    `Reduction candidates in doc/${rel}${section ? `#${section}` : ""}: ${candidates.length} found.`,
  ]

  if (meta.length > 0) {
    out.push("", "Existing reduction metadata:")
    for (const m of meta) out.push(`  ${m}`)
  }

  if (candidates.length > 0) {
    out.push("", "Candidates:")
    for (const c of candidates) {
      out.push(`  [L${c.line}] kind=${c.kind} scope=${c.scope}`)
      out.push(`    text: ${c.text}`)
      out.push(`    → ${c.suggestion}`)
    }
    out.push("")
    out.push("Next steps:")
    out.push("  1. Verify each candidate against source if needed.")
    out.push("  2. Keep the task note concise; only update broader notes if the user asks.")
    out.push(
      "  3. If repeated expensive reasoning persists, propose a tool in concept/computational-reducibility#Patterns.",
    )
  }

  return out.join("\n")
}
