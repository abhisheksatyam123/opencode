import { copyFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { Buffer } from "node:buffer"
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { Hono } from "hono"
import { Instance } from "@/config/project/instance"
import { appendIntelGraphLog } from "@/intelgraph/backend/log"
import { lazy } from "@/foundation/util/lazy"
import { WebUIError } from "@/surface/server/middleware"
import { notesRoot, vaultPath } from "@/notes/root"
import embeddedNotesUIAssetMap from "../opencode-notes-ui.gen"

type EmbeddedAsset = string | { type: string; data: string }
const bundledNotesUIAssetMap = embeddedNotesUIAssetMap as Record<string, EmbeddedAsset>

const NOTES_BASE_PATH = "/notes"
const ROUTE_DIR = dirname(fileURLToPath(import.meta.url))
const NOTES_UI_DIR = resolve(ROUTE_DIR, "../../web/notes-ui")
const MERMAID_DIST_PATH = resolve(ROUTE_DIR, "../../../../node_modules/mermaid/dist/mermaid.min.js")
const HTML_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; media-src 'self' data:; connect-src 'self' ws: wss:"

const ALLOWED_NOTE_EXTS = new Set([".md", ".mdx", ".html", ".htm", ".txt"])
const ALLOWED_NOTE_TOP_LEVELS = new Set(["atomic", "project", "scratchpad"])
const MAX_EDIT_BYTES = 1 * 1024 * 1024
const EDITABLE_EXTS = new Set(ALLOWED_NOTE_EXTS)
const TEXT_EXTS = new Set([...ALLOWED_NOTE_EXTS, ".css", ".js", ".json"])
const WIKILINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g
const MD_LINK_RE = /\[[^\]]+\]\(([^)]+\.(?:md|mdx|html?))\)/gi
const NOTES_INDEX_CACHE_TTL_MS = 30_000
type NoteFile = { path: string; name: string; ext: string; size: number }
type Edge = { from: string; to: string }
type NotesIndexCache = { root: string; files: NoteFile[]; builtAt: number }

let notesIndexCache: NotesIndexCache | null = null
let notesIndexInFlight: Promise<NoteFile[]> | null = null

export const NotesRoutes = lazy(() =>
  new Hono()
    .all("/", async (c) => dispatch(c.req.raw, c.req.path))
    .all("/*", async (c) => dispatch(c.req.raw, c.req.path)),
)

async function dispatch(req: Request, fullPath: string): Promise<Response> {
  try {
    return await dispatchNotes(req, fullPath)
  } catch (err) {
    await logNotesError(req, fullPath, err)
    throw err
  }
}

async function dispatchNotes(req: Request, fullPath: string): Promise<Response> {
  const url = new URL(req.url)
  const path = normalizeRoutePath(fullPath)

  if (req.method === "GET" && (path === "/" || path === "/index.html")) {
    return serveNotesAsset("index.html")
  }
  if (req.method === "GET" && path.startsWith("/web/")) {
    return serveNotesAsset(path.slice(1))
  }
  if (req.method === "GET" && path === "/api/tree") return apiTree()
  if (req.method === "GET" && path === "/api/file") return apiGetFile(url)
  if (req.method === "GET" && path === "/api/search") return apiSearch(url)
  if (req.method === "GET" && path === "/api/graph") return apiGraph()
  if (req.method === "GET" && path === "/api/backlinks") return apiBacklinks(url)
  if (req.method === "GET" && path === "/api/mermaid.js") return serveNotesAsset("web/mermaid.min.js")
  if (req.method === "POST" && path === "/api/plantuml") return apiPlantUML(req)
  if (req.method === "POST" && path === "/api/file") return apiCreateFile(req)
  if (req.method === "PUT" && path === "/api/file") return apiSaveFile(req, url)
  if (req.method === "DELETE" && path === "/api/file") return apiDeleteFile(url)
  if (req.method === "POST" && path === "/api/move") return apiMove(req)
  if (req.method === "POST" && path === "/api/ai/ask") return apiAiAsk(req)
  if (req.method === "GET" && path.startsWith("/raw/")) return rawFile(path.slice("/raw/".length))
  if (req.method === "GET" && path.startsWith("/serve/")) return serveFile(path.slice("/serve/".length))
  if (req.method === "GET" && path.startsWith("/view/")) {
    const rel = path.slice("/view/".length)
    return Response.redirect(`${NOTES_BASE_PATH}/?path=${encodeURIComponent(decodeURIComponent(rel))}`, 302)
  }

  return json({ ok: false, error: "not found" }, 404)
}

