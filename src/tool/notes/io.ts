import * as fs from "fs/promises"
import * as path from "path"
import { existsSync } from "fs"
import type { Frontmatter } from "@/tool/notes/types"
import { cleanPath, allRoots } from "@/tool/notes/paths"
import { parseFrontmatter, serializeFrontmatter } from "@/tool/notes/frontmatter"
import { parseHeadings, parseBlockRefs, buildIndexLines } from "@/tool/notes/headings"
import { ensureMarkdownNoteIndex } from "@/tool/notes/index-hook"
import { defaultTags, readTags, scanInlineTags } from "@/tool/notes/tags"

// ---------------------------------------------------------------------------
// Helpers — file I/O, index regeneration, description helpers, listFiles.
// Indexing helpers (hasLsp, touch, normalizeLsp, applyLspEdits, etc) live
// in ./indexing/ — import them from there, not from this file.
// ---------------------------------------------------------------------------

export async function readLines(fp: string): Promise<string[]> {
  const text = await fs.readFile(fp, "utf-8")
  return text.split("\n")
}

export async function writeLines(fp: string, lines: string[]) {
  await fs.mkdir(path.dirname(fp), { recursive: true })
  await fs.writeFile(fp, lines.join("\n"), "utf-8")
}

export async function regenerateIndex(fp: string) {
  const result = await ensureMarkdownNoteIndex(fp)
  if (result.indexed || result.reason !== "outside-scope") return

  // Backward-compatible fallback for callers that pass non-vault markdown
  // files directly. Normal notes-vault files use ensureMarkdownNoteIndex(),
  // which skips out-of-scope generated paths and stabilizes line numbers with bounded rebuild passes.
  const lines = await readLines(fp)
  const headings = parseHeadings(lines)
  const blockRefs = parseBlockRefs(lines)
  const indexLines = buildIndexLines(headings, blockRefs, 4)
  const block = ["## Index", "", ...indexLines, ""]

  let start = -1,
    end = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^## Index\s*$/.test(lines[i])) {
      start = i
      for (let j = i + 1; j < lines.length; j++) {
        if (/^## /.test(lines[j])) {
          end = j
          break
        }
      }
      if (end === -1) end = lines.length
      break
    }
  }

  if (start === -1) {
    const { bodyStart } = parseFrontmatter(lines)
    let pos = bodyStart
    while (pos < lines.length && lines[pos].trim() === "") pos++
    if (pos < lines.length && /^# /.test(lines[pos])) pos++
    while (pos < lines.length && lines[pos].trim() === "") pos++
    lines.splice(pos, 0, ...block, "")
  } else {
    lines.splice(start, end - start, ...block)
  }

  await writeLines(fp, lines)
}

export function firstSentence(text: string): string {
  const m = text.match(/[^.!?]*[.!?]/)
  return m ? m[0].trim() : text.slice(0, 120).trim()
}

export function defaultDescription(rel: string, content: string): string {
  const line = content
    .split("\n")
    .map((x) => x.trim().replace(/^[-*+]\s+/, ""))
    .find((x) => x.length > 0)
  if (line) return firstSentence(line)
  return `Note for ${cleanPath(rel)}`
}

export function seedFrontmatter(rel: string, content: string): Frontmatter {
  return {
    tags: defaultTags(rel),
    description: defaultDescription(rel, content),
  }
}

export async function mergeFrontmatter(fp: string, patch: Frontmatter): Promise<void> {
  const lines = await readLines(fp)
  const { fm, bodyStart } = parseFrontmatter(lines)
  for (const [k, v] of Object.entries(patch)) {
    if (Array.isArray(v) && Array.isArray(fm[k])) {
      const existing = fm[k] as string[]
      fm[k] = [...new Set([...existing, ...v])]
    } else {
      fm[k] = v
    }
  }
  const fmLines = serializeFrontmatter(fm)
  const body = lines.slice(bodyStart)
  await writeLines(fp, [...fmLines, "", ...body])
}

export async function noteDescription(fp: string): Promise<string> {
  if (!existsSync(fp)) return ""
  const lines = await readLines(fp)
  const { fm, bodyStart } = parseFrontmatter(lines)
  if (typeof fm.description === "string" && fm.description.trim()) return fm.description.trim()
  for (let i = bodyStart; i < lines.length; i++) {
    if (/^## (Tasks|Systems|Goal|Purpose)\s*$/.test(lines[i])) {
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j].trim()
        if (t && !t.startsWith("#")) return firstSentence(t)
      }
    }
  }
  for (let i = bodyStart; i < lines.length; i++) {
    const t = lines[i].trim()
    if (t && !t.startsWith("#")) return firstSentence(t)
  }
  return ""
}

