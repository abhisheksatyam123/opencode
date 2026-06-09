import * as fs from "fs/promises"
import * as path from "path"
import { existsSync } from "fs"
import { fileURLToPath } from "url"
import { LSP } from "@/provider/lsp"
import { vaultPath } from "@/foundation/notes-root"
import { cleanPath, resolveReadPath } from "@/tool/notes/paths"
import { readLines, listFiles } from "@/tool/notes/io"
import { parseHeadings, toAnchor } from "@/tool/notes/headings"
import { hasLsp, touch } from "@/tool/notes/indexing/client"
import { readLspHeadings } from "@/tool/notes/indexing/headings"

// ---------------------------------------------------------------------------
// Filename-by-title resolver
//
// Vault wikilinks use Obsidian's filename resolution: [[Long descriptive
// title]] resolves to the file `Long descriptive title.md` anywhere in the
// vault. Filenames are globally unique by contract (~/notes/atomic/README.md).
//
// Cache is built lazily on first call and invalidated by listFiles() reading
// fresh from disk on subsequent calls. Memory cost is small — vault size is
// bounded by hand-maintained content.
// ---------------------------------------------------------------------------

let titleIndex: Map<string, string> | undefined

async function buildTitleIndex(): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const files = await listFiles("all").catch(() => [] as string[])
  for (const fp of files) {
    const base = path.basename(fp, ".md")
    // Lowercase key for case-insensitive resolution
    const key = base.toLowerCase()
    if (!map.has(key)) map.set(key, fp)
  }
  return map
}

export async function resolveByTitle(title: string): Promise<string | undefined> {
  const cleaned = title.trim().replace(/\.md$/, "")
  if (!cleaned) return undefined

  if (!titleIndex) titleIndex = await buildTitleIndex()
  const direct = titleIndex.get(cleaned.toLowerCase())
  if (direct) return direct

  // No hit in cache — rebuild once in case files were added since last index.
  titleIndex = await buildTitleIndex()
  return titleIndex.get(cleaned.toLowerCase())
}

export function invalidateTitleIndex() {
  titleIndex = undefined
}

/**
 * Detect whether a wikilink target looks like an Obsidian filename wikilink
 * (long descriptive title with spaces) versus a path-based wikilink
 * (`atomic/concept-x` or `module/foo`). Filename links contain spaces or
 * uppercase characters and don't start with a known kind folder.
 */
export function looksLikeFilename(target: string): boolean {
  if (!target) return false
  if (target.includes(" ")) return true
  if (/[A-Z]/.test(target)) return true
  // Pure lowercase, no spaces, no slash → still treat as filename if it
  // doesn't start with a known kind prefix.
  const knownPrefix =
    /^(doc\/|atomic\/|concept\/|principle\/|pattern\/|reference\/|literature\/|domain\/|skill\/|module\/|architecture\/|data\/|derived\/|decision\/|diagram\/|flow\/|task\/|moc\/|question\/|thinking\/|journal\/|inbox\/)/
  return !knownPrefix.test(target) && !target.includes("/")
}

// ---------------------------------------------------------------------------
// LSP-backed link resolution + diagnostics
// ---------------------------------------------------------------------------

export async function lspResolve(link: string) {
  const dir = vaultPath.tmp("notes-link")
  const fp = path.join(dir, "resolve-link.md")
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(fp, link + "\n", "utf-8")
  if (!(await hasLsp(fp))) return []
  await touch(fp)
  const pos = Math.max(2, link.indexOf("#") > 0 ? link.indexOf("#") + 1 : link.length - 3)
  const out = await LSP.definition({ file: fp, line: 0, character: pos }).catch(() => [])
  return out.flat().filter(Boolean) as any[]
}

export async function noteDiagnostics(fp: string) {
  if (!(await hasLsp(fp))) return []
  await touch(fp)
  const all: Awaited<ReturnType<typeof LSP.diagnostics>> = await LSP.diagnostics().catch(() => ({}))
  const abs = path.resolve(fp)
  return all[abs] || all[fp] || []
}

// ---------------------------------------------------------------------------
// Shared anchor resolver — used by both wikilink and markdown link branches
// ---------------------------------------------------------------------------

/**
 * Resolve an anchor string to a line number within a file.
 * Returns { line, heading, exists } — reused by both wikilink and markdown link branches.
 */
async function resolveAnchorInFile(
  fp: string,
  anchor: string,
): Promise<{ line: number; heading: string; exists: boolean }> {
  const lines = await readLines(fp)

  if (anchor.startsWith("^")) {
    const id = anchor.slice(1)
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].match(new RegExp(`\\s\\^${id}\\s*$`)) || lines[i].match(new RegExp(`^\\^${id}\\s*$`))) {
        return { line: i + 1, heading: `^${id}`, exists: true }
      }
    }
    return { line: 0, heading: "", exists: false }
  }

  const indexedHeadings = await readLspHeadings(fp)
  const headings = indexedHeadings.length ? indexedHeadings : parseHeadings(lines)
  const part = anchor.split("#").filter(Boolean)

  if (part.length >= 1) {
    let cur: (typeof headings)[0] | undefined
    let ok = true
    for (const one of part) {
      const low = one.toLowerCase()
      const s = toAnchor(one)
      const list = headings.filter((x) => x.text.toLowerCase() === low || x.anchor === s || x.anchor === low)
      if (!cur) {
        if (list.length === 0) {
          ok = false
          break
        }
        cur = list[0]
        continue
      }
      const next = list.find((x) => x.line > cur!.line && x.level > cur!.level)
      if (!next) {
        ok = false
        break
      }
      cur = next
    }
    if (ok && cur) return { line: cur.line, heading: cur.text, exists: true }

    if (part.length === 1 && part[0].includes("--")) {
      const one = part[0].split("--").at(-1)
      const h = headings.find((x) => x.anchor === one)
      if (h) return { line: h.line, heading: h.text, exists: true }
    }
  }

  return { line: 0, heading: "", exists: false }
}