async function logNotesError(req: Request, fullPath: string, err: unknown): Promise<void> {
  const workspaceRoot = Instance.directory || Instance.worktree || process.cwd()
  const url = new URL(req.url)
  await appendIntelGraphLog(workspaceRoot, {
    source: "notes",
    component: "opencode.notes",
    message: err instanceof Error ? err.message : String(err),
    error: err,
    context: { method: req.method, path: fullPath, urlPath: url.pathname, query: url.search },
  })
}

function normalizeRoutePath(path: string) {
  if (!path) return "/"
  if (path === NOTES_BASE_PATH || path === `${NOTES_BASE_PATH}/`) return "/"
  if (path.startsWith(`${NOTES_BASE_PATH}/`)) return path.slice(NOTES_BASE_PATH.length)
  return path
}

function currentRoot() {
  return notesRoot()
}

function backupRoot() {
  return vaultPath.state("notes-ui", "backups")
}

function invalidateNotesIndexCache() {
  notesIndexCache = null
}

async function ensureNotesRoot() {
  await mkdir(currentRoot(), { recursive: true })
}

async function getNoteFiles(): Promise<NoteFile[]> {
  await ensureNotesRoot()
  const root = currentRoot()
  const now = Date.now()
  if (notesIndexCache && notesIndexCache.root === root && now - notesIndexCache.builtAt < NOTES_INDEX_CACHE_TTL_MS) {
    return notesIndexCache.files
  }
  if (notesIndexInFlight) return notesIndexInFlight
  notesIndexInFlight = walk(root)
    .then((files) => {
      files.sort((a, b) => a.path.localeCompare(b.path))
      notesIndexCache = { root, files, builtAt: Date.now() }
      return files
    })
    .finally(() => {
      notesIndexInFlight = null
    })
  return notesIndexInFlight
}

function json(obj: unknown, status = 200): Response {
  const body = JSON.stringify(obj, null, 2)
  const bytes = Buffer.byteLength(body, "utf8")
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": String(bytes),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  })
}

function textMime(path: string): string {
  const ext = extname(path).toLowerCase()
  if (ext === ".html" || ext === ".htm") return "text/html; charset=utf-8"
  if (ext === ".css") return "text/css; charset=utf-8"
  if (ext === ".js") return "text/javascript; charset=utf-8"
  if (ext === ".json") return "application/json; charset=utf-8"
  if (TEXT_EXTS.has(ext)) return "text/plain; charset=utf-8"
  if (ext === ".svg") return "image/svg+xml; charset=utf-8"
  return "application/octet-stream"
}