export async function getNoteTags(fp: string): Promise<string[]> {
  if (!existsSync(fp)) return []
  const lines = await readLines(fp)
  const { fm, bodyStart } = parseFrontmatter(lines)
  const fmTags = readTags(fm.tags)
  const inline = scanInlineTags(lines, bodyStart)
  return [...new Set([...fmTags, ...inline])]
}

// Folders that map to a single note kind, per the vault layout in
// ~/notes/README.md. `atomic/` is special — it has loose .md files at its
// root and per-kind subfolders (concept/, principle/, etc.) underneath, so
// we walk it recursively.
const KIND_FOLDERS: Record<string, string> = {
  task: "task",
  module: "module",
  architecture: "architecture",
  concept: "concept",
  data: "data",
  derived: "derived",
  decision: "decision",
  diagram: "diagram",
  flow: "flow",
  skill: "skill",
  moc: "moc",
  question: "question",
  reference: "reference",
  literature: "literature",
  log: "journal",
  journal: "journal",
  specification: "specification",
}

const ATOMIC_INNER = ["concept", "principle", "pattern", "reference", "literature", "skill", "domain"]

// Explicit subfolder kinds under project/software/<project>/specification/.
// These are the canonical specification namespace directories; listing them
// explicitly (rather than relying solely on generic recursion) makes
// bare-basename indexing coverage provable by inspection and allows callers
// to request type="contract" / type="api" / type="protocol" / type="schema"
// directly, mirroring the ATOMIC_INNER pattern for atomic/ subfolders.
const SPECIFICATION_SUBFOLDERS = ["contract", "api", "protocol", "schema"] as const
type SpecificationSubfolder = (typeof SPECIFICATION_SUBFOLDERS)[number]

function isSpecificationSubfolder(type: string): type is SpecificationSubfolder {
  return (SPECIFICATION_SUBFOLDERS as readonly string[]).includes(type)
}

// README.md is directory documentation but is still a valid wikilink target
// (e.g. `[[opencode/README]]`). It is included in listFiles so the title
// resolver can find it; the audit caller skips it explicitly so it doesn't
// fail the atomic schema check. `_`-prefixed files (`_home.md`, `_tags.md`)
// are also documentation but are first-class targets too.
function isNoteFile(name: string) {
  return name.endsWith(".md")
}

export function isAuditableNote(name: string) {
  if (!name.endsWith(".md")) return false
  if (name === "README.md") return false
  if (name.startsWith("_")) return false
  return true
}

async function walkMd(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return []
  const out: string[] = []
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    const fp = path.join(dir, e.name)
    let isDir = e.isDirectory()
    let isFile = e.isFile()
    // Symlinks: follow once via stat to classify; skip silently if dangling
    // so a single broken link does not abort an entire vault listing.
    if (e.isSymbolicLink()) {
      try {
        const st = await fs.stat(fp)
        isDir = st.isDirectory()
        isFile = st.isFile()
      } catch {
        continue
      }
    }
    if (isDir) {
      out.push(...(await walkMd(fp)))
      continue
    }
    if (isFile && isNoteFile(e.name)) out.push(fp)
  }
  return out
}

// Non-recursive sibling of walkMd for flat kind directories. Returns absolute
// paths to .md files, transparently following live symlinks and skipping
// dangling ones so opList does not ENOENT on first broken link.
async function listMdEntries(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  const out: string[] = []
  for (const e of entries) {
    if (!isNoteFile(e.name)) continue
    const fp = path.join(dir, e.name)
    if (e.isFile()) {
      out.push(fp)
      continue
    }
    if (e.isSymbolicLink()) {
      try {
        const st = await fs.stat(fp)
        if (st.isFile()) out.push(fp)
      } catch {
        // dangling symlink — skip silently
      }
    }
  }
  return out
}

async function listTaskEntries(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  const out: string[] = []
  for (const e of entries) {
    const fp = path.join(dir, e.name)
    if ((e.isFile() || e.isSymbolicLink()) && /^todo-.*\.md$/.test(e.name)) {
      try {
        const st = e.isSymbolicLink() ? await fs.stat(fp) : null
        if (!st || st.isFile()) out.push(fp)
      } catch {
        // dangling symlink — skip silently
      }
      continue
    }
    if (e.isDirectory() && /^todo-/.test(e.name)) {
      const todo = path.join(fp, "todo.md")
      if (existsSync(todo)) out.push(todo)
    }
  }
  return out
}

