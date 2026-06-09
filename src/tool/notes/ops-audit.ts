import { existsSync } from "fs"
import { NEED, ADVISORY, REDUCTION_KINDS, REDUCTION_SCOPES } from "@/tool/notes/types"
import type { Issue } from "@/tool/notes/types"
import { resolveReadPath, noteRel } from "@/tool/notes/paths"
import { parseFrontmatter } from "@/tool/notes/frontmatter"
import {
  parseHeadings,
  hasH2,
  sectionSlice,
  hasLink,
  toAnchor,
  nonFencedLines,
  stripInlineCode,
} from "@/tool/notes/headings"
import { readTags, scanWiki, skipWiki, scanMarkdownLinks } from "@/tool/notes/tags"
import * as path from "path"
import { readLines, listFiles, isAuditableNote } from "@/tool/notes/io"
import { noteDiagnostics } from "@/tool/notes/indexing"
import { opLink } from "@/tool/notes/indexing"
import { noteKind } from "@/tool/notes/headings"

// ---------------------------------------------------------------------------
// Operation — audit
//
// Aligned with the ~/notes vault canon. Schema sources of truth:
//   - ~/notes/atomic/README.md
//   - ~/notes/_templates/_frontmatter-standard.md
//   - ~/notes/_templates/*.md
// ---------------------------------------------------------------------------

// Note kinds that assert a Claim and follow the atomic schema
// (Claim/Reasoning/Related/Applied in). Skill, reference, literature do NOT
// belong here — they have their own schemas (procedure / lookup / source-bound).
const ATOM_KINDS = new Set(["atomic", "principle", "pattern"])

// Max length for a single progress entry before it's flagged as verbose
const VERBOSE_PROGRESS_CHARS = 200

// Reduction signal words in task note ## Systems / ## Tasks evidence lines
const REDUCTION_SIGNAL_RE = /\b(reducible|irreducible|abstraction|abstract|pattern|reusable|stored result|reduction)\b/i