function inside(base: string, child: string) {
  const rel = relative(base, child)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

function safePath(relRaw: string) {
  const root = currentRoot()
  const relPath = decodeURIComponent(relRaw || "")
    .replaceAll("\\", "/")
    .replace(/^\/+/, "")
  const parts = relPath.split("/").filter(Boolean)
  if (parts.length === 0 || !ALLOWED_NOTE_TOP_LEVELS.has(parts[0]!)) {
    throw new WebUIError("notes_path_forbidden", "Path must be under atomic/, project/, or scratchpad/", 403, {
      path: relPath,
    })
  }
  if (parts.some((part) => part === "..")) {
    throw new WebUIError("notes_path_forbidden", "Path traversal rejected", 403, { path: relPath })
  }
  if (parts.some((part) => part.startsWith("."))) {
    throw new WebUIError("notes_path_forbidden", "Hidden notes paths are not editable", 403, { path: relPath })
  }
  const candidate = resolve(root, relPath)
  if (!inside(root, candidate)) {
    throw new WebUIError("notes_path_forbidden", "Path outside notes root rejected", 403, { path: relPath })
  }
  return candidate
}

function noteRelativePath(path: string) {
  return relative(currentRoot(), path).replaceAll(sep, "/")
}

function ensureEditable(path: string) {
  if (!EDITABLE_EXTS.has(extname(path).toLowerCase())) {
    throw new WebUIError("extension_not_supported", "Extension is not editable in notes", 400, {
      path: noteRelativePath(path),
    })
  }
}

function ensureEditSize(content: string) {
  const bytes = Buffer.byteLength(content, "utf8")
  if (bytes > MAX_EDIT_BYTES) {
    throw new WebUIError("file_too_large", "Note content exceeds the 1 MiB edit limit", 413, {
      bytes,
      max_bytes: MAX_EDIT_BYTES,
    })
  }
}

function ensureReadableSize(size: number, path: string) {
  if (size > MAX_EDIT_BYTES) {
    throw new WebUIError("file_too_large", "Note exceeds the 1 MiB preview/edit limit", 413, {
      path: noteRelativePath(path),
      bytes: size,
      max_bytes: MAX_EDIT_BYTES,
    })
  }
}

async function existsFile(path: string) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function serveNotesAsset(rel: string): Promise<Response> {
  const asset = await resolveNotesAsset(rel)
  if (!asset) return json({ ok: false, error: "static file not found" }, 404)
  const file = typeof asset === "string" ? Bun.file(asset) : null
  if (file && !(await file.exists())) return json({ ok: false, error: "static file not found" }, 404)
  const type = typeof asset === "string" ? file!.type || textMime(asset) : asset.type
  const headers = new Headers({
    "Content-Type": type,
    "Cache-Control": rel === "web/mermaid.min.js" ? "public, max-age=3600" : "no-store",
    "X-Content-Type-Options": "nosniff",
  })
  if (type.startsWith("text/html")) {
    headers.set("Content-Security-Policy", HTML_CSP)
  }
  const body = typeof asset === "string" ? await file!.arrayBuffer() : Buffer.from(asset.data, "base64")
  return new Response(body, { headers })
}

async function resolveNotesAsset(rel: string): Promise<EmbeddedAsset | null> {
  const embeddedMatch = bundledNotesUIAssetMap[rel]
  if (embeddedMatch) return embeddedMatch

  if (rel === "web/mermaid.min.js") return MERMAID_DIST_PATH

  const local = rel.startsWith("web/") ? resolve(NOTES_UI_DIR, rel.slice("web/".length)) : resolve(NOTES_UI_DIR, rel)
  if (!inside(NOTES_UI_DIR, local)) return null
  return local
}

async function rawFile(rel: string): Promise<Response> {
  const path = safePath(rel)
  if (!(await existsFile(path)))
    throw new WebUIError("file_not_found", "file not found", 404, { path: noteRelativePath(path) })
  const buf = await readFile(path)
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": textMime(path),
      "Content-Length": String(buf.byteLength),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  })
}