export async function listFiles(type: string): Promise<string[]> {
  const map = new Map<string, string>()
  for (const root of allRoots()) {
    const dirs: string[] = []

    if (type === "all" || type === "atomic") dirs.push(path.join(root, "atomic"))
    if (type === "atomic") {
      // Caller asked specifically for atomic — also include nested kinds.
      for (const inner of ATOMIC_INNER) dirs.push(path.join(root, "atomic", inner))
    }

    // Specific atomic-kind request: e.g. type=concept should look at
    // both top-level concept/ and atomic/concept/ for vault compatibility.
    if (ATOMIC_INNER.includes(type)) {
      dirs.push(path.join(root, type))
      dirs.push(path.join(root, "atomic", type))
    }

    // Task notes live under scratchpad/task/<proj>/{active,deferred,done}/.
    // KIND_FOLDERS maps `task` to a flat "task" dir that does not exist in
    // real vaults; replace it with an explicit walk of all three scratchpad
    // subdirs across every project key found on disk.
    if (type === "task" || type === "all") {
      const scratchpadTask = path.join(root, "scratchpad", "task")
      if (existsSync(scratchpadTask)) {
        const projects = await fs.readdir(scratchpadTask, { withFileTypes: true }).catch(() => [])
        for (const proj of projects) {
          if (!proj.isDirectory()) continue
          for (const sub of ["active", "deferred", "done"]) {
            dirs.push(path.join(scratchpadTask, proj.name, sub))
          }
        }
      }
    }

    if (type === "all") {
      // Walk every kind folder.
      for (const folder of new Set(Object.values(KIND_FOLDERS))) dirs.push(path.join(root, folder))
      // Walk atomic recursively (handled by the dirs.push(atomic) above).
      for (const inner of ATOMIC_INNER) dirs.push(path.join(root, "atomic", inner))
      // Explicitly include each specification subfolder so bare-basename
      // indexing covers contract/api/protocol/schema paths under
      // project/software/<project>/specification/* without relying solely
      // on the generic walkMd recursion triggered by needsRecursive below.
      for (const sub of SPECIFICATION_SUBFOLDERS) dirs.push(path.join(root, "specification", sub))
    } else if (type === "specification") {
      // Caller asked specifically for specification — also include each
      // canonical subfolder kind so contract/api/protocol/schema notes are
      // all returned, mirroring the ATOMIC_INNER expansion for type="atomic".
      for (const sub of SPECIFICATION_SUBFOLDERS) dirs.push(path.join(root, "specification", sub))
      const folder = KIND_FOLDERS[type]
      if (folder) dirs.push(path.join(root, folder))
    } else if (isSpecificationSubfolder(type)) {
      // Direct specification-namespace request: type="contract" → look in
      // project/software/<project>/specification/contract/ for vault compat.
      dirs.push(path.join(root, "specification", type))
    } else if (type !== "task") {
      const folder = KIND_FOLDERS[type]
      if (folder) dirs.push(path.join(root, folder))
    }

    for (const dir of dirs) {
      if (!existsSync(dir)) continue
      // Atomic and specification roots need recursive walk because of subfolders.
      // specification/ has nested kinds explicitly enumerated in SPECIFICATION_SUBFOLDERS
      // (contract, api, protocol, schema); the recursive walk ensures any future
      // subfolder added to specification/ is also indexed without a code change.
      // The SPECIFICATION_SUBFOLDERS dirs pushed above are flat (no further nesting),
      // so they use listMdEntries; only the specification/ root itself uses walkMd.
      const baseName = path.basename(dir)
      const needsRecursive = baseName === "atomic" || baseName === "specification"
      const isTaskStateDir = /(?:^|\/)scratchpad\/task\/[^/]+\/(?:active|deferred|done)$/.test(dir)
      const files = isTaskStateDir
        ? await listTaskEntries(dir)
        : needsRecursive
          ? await walkMd(dir)
          : await listMdEntries(dir)
      for (const fp of files) {
        const rel = path.relative(root, fp).replace(/\.md$/, "")
        if (!map.has(rel)) map.set(rel, fp)
      }
    }
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map((x) => x[1])
}
