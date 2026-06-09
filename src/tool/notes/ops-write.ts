import * as fs from "fs/promises"
import * as path from "path"
import { existsSync } from "fs"
import { NEED } from "@/tool/notes/types"
import type { Frontmatter } from "@/tool/notes/types"
import { resolvePath, resolveReadPath, docRoot } from "@/tool/notes/paths"
import { parseFrontmatter, serializeFrontmatter } from "@/tool/notes/frontmatter"
import { readLines, writeLines, regenerateIndex, seedFrontmatter, mergeFrontmatter } from "@/tool/notes/io"
import { normalizeLsp } from "@/tool/notes/indexing"
import { ensureMarkdownNoteIndex } from "@/tool/notes/index-hook"
import {
  parseHeadings,
  parseBlockRefs,
  buildIndexLines,
  toAnchor,
  noteKind,
  detectDuplicateSections,
  detectDuplicateTaskLeaves,
} from "@/tool/notes/headings"
import { Log } from "@/foundation/util/log"
import { seedSection } from "@/tool/notes/schema"
import { ensureRoot } from "@/tool/notes/root"
import { opAudit } from "@/tool/notes/ops-audit"
import { bootRows, bootLines } from "@/tool/notes/ops-bootstrap"
import { withLock } from "@/tool/notes/file-lock"
import { validateMessagesContent } from "@/permission/policy/message"
import { MessageType } from "@/permission/policy/message"

const log = Log.create({ service: "notes.ops-write" })

// ---------------------------------------------------------------------------

// Task-note write lock
//
// Task notes are the multi-agent coordination surface — multiple specialists
// write ## Tasks/## Systems/Reservations sections concurrently. The sidecar `.lock`
// file (file-lock.ts) serializes those writes across processes/sessions so
// no update is lost.
//
// Atomic notes and durable project notes do NOT use this lock — they're
// already protected by the Reservations system + low contention.
// ---------------------------------------------------------------------------

function isTaskNote(rel: string): boolean {
  // Logical paths look like `task/todo-foo` or `project/task/todo-foo` after
  // cleanPath. Both forms route to the project mount.
  return /(?:^|\/)task\/todo-/.test(rel)
}

/**
 * Run a write function under the task-note file lock if `rel` points at a
 * task note. For non-task-notes, run the function directly (no lock needed).
 *
 * The caller passes the doc-relative `rel` so we can resolve it to an
 * absolute path here. The lock is held only for the duration of `fn`.
 */