async function apiPlantUML(req: Request): Promise<Response> {
  const body = await req.text()
  if (!body.trim()) return json({ ok: false, error: "empty body" }, 400)

  const which = Bun.spawnSync(["which", "plantuml"])
  if (which.exitCode !== 0) {
    return json({ ok: false, error: "plantuml binary not found — install plantuml locally" }, 503)
  }

  try {
    const result = Bun.spawnSync(["plantuml", "-tsvg", "-pipe", "-charset", "UTF-8"], {
      stdin: new TextEncoder().encode(body),
    })

    const svg = new TextDecoder().decode(result.stdout)
    const stderr = new TextDecoder().decode(result.stderr)

    if (result.exitCode !== 0 || !svg.includes("<svg")) {
      return json(
        {
          ok: false,
          error: `plantuml error (exit ${result.exitCode}): ${stderr.slice(0, 400) || svg.slice(0, 200)}`,
        },
        500,
      )
    }

    return new Response(svg, {
      headers: {
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    })
  } catch (error) {
    return json(
      { ok: false, error: `plantuml spawn failed: ${error instanceof Error ? error.message : String(error)}` },
      500,
    )
  }
}

function escapeHtml(input: string) {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

function resolveNoteLink(fromDir: string, href: string) {
  if (href.startsWith("http") || href.startsWith("/")) return href
  const parts = (fromDir ? `${fromDir}/${href}` : href).split("/")
  const out: string[] = []
  for (const part of parts) {
    if (!part || part === ".") continue
    if (part === "..") out.pop()
    else out.push(part)
  }
  return out.join("/")
}

async function renderMarkdown(src: string, relPath: string): Promise<string> {
  const files = await getNoteFiles()
  const stems = new Map(files.map((file) => [basename(file.path, extname(file.path)).toLowerCase(), file.path]))
  const fromDir = dirname(relPath).replace(/^\.\//, "").replace(/^\.$/, "")
  const lines = src.split(/\r?\n/)
  const out: string[] = []
  let inCode = false
  let codeLang = ""
  let codeLines: string[] = []
  let inList = false
  let skipTag = ""

  const flushList = () => {
    if (!inList) return
    out.push("</ul>")
    inList = false
  }

  const renderInlineLink = (text: string, href: string) => {
    const scheme = href.split(":")[0].toLowerCase()
    if (scheme === "javascript" || scheme === "data") return text
    if (href.startsWith("http://") || href.startsWith("https://")) {
      return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${text}</a>`
    }
    const resolved = resolveNoteLink(fromDir, decodeURIComponent(href))
    const ext = extname(resolved).toLowerCase()
    if (ALLOWED_NOTE_EXTS.has(ext)) {
      return `<a href="${NOTES_BASE_PATH}/serve/${encodeURIComponent(resolved)}">${text}</a>`
    }
    return `<a href="${escapeHtml(href)}">${text}</a>`
  }

  const renderInline = (value: string) => {
    let rendered = escapeHtml(value)
    rendered = rendered.replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_, target, alias) => {
      const label = alias ?? target
      const resolved = stems.get(target.trim().toLowerCase()) ?? target.trim()
      return `<a href="${NOTES_BASE_PATH}/view/${encodeURIComponent(resolved)}">${label}</a>`
    })
    rendered = rendered.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, href) => {
      const rawHref = href
        .replaceAll("&amp;", "&")
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&quot;", '"')
        .replaceAll("&#39;", "'")
      return renderInlineLink(text, rawHref)
    })
    rendered = rendered.replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a, b) => `<strong>${a ?? b}</strong>`)
    rendered = rendered.replace(/\*(.+?)\*|_(.+?)_/g, (_, a, b) => `<em>${a ?? b}</em>`)
    rendered = rendered.replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`)
    return rendered
  }

  for (const line of lines) {
    if (!inCode && /^```/.test(line)) {
      flushList()
      inCode = true
      codeLang = line.slice(3).trim()
      codeLines = []
      continue
    }
    if (inCode) {
      if (/^```/.test(line)) {
        const langClass = codeLang ? ` class="language-${escapeHtml(codeLang)}"` : ""
        out.push(`<pre><code${langClass}>${escapeHtml(codeLines.join("\n"))}</code></pre>`)
        inCode = false
        codeLang = ""
        codeLines = []
      } else {
        codeLines.push(line)
      }
      continue
    }

    if (/^<script[\s>]/i.test(line)) {
      skipTag = "script"
      continue
    }
    if (/^<style[\s>]/i.test(line)) {
      skipTag = "style"
      continue
    }
    if (skipTag) {
      if (new RegExp(`^</${skipTag}>`, "i").test(line)) skipTag = ""
      continue
    }

    if (/^<(Callout|Card)[\s>]/.test(line)) {
      out.push(`<div class="${line.match(/<(\w+)/)?.[1]?.toLowerCase() ?? "component"}">`)
      continue
    }
    if (/^<\/(Callout|Card)>/.test(line)) {
      out.push("</div>")
      continue
    }
    if (/^<[A-Z]/.test(line)) continue

    const heading = line.match(/^(#{1,6})\s+(.*)/)
    if (heading) {
      flushList()
      const level = heading[1].length
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`)
      continue
    }

    if (line.startsWith("> ")) {
      flushList()
      out.push(`<blockquote>${renderInline(line.slice(2))}</blockquote>`)
      continue
    }

    const list = line.match(/^[-*+]\s+(.*)/)
    if (list) {
      if (!inList) {
        out.push("<ul>")
        inList = true
      }
      out.push(`<li>${renderInline(list[1])}</li>`)
      continue
    }

    if (line.trim() === "") {
      flushList()
      out.push("")
      continue
    }

    flushList()
    out.push(`<p>${renderInline(line)}</p>`)
  }

  flushList()
  if (inCode) {
    const langClass = codeLang ? ` class="language-${escapeHtml(codeLang)}"` : ""
    out.push(`<pre><code${langClass}>${escapeHtml(codeLines.join("\n"))}</code></pre>`)
  }

  return out.join("\n")
}

async function serveFile(rel: string): Promise<Response> {
  const path = safePath(rel)
  const ext = extname(path).toLowerCase()
  if (!ALLOWED_NOTE_EXTS.has(ext)) return json({ ok: false, error: "extension not supported" }, 400)
  if (!(await existsFile(path))) return json({ ok: false, error: "file not found" }, 404)

  const securityHeaders = {
    "Cache-Control": "no-store",
    "Content-Security-Policy": HTML_CSP,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
  }

  if (ext === ".txt") {
    const buf = await readFile(path)
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": String(buf.byteLength),
        ...securityHeaders,
      },
    })
  }

  if (ext === ".html" || ext === ".htm") {
    const buf = await readFile(path)
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": String(buf.byteLength),
        ...securityHeaders,
      },
    })
  }

  const relPath = noteRelativePath(path)
  const source = await readFile(path, "utf8")
  const rendered = await renderMarkdown(source, relPath)
  const title = escapeHtml(basename(relPath, ext))
  const viewPath = encodeURIComponent(relPath)
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <link rel="stylesheet" href="${NOTES_BASE_PATH}/web/style.css">
</head>
<body class="serve-page theme-dark">
  <nav class="serve-nav">
    <a href="${NOTES_BASE_PATH}/view/${viewPath}" class="serve-back">← Open in notes</a>
  </nav>
  <article class="serve-content markdown-body">
${rendered}
  </article>
</body>
</html>`

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": String(Buffer.byteLength(html, "utf8")),
      ...securityHeaders,
    },
  })
}

async function walk(dir: string, out: NoteFile[] = []): Promise<NoteFile[]> {
  const root = currentRoot()
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (dir === root && !ALLOWED_NOTE_TOP_LEVELS.has(entry.name)) continue
      await walk(path, out)
      continue
    }
    if (!entry.isFile()) continue
    const ext = extname(entry.name).toLowerCase()
    if (!ALLOWED_NOTE_EXTS.has(ext)) continue
    const info = await stat(path)
    out.push({
      path: relative(currentRoot(), path).replaceAll(sep, "/"),
      name: entry.name,
      ext,
      size: info.size,
    })
  }
  return out
}

async function apiTree(): Promise<Response> {
  return json({ ok: true, root: currentRoot(), files: await getNoteFiles() })
}

async function apiGetFile(url: URL): Promise<Response> {
  const rel = url.searchParams.get("path") ?? ""
  const path = safePath(rel)
  if (!(await existsFile(path)))
    throw new WebUIError("file_not_found", "file not found", 404, { path: noteRelativePath(path) })
  if (!ALLOWED_NOTE_EXTS.has(extname(path).toLowerCase())) {
    throw new WebUIError("extension_not_supported", "Extension is not supported in notes", 400, {
      path: noteRelativePath(path),
    })
  }
  const info = await stat(path)
  ensureReadableSize(info.size, path)
  return json({
    ok: true,
    path: noteRelativePath(path),
    ext: extname(path).toLowerCase(),
    content: await readFile(path, "utf8"),
    mtime: info.mtimeMs / 1000,
    size: info.size,
  })
}

async function parseJson(req: Request): Promise<any> {
  const text = await req.text()
  return text ? JSON.parse(text) : {}
}

function stamp() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z")
}