function scanSameNoteMarkdownAnchors(
  lines: string[],
  bodyStart: number,
): { anchor: string; line: number; raw: string }[] {
  const out: { anchor: string; line: number; raw: string }[] = []
  for (const { line, i } of nonFencedLines(lines, bodyStart)) {
    const found = stripInlineCode(line).matchAll(/\[([^\]]*)\]\(#([^)]+)\)/g)
    for (const m of found) out.push({ anchor: m[2].trim(), line: i + 1, raw: m[0] })
  }
  return out
}

type ParsedFrontmatter = ReturnType<typeof parseFrontmatter>["fm"]
type ParsedHeading = ReturnType<typeof parseHeadings>[number]

function addIssue(issues: Issue[], path: string, line: number, code: string, msg: string) {
  issues.push({ path, line, code, msg })
}

function collectLinkedAtomTargets(lines: string[], bodyStart: number, linkedAtoms: Set<string>) {
  const body = lines.slice(bodyStart).join("\n")
  const linkMatches = [...body.matchAll(/\[\[([^\]|#]+?)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)]
  for (const match of linkMatches) {
    const target = match[1].trim()
    linkedAtoms.add(target.split("/").pop() ?? target)
  }
}

function auditFrontmatter(issues: Issue[], relPath: string, hasFm: boolean) {
  if (hasFm) return
  addIssue(issues, relPath, 1, "missing-frontmatter", "Note must start with YAML frontmatter (---).")
}

function auditRequiredSections(issues: Issue[], relPath: string, kind: keyof typeof NEED | "", heads: ParsedHeading[]) {
  const need = kind ? NEED[kind] : []
  for (const sec of need) {
    if (hasH2(heads, sec)) continue
    addIssue(issues, relPath, 1, "missing-section", `Missing required section: ## ${sec}`)
  }
}

function auditModuleNote(
  issues: Issue[],
  relPath: string,
  lines: string[],
  heads: ParsedHeading[],
  fm: ParsedFrontmatter,
) {
  if (!hasH2(heads, "Index")) {
    addIssue(issues, relPath, 1, "missing-index", "Module note must have a ## Index section for navigation.")
  }

  if (!fm.owner || (typeof fm.owner === "string" && !fm.owner.trim())) {
    addIssue(
      issues,
      relPath,
      1,
      "missing-owner",
      "Module note must declare `owner:` in frontmatter to identify the responsible subsystem.",
    )
  }

  if (
    fm.reduction_kind !== undefined &&
    !(REDUCTION_KINDS as readonly string[]).includes(fm.reduction_kind as string)
  ) {
    addIssue(
      issues,
      relPath,
      1,
      "invalid-reduction-kind",
      `Invalid reduction_kind: "${fm.reduction_kind}". Must be one of: ${REDUCTION_KINDS.join(", ")}.`,
    )
  }

  if (
    fm.reduction_scope !== undefined &&
    !(REDUCTION_SCOPES as readonly string[]).includes(fm.reduction_scope as string)
  ) {
    addIssue(
      issues,
      relPath,
      1,
      "invalid-reduction-scope",
      `Invalid reduction_scope: "${fm.reduction_scope}". Must be one of: ${REDUCTION_SCOPES.join(", ")}.`,
    )
  }

  const comp = sectionSlice(lines, heads, "Composition")
  if (comp.body.length > 0 && !hasLink(comp.body)) {
    addIssue(
      issues,
      relPath,
      comp.line,
      "missing-composition-link",
      "Module Composition section must list the atomic concepts the subsystem instantiates as [[wikilinks]] or [text](doc/path) markdown links.",
    )
  }

  const dataFlow = sectionSlice(lines, heads, "Data flow")
  if (dataFlow.body.length === 0) return
  const bodyText = dataFlow.body.join("\n").trim()
  if (/^-?\s*TODO\.?\s*$/i.test(bodyText)) {
    addIssue(
      issues,
      relPath,
      dataFlow.line,
      "missing-data-detail",
      "Module Data flow section is a TODO placeholder. Add actual data flow detail.",
    )
  }
}

function auditAtomNote(issues: Issue[], relPath: string, lines: string[], heads: ParsedHeading[]) {
  const hasClaim = lines.some((line) => /^\*\*Claim\*\*:\s+\S/.test(line))
  if (!hasClaim) {
    addIssue(
      issues,
      relPath,
      1,
      "missing-claim",
      "Atomic note must have a `**Claim**: <one sentence>` bold paragraph at the top of the body.",
    )
  }

  const related = sectionSlice(lines, heads, "Related")
  if (related.body.length > 0 && !hasLink(related.body)) {
    addIssue(
      issues,
      relPath,
      related.line,
      "missing-section",
      "Atomic note Related section needs at least one [[wikilink]] or [text](doc/path) markdown link.",
    )
  }

  const applied = sectionSlice(lines, heads, "Applied in")
  if (applied.body.length > 0 && !hasLink(applied.body)) {
    addIssue(
      issues,
      relPath,
      applied.line,
      "missing-applied-in",
      "Atomic note has no entries in Applied in. Reverse index will not surface this concept.",
    )
  }
}

function systemsHasContent(lines: string[]) {
  return lines.some((line) => {
    const trimmed = line.trim()
    return trimmed && !trimmed.startsWith("#") && !/^-?\s*(TODO|TBD|None|N\/A)\.?\s*$/i.test(trimmed)
  })
}

function auditTaskNote(issues: Issue[], relPath: string, lines: string[], heads: ParsedHeading[], tags: string[]) {
  const tasks = sectionSlice(lines, heads, "Tasks")
  const systems = sectionSlice(lines, heads, "Systems")

  for (const line of tasks.body) {
    const trimmed = line.trim()
    if (!/^>\s*(progress|evidence):/i.test(trimmed) || trimmed.length <= VERBOSE_PROGRESS_CHARS) continue
    addIssue(
      issues,
      relPath,
      tasks.line,
      "verbose-progress-entry",
      `Task note progress/evidence entry exceeds ${VERBOSE_PROGRESS_CHARS} characters. Compress to one sentence + link.`,
    )
    break
  }

  const hasReductionSignal = systems.body.some((line) => REDUCTION_SIGNAL_RE.test(line))
  if (!hasReductionSignal && systemsHasContent(systems.body)) {
    addIssue(
      issues,
      relPath,
      systems.line || 1,
      "missing-reduction-class",
      "Task note ## Systems content should include concise reduction framing (abstraction/pattern/decision) when possible.",
    )
  }

  const hasActive = tags.some((tag) => tag === "status/active" || tag === "status/wip")
  const hasDone = tags.some((tag) => tag === "status/done" || tag === "status/complete")
  if (hasActive && hasDone) {
    addIssue(
      issues,
      relPath,
      1,
      "conflicting-status-tags",
      "Task note has both active (status/active or status/wip) and done (status/done or status/complete) tags. Remove one.",
    )
  }
}

async function auditIndexDiagnostics(issues: Issue[], fp: string, relPath: string, lines: string[]) {
  const indexDiagnostics = await noteDiagnostics(fp)
  let diagnosticsValidated = false
  for (const d of indexDiagnostics) {
    const msg = `${d.message || ""}`.trim()
    if (!msg) continue
    if (!/unresolved|not found|cannot resolve/i.test(msg)) continue
    diagnosticsValidated = true

    const lineText = lines[d.range?.start?.line ?? 0] ?? ""
    const wikilinkMatch = lineText.match(/\[\[([^\]|#]+)/)
    if (wikilinkMatch) {
      const out = await opLink(`[[${wikilinkMatch[1]}]]`)
      const res = JSON.parse(out) as { exists?: boolean }
      if (res.exists !== false) continue
    }

    addIssue(issues, relPath, (d.range?.start?.line ?? 0) + 1, "missing-link-target", msg)
  }
  return diagnosticsValidated
}

async function auditWikiLinkTargets(issues: Issue[], relPath: string, lines: string[], bodyStart: number) {
  const links = scanWiki(lines, bodyStart)
  for (const link of links) {
    if (skipWiki(link.raw)) continue
    const out = await opLink(`[[${link.raw}]]`)
    const res = JSON.parse(out) as { exists?: boolean; suggestion?: string }
    if (res.exists !== false) continue
    addIssue(
      issues,
      relPath,
      link.line,
      "missing-link-target",
      res.suggestion ?? `Link target not found: [[${link.raw}]]`,
    )
  }
}

async function auditMarkdownLinkTargets(issues: Issue[], relPath: string, lines: string[], bodyStart: number) {
  const mdLinks = scanMarkdownLinks(lines, bodyStart)
  for (const md of mdLinks) {
    const out = await opLink(`[${md.text || "link"}](${md.href})`)
    const res = JSON.parse(out) as { exists?: boolean; suggestion?: string }
    if (res.exists !== false) continue
    addIssue(
      issues,
      relPath,
      md.line,
      "missing-link-target",
      res.suggestion ?? `Link target not found: [${md.text || "link"}](${md.href})`,
    )
  }
}

function auditSameNoteAnchors(
  issues: Issue[],
  relPath: string,
  lines: string[],
  heads: ParsedHeading[],
  bodyStart: number,
) {
  const anchorsInNote = new Set(parseHeadings(lines).map((h) => h.anchor))
  const sameNoteAnchors = scanSameNoteMarkdownAnchors(lines, bodyStart)
  const indexSection = sectionSlice(lines, heads, "Index")
  const indexStart = indexSection.line
  const indexEnd = indexSection.line + indexSection.body.length
  for (const link of sameNoteAnchors) {
    if (link.line > indexStart && link.line <= indexEnd) continue
    const wanted = toAnchor(link.anchor)
    if (anchorsInNote.has(wanted)) continue
    addIssue(issues, relPath, link.line, "missing-link-target", `Anchor "${link.anchor}" not found in current note`)
  }
}

async function auditLinkTargets(
  issues: Issue[],
  fp: string,
  relPath: string,
  lines: string[],
  heads: ParsedHeading[],
  bodyStart: number,
) {
  const diagnosticsValidated = await auditIndexDiagnostics(issues, fp, relPath, lines)
  if (diagnosticsValidated) return
  await auditWikiLinkTargets(issues, relPath, lines, bodyStart)
  await auditMarkdownLinkTargets(issues, relPath, lines, bodyStart)
  auditSameNoteAnchors(issues, relPath, lines, heads, bodyStart)
}

function appendOrphanAtomIssues(issues: Issue[], atomTitles: Set<string>, linkedAtoms: Set<string>) {
  for (const title of atomTitles) {
    if (linkedAtoms.has(title)) continue
    addIssue(
      issues,
      title,
      1,
      "orphan-atom",
      `Atomic note "${title}" is not referenced by any other note. Add a [[wikilink]] from a project note or remove if obsolete.`,
    )
  }
}

function formatIssue(issue: Issue) {
  return `- doc/${issue.path} [L${issue.line}] ${issue.code}: ${issue.msg}`
}

function renderAuditResult(files: string[], issues: Issue[]) {
  const blocking = issues.filter((issue) => !ADVISORY.has(issue.code))
  const advisory = issues.filter((issue) => ADVISORY.has(issue.code))

  if (blocking.length === 0) {
    const kpi = [
      `Audit passed: ${files.length} note(s), 0 issue(s).`,
      "",
      "KPI summary:",
      `  notes audited:       ${files.length}`,
      `  broken links:        0`,
      `  governance issues:   0`,
      `  entropy score:       low (graph is clean)`,
    ]
    if (advisory.length > 0) {
      kpi.push("")
      kpi.push(`Advisory issues: ${advisory.length}`)
      for (const issue of advisory) kpi.push(formatIssue(issue))
    }
    return kpi.join("\n")
  }

  const broken = blocking.filter((issue) => issue.code === "missing-link-target").length
  const governance = blocking.filter(
    (issue) =>
      issue.code === "missing-status" || issue.code === "missing-frontmatter" || issue.code === "missing-updated",
  ).length
  const structural = blocking.length - broken - governance
  const entropy = blocking.length > 5 ? "high" : blocking.length > 2 ? "medium" : "low"

  const out = [
    `Audit failed: ${files.length} note(s), ${blocking.length} blocking issue(s).`,
    "",
    "KPI summary:",
    `  notes audited:       ${files.length}`,
    `  broken links:        ${broken}`,
    `  governance issues:   ${governance}`,
    `  structural issues:   ${structural}`,
    `  entropy score:       ${entropy} (target: low)`,
    "",
    "Issues:",
  ]
  for (const issue of blocking) out.push(formatIssue(issue))
  if (advisory.length > 0) {
    out.push("")
    out.push(`Advisory issues: ${advisory.length}`)
    for (const issue of advisory) out.push(formatIssue(issue))
  }
  return out.join("\n")
}

export async function opAudit(type: string, rel: string | undefined): Promise<string> {
  const files = rel ? [resolveReadPath(rel)] : await listFiles(type)
  if (rel && !existsSync(files[0])) return `Note not found: ${rel}`
  if (files.length === 0) return "No notes found."

  const issues: Issue[] = []
  const atomTitles = new Set<string>()
  const linkedAtoms = new Set<string>()

  for (const fp of files) {
    if (!existsSync(fp)) continue
    // Skip directory documentation files (README.md, _home.md) — they're
    // valid wikilink targets but not real notes subject to schema audit.
    if (!isAuditableNote(path.basename(fp))) continue

    const lines = await readLines(fp)
    const relPath = noteRel(fp)
    const { fm, bodyStart } = parseFrontmatter(lines)
    const hasFm = lines[0]?.trim() === "---"
    const heads = parseHeadings(lines)
    const kind = noteKind(relPath)
    const tags = readTags(fm.tags)
    const baseName = relPath.split("/").pop() ?? relPath

    if (ATOM_KINDS.has(kind as string)) atomTitles.add(baseName)
    collectLinkedAtomTargets(lines, bodyStart, linkedAtoms)

    auditFrontmatter(issues, relPath, hasFm)
    auditRequiredSections(issues, relPath, kind, heads)
    if (kind === "module") auditModuleNote(issues, relPath, lines, heads, fm)
    if (ATOM_KINDS.has(kind as string)) auditAtomNote(issues, relPath, lines, heads)
    if (kind === "task") auditTaskNote(issues, relPath, lines, heads, tags)
    await auditLinkTargets(issues, fp, relPath, lines, heads, bodyStart)
  }

  if (!rel) appendOrphanAtomIssues(issues, atomTitles, linkedAtoms)
  return renderAuditResult(files, issues)
}