export async function withNoteLock<T>(
  rel: string,
  opts: { sessionID?: string; agent?: string },
  fn: () => Promise<T>,
): Promise<T> {
  const fp = resolveReadPath(rel)
  return withLock(fp, { sessionID: opts.sessionID ?? "", agent: opts.agent ?? "" }, fn)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true if the vault already contains at least one .md file. */
export async function vaultHasNotes(): Promise<boolean> {
  const { allRoots, sharedRoot } = await import("@/tool/notes/paths")
  const roots = [...allRoots(), sharedRoot()]
  for (const root of roots) {
    const subdirs = await fs.readdir(root).catch(() => [] as string[])
    for (const sub of subdirs) {
      const dir = path.join(root, sub)
      const stat = await fs.lstat(dir).catch(() => null)
      if (!stat?.isDirectory()) continue
      const files = await fs.readdir(dir).catch(() => [] as string[])
      if (files.some((f) => f.endsWith(".md"))) return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Operations — write
// ---------------------------------------------------------------------------

export async function opBootstrap(force: boolean): Promise<string> {
  await ensureRoot()
  const plan = await bootRows()
  const made: string[] = []
  const kept: string[] = []
  for (const row of plan) {
    const fp = resolvePath(row.path)
    if (existsSync(fp) && !force) {
      kept.push(row.path)
      continue
    }
    await writeLines(fp, bootLines(row))
    await normalizeLsp(fp)
    await regenerateIndex(fp)
    made.push(row.path)
  }

  // Audit only the newly created notes (not kept/existing notes which may have
  // project-specific content that references notes not yet in the vault).
  const auditResults: string[] = []
  let anyFailed = false
  for (const rel of made) {
    const result = await opAudit("all", rel)
    if (!result.startsWith("Audit passed") && !result.startsWith("Note not found")) {
      auditResults.push(result)
      anyFailed = true
    }
  }

  if (anyFailed) {
    const { log } = await import("@/tool/notes/logger")
    log.error("notes bootstrap audit failed", {
      created: made.length,
      skipped: kept.length,
    })
    throw new Error(`Bootstrap audit failed.\n${auditResults.join("\n")}`)
  }

  const audit = `Audit passed: ${made.length + kept.length} note(s), 0 issue(s).`
  const out = [
    `Bootstrap complete: created ${made.length} note(s), skipped ${kept.length}.`,
    made.length ? `Created: ${made.map((x) => `doc/${x}`).join(", ")}` : "",
    kept.length ? `Skipped: ${kept.map((x) => `doc/${x}`).join(", ")}` : "",
    audit,
  ].filter(Boolean)
  return out.join("\n")
}

export async function opWrite(
  rel: string,
  section: string,
  content: string,
  level: number,
  blockId: string | undefined,
  sessionID?: string,
): Promise<string> {
  await ensureRoot()
  return withNoteLock(rel, { sessionID, agent: "write" }, () =>
    _opWriteInner(rel, section, content, level, blockId, sessionID),
  )
}

async function _opWriteInner(
  rel: string,
  section: string,
  content: string,
  level: number,
  blockId: string | undefined,
  sessionID?: string,
): Promise<string> {
  // Messages validator hook (Stage 11 / D.4)
  // Runs before any file I/O so a malformed envelope never reaches disk.
  let _messagesWarnings: string[] | undefined
  if (section === "Messages") {
    const vResult = validateMessagesContent(content, (name) => MessageType.get(name))
    if (!vResult.ok) {
      throw new Error(vResult.error)
    }
    if (vResult.warnings?.length) _messagesWarnings = vResult.warnings
  }

  const primary = resolvePath(rel)
  const fallback = resolveReadPath(rel)
  const fp = existsSync(primary) || !existsSync(fallback) ? primary : fallback
  const heading = "#".repeat(level) + " " + section

  const contentLines = content.split("\n")
  if (blockId) {
    let last = contentLines.length - 1
    while (last >= 0 && contentLines[last].trim() === "") last--
    if (last >= 0) contentLines[last] = contentLines[last] + ` ^${blockId}`
  }
  const finalContent = contentLines.join("\n")

  if (!existsSync(fp)) {
    const title = path.basename(rel, ".md")
    const kind = noteKind(rel)
    const fm = serializeFrontmatter(seedFrontmatter(rel, finalContent))
    const sections = kind ? [...NEED[kind]] : ["Index"]
    const rows: string[] = []
    let seen = false
    for (const sec of sections) {
      if (sec === "Index") {
        const hit = level === 2 && section.toLowerCase() === "index"
        rows.push("## Index", ...(hit ? ["", ...finalContent.split("\n"), ""] : [""]))
        if (hit) seen = true
        continue
      }
      const hit = level === 2 && sec.toLowerCase() === section.toLowerCase()
      rows.push(`## ${sec}`, "", ...(hit ? finalContent.split("\n") : seedSection(kind, sec)), "")
      if (hit) seen = true
    }
    if (!seen) rows.push(heading, "", ...finalContent.split("\n"), "")
    const noteLines = [...fm, "", `# ${title}`, "", ...rows]
    await writeLines(fp, noteLines)
    await normalizeLsp(fp)
    await regenerateIndex(fp)
    return `Created doc/${rel}.md with section "${section}". Index regenerated.`
  }

  const lines = await readLines(fp)
  const headings = parseHeadings(lines)
  const s = toAnchor(section)
  const target = headings.find((h) => h.anchor === s || h.text.toLowerCase() === section.toLowerCase())

  if (target) {
    const start = target.line - 1
    let end = lines.length
    for (let i = start + 1; i < lines.length; i++) {
      const m = lines[i].match(/^(#{1,6})\s/)
      if (m && m[1].length <= target.level) {
        end = i
        break
      }
    }
    lines.splice(start, end - start, lines[start], "", ...finalContent.split("\n"), "")
  } else {
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop()
    lines.push("", heading, "", ...finalContent.split("\n"), "")
  }

  await writeLines(fp, lines)

  // Non-fatal duplicate-section warn (post-write hygiene)
  const postWriteLines = await readLines(fp)
  const dupIssues = detectDuplicateSections(postWriteLines)
  if (dupIssues.length > 0) {
    log.warn("notes.ops-write.duplicate-sections", {
      rel,
      section,
      issues: dupIssues.map((i) => ({
        heading: i.heading,
        count: i.count,
        lines: i.lines,
      })),
    })
  }
  const leafIssues = detectDuplicateTaskLeaves(postWriteLines)
  if (leafIssues.length > 0) {
    log.warn("notes.ops-write.duplicate-task-leaves", {
      rel,
      section,
      issues: leafIssues.map((i) => ({
        id: i.id,
        heading: i.heading,
        count: i.count,
        lines: i.lines,
      })),
    })
  }

  await normalizeLsp(fp)
  await regenerateIndex(fp)

  const updated = await readLines(fp)
  const idx = buildIndexLines(parseHeadings(updated), parseBlockRefs(updated), 4)
  return `Section "${section}" written to doc/${rel}.\n\nUpdated index:\n${idx.join("\n")}`
}

export async function opFrontmatterWrite(rel: string, set: Frontmatter): Promise<string> {
  const fp = resolveReadPath(rel)
  if (!existsSync(fp)) return `Note not found: ${rel}`
  await mergeFrontmatter(fp, set)
  await normalizeLsp(fp)
  await ensureMarkdownNoteIndex(fp)
  const lines = await readLines(fp)
  const { fm } = parseFrontmatter(lines)
  return `Frontmatter updated for doc/${rel}.\n\n${serializeFrontmatter(fm).join("\n")}`
}

/**
 * Bump the `updated:` (and legacy `verified:`) field on a project note to
 * today's date. Used to mark a note as freshly verified against source per
 * the verification cadence in ~/notes/README.md ("Verify any project notes
 * whose updated: is older than 30 days against source").
 */
export async function opVerify(rel: string): Promise<string> {
  const fp = resolveReadPath(rel)
  if (!existsSync(fp)) return `Note not found: ${rel}`
  const today = new Date().toISOString().slice(0, 10)
  const lines = await readLines(fp)
  const { fm } = parseFrontmatter(lines)
  const patch: Frontmatter = { updated: today }
  if (fm.verified !== undefined) patch.verified = today
  await mergeFrontmatter(fp, patch)
  await normalizeLsp(fp)
  return `Verified doc/${rel} on ${today}.`
}

/**
 * Rename a note and sweep all wikilink references across the vault.
 * Per ~/notes/README.md: "Renaming a note without sweeping backlinks →
 * silent link death". Both filename-based `[[Old title]]` and path-based
 * `[[atomic/old]]` forms are rewritten. Anchors and aliases preserved.
 */
export async function opRename(oldRel: string, newRel: string): Promise<string> {
  const { listFiles } = await import("@/tool/notes/io")
  const { invalidateTitleIndex } = await import("@/tool/notes/indexing")
  const { cleanPath } = await import("@/tool/notes/paths")

  const oldFp = resolveReadPath(oldRel)
  if (!existsSync(oldFp)) return `Note not found: ${oldRel}`

  const newFp = resolvePath(newRel)
  if (existsSync(newFp)) return `Refusing to rename: target already exists at doc/${newRel}`

  const oldStem = path.basename(oldFp, ".md")
  const newStem = path.basename(newFp, ".md")
  const oldClean = cleanPath(oldRel)
  const newClean = cleanPath(newRel)

  await fs.mkdir(path.dirname(newFp), { recursive: true })
  await fs.rename(oldFp, newFp)

  const allFiles = await listFiles("all")
  const escapedStem = oldStem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const escapedClean = oldClean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const filenameRe = new RegExp(`(\\[\\[)${escapedStem}((?:#[^\\]|]*)?(?:\\|[^\\]]*)?\\]\\])`, "g")
  const cleanRe = new RegExp(`(\\[\\[)${escapedClean}((?:#[^\\]|]*)?(?:\\|[^\\]]*)?\\]\\])`, "g")

  let touched = 0
  for (const fp of allFiles) {
    if (fp === newFp) continue
    const text = await fs.readFile(fp, "utf-8").catch(() => "")
    if (!text) continue
    let next = text.replace(filenameRe, `$1${newStem}$2`)
    next = next.replace(cleanRe, `$1${newClean}$2`)
    if (next !== text) {
      await fs.writeFile(fp, next, "utf-8")
      touched++
    }
  }

  invalidateTitleIndex()

  return `Renamed doc/${oldRel} → doc/${newRel}. Swept backlinks in ${touched} file(s).`
}

// ---------------------------------------------------------------------------
// Notes write API — exported for internal note writers.
// These are the canonical write primitives for ALL note files including task notes.
// Task note file writes should route through here so the notes tool
// owns the full write responsibility for the notes vault.
// ---------------------------------------------------------------------------

/**
 * Write (or create) a single section in a note file.
 * Non-destructive: only the target section is replaced; all other sections untouched.
 * If the note does not exist, it is created with all required sections seeded.
 * Regenerates ## Index automatically.
 */
export async function notesWriteSection(
  rel: string,
  section: string,
  content: string,
  sessionID?: string,
): Promise<void> {
  await opWrite(rel, section, content, 2, undefined, sessionID)
}

/**
 * Append content to a specific ### sub-section within a ## section.
 * If the ## section doesn't exist it is created.
 * If the ### sub-section doesn't exist it is appended inside the ## section.
 * Used for nested targeted appends such as ## Systems / ### Coordination / #### @from -> @to.
 */
export async function notesAppendToSubsection(
  rel: string,
  section: string,
  subsection: string,
  content: string,
  sessionID?: string,
): Promise<string> {
  await ensureRoot()

  // Messages validator hook (Stage 11 / D.4)
  // Runs before any file I/O so a malformed envelope never reaches disk.
  if (section === "Messages") {
    const vResult = validateMessagesContent(content, (name) => MessageType.get(name))
    if (!vResult.ok) {
      throw new Error(vResult.error)
    }
  }

  const primary = resolvePath(rel)
  const fallback = resolveReadPath(rel)
  const fp = existsSync(primary) || !existsSync(fallback) ? primary : fallback

  if (!existsSync(fp)) {
    const body = `### ${subsection}\n\n${content}`
    await opWrite(rel, section, body, 2, undefined, sessionID)
    return `Created doc/${rel} with ${section} → ${subsection}`
  }

  const lines = await readLines(fp)
  const sectionHead = `## ${section}`
  let sectionStart = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === sectionHead) {
      sectionStart = i
      break
    }
  }

  if (sectionStart === -1) {
    // ## section missing — append it with the sub-section
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop()
    lines.push("", sectionHead, "", `### ${subsection}`, "", content, "")
    await writeLines(fp, lines)
    return `Appended new section ${section} → ${subsection} to doc/${rel}`
  }

  // Find end of ## section
  let sectionEnd = lines.length
  for (let i = sectionStart + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      sectionEnd = i
      break
    }
  }

  // Find ### subsection within section bounds
  const subHead = `### ${subsection}`
  let subStart = -1
  for (let i = sectionStart + 1; i < sectionEnd; i++) {
    if (lines[i].trim() === subHead) {
      subStart = i
      break
    }
  }

  if (subStart === -1) {
    // Sub-section missing — insert before sectionEnd
    let insertAt = sectionEnd
    while (insertAt > sectionStart + 1 && lines[insertAt - 1].trim() === "") insertAt--
    lines.splice(insertAt, 0, "", subHead, "", content)
    await writeLines(fp, lines)
    return `Created sub-section ${section} → ${subsection} in doc/${rel}`
  }

  // Find end of ### sub-section (next ### or ## or end of ## section)
  let subEnd = sectionEnd
  for (let i = subStart + 1; i < sectionEnd; i++) {
    if (/^#{2,3} /.test(lines[i])) {
      subEnd = i
      break
    }
  }

  // Append content before the sub-section end
  let insertAt = subEnd
  while (insertAt > subStart + 1 && lines[insertAt - 1].trim() === "") insertAt--
  lines.splice(insertAt, 0, content)
  await writeLines(fp, lines)
  return `Appended to ${section} → ${subsection} in doc/${rel}`
}

// ---------------------------------------------------------------------------
// Nested-heading write (§19 of todo-note-format contract)
// ---------------------------------------------------------------------------

/**
 * Strip leading `[<num>]` and `[<type>]` bracket tokens from a heading text,
 * then trim. Used for component matching per §19a.
 *
 * Examples:
 *   "[4.5] [impl] Implement foo" → "Implement foo"
 *   "4.5"                        → "4.5"
 *   "Systems / Conversation"     → "Systems / Conversation"
 */
function stripBrackets(text: string): string {
  return text.replace(/^(\[[^\]]*\]\s*)+/, "").trim()
}

/**
 * Case-insensitive equality after stripping brackets from the heading text.
 */
function headingMatches(headingText: string, component: string): boolean {
  return stripBrackets(headingText).toLowerCase() === component.toLowerCase()
}

/**
 * Write to a nested heading path within a ## section.
 *
 * `subsectionPath` is a `/`-separated string like `"Implement / 4.5"` or
 * `"Implement / 4.5 / @meta"`. Each component maps to a heading level:
 *   component[0] → H3, component[1] → H4, component[2] → H5, …
 *
 * Behaviour:
 * - Non-`@meta` leaf: replace entire content under the resolved heading
 *   (between heading line and next sibling-or-higher heading).
 * - `@meta` leaf: idempotent per-key replace/append of `> key: value` lines
 *   in the metadata block immediately under the parent heading.
 * - Any component not found → returns error string (§19d), no write.
 *
 * `level` is the caller-declared leaf heading level (used for `@meta`
 * boundary detection). If it disagrees with the resolved depth a lint
 * warning is prepended to the return string but the write still proceeds.
 */
export async function notesWriteNestedSubsection(
  rel: string,
  section: string,
  subsectionPath: string,
  content: string,
  level: number,
  sessionID?: string,
): Promise<string> {
  await ensureRoot()
  return withNoteLock(rel, { sessionID, agent: "write" }, () =>
    _notesWriteNestedSubsectionInner(rel, section, subsectionPath, content, level, sessionID),
  )
}

async function _notesWriteNestedSubsectionInner(
  rel: string,
  section: string,
  subsectionPath: string,
  content: string,
  level: number,
  sessionID?: string,
): Promise<string> {
  const primary = resolvePath(rel)
  const fallback = resolveReadPath(rel)
  const fp = existsSync(primary) || !existsSync(fallback) ? primary : fallback

  // Split and validate path components
  const rawComponents = subsectionPath
    .split("/")
    .map((c) => c.trim())
    .filter(Boolean)
  if (rawComponents.length === 0) {
    return `subsection-path-not-found: (empty) at level 3`
  }

  // Determine if last component is @meta
  const isMetaWrite = rawComponents[rawComponents.length - 1] === "@meta"
  const headingComponents = isMetaWrite ? rawComponents.slice(0, -1) : rawComponents

  if (!existsSync(fp)) {
    // Note doesn't exist — create it via opWrite with nested content
    // Build nested heading structure
    const leafLevel = 2 + headingComponents.length // H2 section + components
    const headingPrefix = "#".repeat(leafLevel)
    const leafHeading = `${headingPrefix} ${headingComponents[headingComponents.length - 1]}`
    const body = `${leafHeading}\n\n${content}`
    await opWrite(rel, section, body, 2, undefined, sessionID)
    return `Created doc/${rel} with ${section} → ${subsectionPath}`
  }

  const lines = await readLines(fp)

  // --- Locate ## section ---
  const sectionHead = `## ${section}`
  let sectionStart = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === sectionHead) {
      sectionStart = i
      break
    }
  }
  if (sectionStart === -1) {
    return `subsection-path-not-found: ${section} at level 2`
  }
  let sectionEnd = lines.length
  for (let i = sectionStart + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      sectionEnd = i
      break
    }
  }

  // --- Walk heading components ---
  // component[0] → H3 (level 3), component[1] → H4, …
  let searchStart = sectionStart + 1
  let searchEnd = sectionEnd
  let resolvedStart = -1
  let resolvedLevel = 3

  for (let ci = 0; ci < headingComponents.length; ci++) {
    const component = headingComponents[ci]
    const targetLevel = 3 + ci // H3 for first, H4 for second, …
    let found = -1
    for (let i = searchStart; i < searchEnd; i++) {
      const m = lines[i].match(/^(#{1,6})\s+(.+)$/)
      if (!m) continue
      const hLevel = m[1].length
      // Stop if we hit a heading at same or higher level (sibling/parent)
      if (hLevel < targetLevel) break
      if (hLevel === targetLevel && headingMatches(m[2], component)) {
        found = i
        break
      }
    }
    if (found === -1) {
      return `subsection-path-not-found: ${component} at level ${targetLevel}`
    }
    resolvedStart = found
    resolvedLevel = targetLevel
    // Narrow search window to within this heading's body
    searchStart = found + 1
    searchEnd = sectionEnd
    for (let i = found + 1; i < sectionEnd; i++) {
      const m = lines[i].match(/^(#{1,6})\s/)
      if (m && m[1].length <= targetLevel) {
        searchEnd = i
        break
      }
    }
  }

  if (resolvedStart === -1) {
    return `subsection-path-not-found: ${headingComponents[0]} at level 3`
  }

  // resolvedStart = line index of the resolved leaf heading
  // searchEnd = end of that heading's body (exclusive)

  if (isMetaWrite) {
    // @meta: idempotent per-key replace/append of `> key: value` lines
    // Metadata block = contiguous `> ` lines immediately after the heading
    // (skip blank lines between heading and first `> ` line)
    let metaStart = resolvedStart + 1
    while (metaStart < searchEnd && lines[metaStart].trim() === "") metaStart++

    // Collect existing metadata lines
    let metaEnd = metaStart
    while (metaEnd < searchEnd && /^> /.test(lines[metaEnd])) metaEnd++

    // Parse incoming content lines
    const incomingLines = content.split("\n").filter((l) => /^> /.test(l.trim()) || l.trim() === "")
    const incomingMeta = incomingLines.filter((l) => /^> /.test(l))

    // Build updated metadata block: start with existing, replace matching keys
    const existingMeta = lines.slice(metaStart, metaEnd)
    const updatedMeta = [...existingMeta]

    for (const inLine of incomingMeta) {
      // Extract key: `> key: value` → key = everything before first `: `
      const keyMatch = inLine.match(/^> ([^:]+):/)
      if (!keyMatch) {
        // No key pattern — just append
        updatedMeta.push(inLine)
        continue
      }
      const key = keyMatch[1]
      const existingIdx = updatedMeta.findIndex((l) => {
        const km = l.match(/^> ([^:]+):/)
        return km && km[1] === key
      })
      if (existingIdx !== -1) {
        updatedMeta[existingIdx] = inLine
      } else {
        updatedMeta.push(inLine)
      }
    }

    lines.splice(metaStart, metaEnd - metaStart, ...updatedMeta)
    await writeLines(fp, lines)

    const warns: string[] = []
    if (level !== resolvedLevel) {
      warns.push(`lint: declared level=${level} but resolved level=${resolvedLevel}; write proceeded`)
    }
    const prefix = warns.length ? warns.join("; ") + "\n" : ""
    return `${prefix}Updated @meta block under ${section} → ${subsectionPath} in doc/${rel}`
  }

  // Non-@meta leaf: replace entire content under the resolved heading
  const headingLine = lines[resolvedStart]
  const newBody = [headingLine, "", ...content.split("\n"), ""]
  lines.splice(resolvedStart, searchEnd - resolvedStart, ...newBody)
  await writeLines(fp, lines)

  const warns: string[] = []
  if (level !== resolvedLevel) {
    warns.push(`lint: declared level=${level} but resolved level=${resolvedLevel}; write proceeded`)
  }
  const prefix = warns.length ? warns.join("; ") + "\n" : ""
  return `${prefix}Replaced content under ${section} → ${subsectionPath} in doc/${rel}`
}

/**
 * Append a single line to a section in a note file.
 * Non-destructive: only appends, never replaces existing content.
 * Used by generic notes callers to append one line to a chosen section.
 */
export async function notesAppendToSection(rel: string, section: string, line: string): Promise<void> {
  await ensureRoot()
  const primary = resolvePath(rel)
  const fallback = resolveReadPath(rel)
  const fp = existsSync(primary) || !existsSync(fallback) ? primary : fallback
  if (!existsSync(fp)) {
    // Note doesn't exist yet — create it with just this section
    await opWrite(rel, section, line, 2, undefined)
    return
  }
  const lines = await readLines(fp)
  const headLine = `## ${section}`
  let sectionStart = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === headLine) {
      sectionStart = i
      break
    }
  }
  if (sectionStart === -1) {
    // Section missing — append it
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop()
    lines.push("", headLine, line, "")
    await writeLines(fp, lines)
    return
  }
  let sectionEnd = lines.length
  for (let i = sectionStart + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      sectionEnd = i
      break
    }
  }
  let insertAt = sectionEnd
  while (insertAt > sectionStart + 1 && lines[insertAt - 1].trim() === "") insertAt--
  lines.splice(insertAt, 0, line)
  await writeLines(fp, lines)
}