async function backup(path: string) {
  if (!(await existsFile(path))) return null
  const directory = backupRoot()
  const rel = relative(currentRoot(), path).split(sep).join("__")
  const target = join(directory, `${stamp()}__${rel}`)
  await mkdir(dirname(target), { recursive: true })
  await copyFile(path, target)
  return target
}

async function apiSaveFile(req: Request, url: URL): Promise<Response> {
  const rel = url.searchParams.get("path") ?? ""
  const path = safePath(rel)
  ensureEditable(path)
  const body = await parseJson(req)
  if (typeof body.content !== "string") throw new WebUIError("invalid_content", "content must be string", 400)
  ensureEditSize(body.content)
  if (!(await existsFile(path)))
    throw new WebUIError("file_not_found", "file not found", 404, { path: noteRelativePath(path) })
  const backupPath = await backup(path)
  await writeFile(path, body.content, "utf8")
  invalidateNotesIndexCache()
  const info = await stat(path)
  return json({
    ok: true,
    path: noteRelativePath(path),
    backup: backupPath ? noteRelativePath(backupPath) : null,
    size: info.size,
  })
}

async function apiCreateFile(req: Request): Promise<Response> {
  const body = await parseJson(req)
  if (typeof body.path !== "string" || typeof body.content !== "string") {
    throw new WebUIError("invalid_content", "path/content invalid", 400)
  }
  ensureEditSize(body.content)
  const path = safePath(body.path)
  ensureEditable(path)
  if (existsSync(path))
    throw new WebUIError("file_exists", "file already exists", 409, { path: noteRelativePath(path) })
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, body.content, "utf8")
  invalidateNotesIndexCache()
  return json({ ok: true, path: noteRelativePath(path) }, 201)
}