// ---------------------------------------------------------------------------
// Operation — link resolution (opLink)
// ---------------------------------------------------------------------------

export async function opLink(link: string): Promise<string> {
  const stripped = link.replace(/\|[^\]]+(?=\]\])/, "")

  const wikiM = stripped.match(/^\[\[([^\]#]*)(?:#([^\]]+))?\]\]$/)
  if (wikiM) {
    const rawTarget = (wikiM[1] || "").trim()
    const anchor = wikiM[2]

    if (!rawTarget) {
      return JSON.stringify({
        path: "(current note)",
        line: 0,
        exists: true,
        heading: anchor ?? "",
        note: "Same-note anchor — use internal notes lookup op=read section=<heading>",
      })
    }

    // Try filename-by-title resolution first when the target looks like an
    // Obsidian wikilink (long title with spaces, or no path separator).
    let fp: string | undefined
    if (looksLikeFilename(rawTarget)) {
      fp = await resolveByTitle(rawTarget)
    }

    // Fall back to path-based resolution.
    const notePath = cleanPath(rawTarget)
    if (!fp) fp = resolveReadPath(notePath)

    if (!fp || !existsSync(fp)) {
      // Last attempt: try title resolution on the cleaned path basename.
      const stem = notePath.split("/").pop() ?? notePath
      const byTitle = await resolveByTitle(stem)
      if (byTitle) {
        fp = byTitle
      } else {
        return JSON.stringify({
          path: fp ?? notePath,
          line: 0,
          exists: false,
          heading: "",
          suggestion: `Note not found: ${rawTarget}`,
        })
      }
    }
    if (!anchor) {
      return JSON.stringify({ path: fp, line: 1, exists: true, heading: "" })
    }

    const probe = `[[${cleanPath(notePath)}${anchor ? `#${anchor}` : ""}]]`
    const hit = (await lspResolve(probe))[0]
    if (hit?.uri) {
      const got = fileURLToPath(hit.uri)
      const line = (hit.range?.start?.line ?? 0) + 1
      if (anchor.startsWith("^")) {
        const id = anchor.replace(/^\^/, "")
        return JSON.stringify({ path: got, line, exists: true, heading: `^${id}` })
      }
      const rows = await readLines(got).catch(() => [])
      const head = (rows[line - 1] || "").match(/^(#{1,6})\s+(.+)$/)
      return JSON.stringify({ path: got, line, exists: true, heading: head ? head[2].trim() : anchor })
    }

    const resolved = await resolveAnchorInFile(fp, anchor)
    if (resolved.exists) {
      return JSON.stringify({ path: fp, line: resolved.line, exists: true, heading: resolved.heading })
    }

    return JSON.stringify({
      path: fp,
      line: 0,
      exists: false,
      heading: "",
      suggestion: `Anchor "${anchor}" not found in ${notePath}`,
    })
  }

  const mdM = link.match(/^\[([^\]]*)\]\(#([^)]+)\)$/)
  if (mdM) {
    return JSON.stringify({
      path: "(current note)",
      line: 0,
      exists: true,
      sameNote: true,
      heading: mdM[2],
      anchor: mdM[2],
      note: "Same-note anchor — use internal notes lookup op=read section=<heading>",
    })
  }

  // Cross-note markdown link: [text](doc/path) or [text](doc/path#anchor)
  const crossMdM = link.match(/^\[([^\]]*)\]\((doc\/[^)#]*)(?:#([^)]*))?\)$/)
  if (crossMdM) {
    const hrefPath = crossMdM[2].trim()
    const anchor = crossMdM[3]

    const cleanedPath = cleanPath(hrefPath)
    const fp = resolveReadPath(cleanedPath)

    if (!fp || !existsSync(fp)) {
      return JSON.stringify({
        path: hrefPath,
        line: 0,
        exists: false,
        heading: "",
        suggestion: `Note not found: ${hrefPath}`,
      })
    }

    if (!anchor) {
      return JSON.stringify({ path: fp, line: 1, exists: true, heading: "" })
    }

    const resolved = await resolveAnchorInFile(fp, anchor)
    if (resolved.exists) {
      return JSON.stringify({ path: fp, line: resolved.line, exists: true, heading: resolved.heading })
    }

    return JSON.stringify({
      path: fp,
      line: 0,
      exists: false,
      heading: "",
      suggestion: `Anchor "${anchor}" not found in ${hrefPath}`,
    })
  }

  return JSON.stringify({
    path: "",
    line: 0,
    exists: false,
    heading: "",
    suggestion: `Unrecognized link format: ${link}`,
  })
}