/**
 * Replace a full section in a note file using line-based surgery.
 * Non-destructive: only the target section is replaced; all other sections untouched.
 * Used by generic notes callers to replace one chosen section.
 */
export async function notesReplaceSection(rel: string, section: string, body: string): Promise<void> {
  await ensureRoot()
  const primary = resolvePath(rel)
  const fallback = resolveReadPath(rel)
  const fp = existsSync(primary) || !existsSync(fallback) ? primary : fallback
  if (!existsSync(fp)) {
    await opWrite(rel, section, body, 2, undefined)
    return
  }
  const lines = await readLines(fp)
  const headLine = `## ${section}`
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === headLine) {
      start = i
      break
    }
  }
  if (start === -1) {
    // Section missing — append
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop()
    lines.push("", headLine, body, "")
    await writeLines(fp, lines)
    return
  }
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      end = i
      break
    }
  }
  const newLines = [headLine, body]
  const result = [...lines.slice(0, start), ...newLines, "", ...lines.slice(end)]
  await writeLines(fp, result)
}

/**
 * Write the full content of a note file from scratch.
 * Used for initial task note creation.
 * Callers are responsible for providing complete, well-formed content.
 */
export async function notesWriteFile(fp: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(fp), { recursive: true })
  await fs.writeFile(fp, content, "utf-8")
}