async function apiDeleteFile(url: URL): Promise<Response> {
  const rel = url.searchParams.get("path") ?? ""
  const path = safePath(rel)
  ensureEditable(path)
  if (!(await existsFile(path)))
    throw new WebUIError("file_not_found", "file not found", 404, { path: noteRelativePath(path) })
  const backupPath = await backup(path)
  await unlink(path)
  invalidateNotesIndexCache()
  return json({
    ok: true,
    path: noteRelativePath(path),
    backup: backupPath ? noteRelativePath(backupPath) : null,
  })
}

async function apiMove(req: Request): Promise<Response> {
  const body = await parseJson(req)
  const source = safePath(String(body.from ?? ""))
  const target = safePath(String(body.to ?? ""))
  ensureEditable(source)
  ensureEditable(target)
  if (!(await existsFile(source))) {
    throw new WebUIError("file_not_found", "file not found", 404, { path: noteRelativePath(source) })
  }
  if (existsSync(target)) throw new WebUIError("file_exists", "target exists", 409, { path: noteRelativePath(target) })
  const backupPath = await backup(source)
  await mkdir(dirname(target), { recursive: true })
  await rename(source, target)
  invalidateNotesIndexCache()
  return json({
    ok: true,
    from: noteRelativePath(source),
    to: noteRelativePath(target),
    backup: backupPath ? noteRelativePath(backupPath) : null,
  })
}

async function apiSearch(url: URL): Promise<Response> {
  const query = (url.searchParams.get("q") ?? "").trim().toLowerCase()
  const results: Array<{ path: string; line: number; text: string; kind?: "file" | "content" }> = []
  if (!query) return json({ ok: true, query, results })

  const files = await getNoteFiles()
  const seen = new Set<string>()

  for (const file of files) {
    const name = basename(file.path, extname(file.path)).toLowerCase()
    if (!name.includes(query) && !file.path.toLowerCase().includes(query)) continue
    results.push({ path: file.path, line: 0, text: file.name, kind: "file" })
    seen.add(file.path)
    if (results.length >= 80) break
  }

  for (const file of files) {
    if (results.length >= 200) break
    const text = await readFile(join(currentRoot(), file.path), "utf8")
    text.split(/\r?\n/).some((line, index) => {
      if (line.toLowerCase().includes(query)) {
        if (!seen.has(file.path) || results.length < 120) {
          results.push({
            path: file.path,
            line: index + 1,
            text: line.trim().slice(0, 300),
            kind: "content",
          })
        }
      }
      return results.length >= 200
    })
  }

  return json({ ok: true, query, results })
}

async function graphData(): Promise<{ nodes: string[]; edges: Edge[] }> {
  const files = await getNoteFiles()
  const stems = new Map(files.map((file) => [basename(file.path, extname(file.path)).toLowerCase(), file.path]))
  const edges: Edge[] = []
  for (const file of files) {
    const text = await readFile(join(currentRoot(), file.path), "utf8")
    const targets = new Set<string>()
    for (const match of text.matchAll(WIKILINK_RE)) {
      targets.add(stems.get(match[1].trim().toLowerCase()) ?? match[1].trim())
    }
    const fromDir = dirname(file.path).replace(/^\.\//, "").replace(/^\.$/, "")
    for (const match of text.matchAll(MD_LINK_RE)) {
      targets.add(resolveNoteLink(fromDir, decodeURIComponent(match[1])))
    }
    for (const target of [...targets].sort()) {
      edges.push({ from: file.path, to: target })
    }
  }
  return { nodes: files.map((file) => file.path), edges }
}

async function apiGraph(): Promise<Response> {
  return json({ ok: true, ...(await graphData()) })
}

async function apiBacklinks(url: URL): Promise<Response> {
  const target = url.searchParams.get("path") ?? ""
  const stem = basename(target, extname(target)).toLowerCase()
  const backlinks: Array<{ path: string }> = []
  for (const file of await getNoteFiles()) {
    if (file.path === target) continue
    const text = (await readFile(join(currentRoot(), file.path), "utf8")).toLowerCase()
    if (stem && (text.includes(`[[${stem}`) || text.includes(target.toLowerCase()))) {
      backlinks.push({ path: file.path })
    }
  }
  return json({ ok: true, path: target, backlinks })
}

async function apiAiAsk(req: Request): Promise<Response> {
  const body = await parseJson(req)
  const question = String(body.question ?? "").trim()
  const current = String(body.path ?? "").trim()
  let answer = "Local assistant mode: no external LLM configured. "

  if (!question) {
    answer += "Ask: summarize this note, related notes, where is X?"
    return json({ ok: true, answer })
  }

  if (/related|link/i.test(question)) {
    const graph = await graphData()
    const related = [
      ...graph.edges.filter((edge) => edge.from === current).map((edge) => edge.to),
      ...graph.edges.filter((edge) => edge.to === current).map((edge) => edge.from),
    ]
    answer += `Related notes: ${[...new Set(related)].sort().join(", ") || "none found"}`
    return json({ ok: true, answer })
  }

  if (/summar/i.test(question) && current) {
    const path = safePath(current)
    const text = existsSync(path) ? await readFile(path, "utf8") : ""
    const headings = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("#"))
      .map((line) => line.replace(/^#+\s*/, ""))
    answer += `Summary heuristic: ${headings.slice(0, 8).join("; ") || text.slice(0, 500)}`
    return json({ ok: true, answer })
  }

  const terms = [...question.toLowerCase().matchAll(/\w+/g)]
    .map((match) => match[0])
    .filter((term) => term.length > 3)
    .slice(0, 5)
  const hits: Array<[number, string]> = []
  for (const file of await getNoteFiles()) {
    const text = (await readFile(join(currentRoot(), file.path), "utf8")).toLowerCase()
    const score = terms.reduce((total, term) => total + text.split(term).length - 1, 0)
    if (score) hits.push([score, file.path])
  }
  hits.sort((a, b) => b[0] - a[0])
  answer += `Matches: ${
    hits
      .slice(0, 10)
      .map(([, path]) => path)
      .join(", ") || "none found"
  }`
  return json({ ok: true, answer })
}