// ---------------------------------------------------------------------------
// Pure helpers — no file I/O, safe to call in tests without vault setup
// ---------------------------------------------------------------------------

export interface ReindexLink {
  section: string
  link: string
  description?: string
}

export interface AuditIssue {
  path: string
  code: string
  msg: string
}

/**
 * Pure function: replace named sections in a note string with wiki links.
 * Non-destructive: only the listed sections are replaced; all other content untouched.
 * Idempotent: calling twice with the same links produces the same result.
 */
export function reindexSections(noteContent: string, links: ReindexLink[]): string {
  const lines = noteContent.split("\n")
  for (const { section, link } of links) {
    const headIdx = lines.findIndex((l) => l.trim() === `## ${section}`)
    if (headIdx === -1) continue
    // Find end of section (next ## heading or end of file)
    let endIdx = lines.length
    for (let i = headIdx + 1; i < lines.length; i++) {
      if (/^## /.test(lines[i])) {
        endIdx = i
        break
      }
    }
    // Replace section body with the single link line
    lines.splice(headIdx, endIdx - headIdx, `## ${section}`, "", link, "")
  }
  return lines.join("\n")
}

/**
 * Pure function: extract all `[[doc/...]]` wiki links from a string.
 * Returns deduplicated list with `doc/` prefix stripped.
 */
export function extractLinkedNotes(content: string): string[] {
  const re = /\[\[doc\/([^\]|]+?)(?:\|[^\]]*?)?\]\]/g
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    seen.add(m[1])
  }
  return [...seen]
}

/**
 * Pure function: convert a list of audit issues into human-readable warning strings.
 * Returns empty array when no issues. Never throws.
 */
export function auditAdvisory(issues: AuditIssue[]): string[] {
  return issues.map((i) => `⚠ [${i.code}] ${i.path}: ${i.msg}`)
}
