import type { FileNode } from "@opencode-ai/sdk/v2"
import { Collapsible } from "@opencode-ai/ui/collapsible"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/icon"
import { Markdown } from "@opencode-ai/ui/markdown"
import { For, Match, Show, Switch, createEffect, createMemo, createResource, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useServer } from "@/context/server"
import { useSurfaceSessionBridge } from "@/surface/session-provider"
import type { SurfaceNoteFile } from "@/surface/ports"
import { anchorSlug, findAnchorElement, localAnchorFromHref, safeDecode } from "./anchor-navigation"

declare global {
  interface Window {
    mermaid?: {
      initialize: (config: Record<string, unknown>) => void
      render: (id: string, source: string) => Promise<{ svg: string }>
    }
  }
}

type DiagramLang = "mermaid" | "plantuml" | "puml"
type Block =
  | { type: "markdown"; text: string }
  | { type: "diagram"; lang: DiagramLang; code: string }
  | { type: "html"; code: string }
type NoteTreeNode =
  | { type: "directory"; name: string; path: string; children: NoteTreeNode[] }
  | { type: "file"; file: SurfaceNoteFile }
type NoteLinkTarget =
  | { kind: "none" }
  | { kind: "blocked" }
  | { kind: "external" }
  | { kind: "anchor"; anchor: string }
  | { kind: "note"; path: string; anchor?: string }
type NoteHistoryEntry = { path: string; anchor?: string }
type NoteHeading = { depth: number; text: string; anchor: string }

let mermaidLoad: Promise<void> | undefined
let mermaidLoadUrl = ""
const DIAGRAM_CACHE_LIMIT = 256
const diagramCache = new Map<string, string>()
const NOTE_FILE_EXTS = new Set([".md", ".mdx", ".txt", ".html", ".htm"])
const ABSOLUTE_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/
const WIKILINK_RE = /!?\[\[([^\]]+)\]\]/g
const notesTabCache = {
  selectedPath: undefined as string | undefined,
  query: "",
  expanded: {} as Record<string, boolean>,
  history: [] as NoteHistoryEntry[],
  historyIndex: -1,
}

function loadMermaid(url: string) {
  if (typeof window === "undefined") return Promise.resolve()
  if (window.mermaid) return Promise.resolve()
  if (mermaidLoad && mermaidLoadUrl === url) return mermaidLoad
  mermaidLoadUrl = url
  mermaidLoad = new Promise((resolve, reject) => {
    const script = document.createElement("script")
    script.src = url
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error("Unable to load Mermaid renderer"))
    document.head.appendChild(script)
  })
  return mermaidLoad
}

function readDiagramCache(key: string) {
  const value = diagramCache.get(key)
  if (!value) return
  diagramCache.delete(key)
  diagramCache.set(key, value)
  return value
}

function writeDiagramCache(key: string, value: string) {
  if (diagramCache.has(key)) diagramCache.delete(key)
  diagramCache.set(key, value)
  while (diagramCache.size > DIAGRAM_CACHE_LIMIT) {
    const oldest = diagramCache.keys().next().value as string | undefined
    if (!oldest) return
    diagramCache.delete(oldest)
  }
}

function normalizePath(input: string) {
  return input.replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+/g, "/")
}

function pathExt(path: string) {
  const index = path.lastIndexOf(".")
  if (index === -1) return ""
  return path.slice(index).toLowerCase()
}

function baseName(path: string) {
  const normalized = normalizePath(path)
  const index = normalized.lastIndexOf("/")
  return index === -1 ? normalized : normalized.slice(index + 1)
}

function stemName(path: string) {
  const file = baseName(path)
  const ext = pathExt(file)
  return ext ? file.slice(0, -ext.length) : file
}

function parentDirectory(path: string) {
  const normalized = normalizePath(path)
  const index = normalized.lastIndexOf("/")
  return index === -1 ? "" : normalized.slice(0, index)
}

function joinPath(baseDir: string, hrefPath: string) {
  const source = hrefPath.startsWith("/") ? hrefPath : `${baseDir ? `${baseDir}/` : ""}${hrefPath}`
  const out: string[] = []
  for (const part of normalizePath(source).split("/")) {
    if (!part || part === ".") continue
    if (part === "..") {
      out.pop()
      continue
    }
    out.push(part)
  }
  return out.join("/")
}

function splitHref(input: string) {
  const trimmed = input.trim()
  const hashIndex = trimmed.indexOf("#")
  const hash = hashIndex === -1 ? undefined : safeDecode(trimmed.slice(hashIndex + 1))
  const withoutHash = hashIndex === -1 ? trimmed : trimmed.slice(0, hashIndex)
  const queryIndex = withoutHash.indexOf("?")
  const path = queryIndex === -1 ? withoutHash : withoutHash.slice(0, queryIndex)
  return { path, hash }
}

function isExternalHref(hrefRaw: string) {
  const href = hrefRaw.trim()
  if (!href) return false
  if (href.startsWith("//")) return true
  if (!ABSOLUTE_SCHEME_RE.test(href)) return false
  const scheme = href.split(":")[0]?.toLowerCase()
  return scheme === "http" || scheme === "https" || scheme === "mailto" || scheme === "tel"
}

function buildPathLookup(files: SurfaceNoteFile[]) {
  return new Map(files.map((file) => [normalizePath(file.path).toLowerCase(), normalizePath(file.path)]))
}

function buildStemLookup(files: SurfaceNoteFile[]) {
  const out = new Map<string, string>()
  for (const file of files) {
    const normalized = normalizePath(file.path)
    const stem = stemName(normalized).toLowerCase()
    if (!out.has(stem)) out.set(stem, normalized)
    const basename = baseName(normalized).toLowerCase()
    if (!out.has(basename)) out.set(basename, normalized)
  }
  return out
}

function lookupNotePath(path: string, pathLookup: ReadonlyMap<string, string>) {
  const normalized = normalizePath(path)
  const direct = pathLookup.get(normalized.toLowerCase())
  if (direct) return direct

  if (pathExt(normalized)) return
  for (const candidate of NOTE_FILE_EXTS) {
    const hit = pathLookup.get(`${normalized}${candidate}`.toLowerCase())
    if (hit) return hit
  }
}

function resolveNoteTarget(input: {
  href: string
  fromPath: string
  pathLookup: ReadonlyMap<string, string>
  stemLookup: ReadonlyMap<string, string>
}): NoteLinkTarget {
  const hrefRaw = input.href.trim()
  if (!hrefRaw) return { kind: "none" }
  if (hrefRaw.startsWith("#")) return { kind: "anchor", anchor: safeDecode(hrefRaw.slice(1)) }

  const noteRoute = splitHref(hrefRaw)
  if (
    noteRoute.path.startsWith("/notes/view/") ||
    noteRoute.path.startsWith("/notes/serve/") ||
    noteRoute.path.startsWith("/notes/raw/")
  ) {
    const [, , , ...segments] = noteRoute.path.split("/")
    const rel = safeDecode(segments.join("/"))
    const normalized = normalizePath(rel)
    const resolved = input.pathLookup.get(normalized.toLowerCase())
    if (resolved) return { kind: "note", path: resolved, anchor: noteRoute.hash }
    return { kind: "none" }
  }

  if (hrefRaw.startsWith("//")) return { kind: "external" }
  if (ABSOLUTE_SCHEME_RE.test(hrefRaw)) {
    const scheme = hrefRaw.split(":")[0]?.toLowerCase()
    if (scheme === "http" || scheme === "https" || scheme === "mailto" || scheme === "tel") return { kind: "external" }
    return { kind: "blocked" }
  }

  const { path, hash } = splitHref(safeDecode(hrefRaw))
  if (!path && hash) return { kind: "anchor", anchor: hash }
  if (!path) return { kind: "none" }

  const fromDir = parentDirectory(input.fromPath)
  const relativePath = joinPath(fromDir, path)
  const relativeHit = lookupNotePath(relativePath, input.pathLookup)
  if (relativeHit) return { kind: "note", path: relativeHit, anchor: hash }

  const vaultPath = normalizePath(path)
  const vaultHit = lookupNotePath(vaultPath, input.pathLookup)
  if (vaultHit) return { kind: "note", path: vaultHit, anchor: hash }

  const byStem = input.stemLookup.get(stemName(path).toLowerCase())
  if (byStem) return { kind: "note", path: byStem, anchor: hash }

  return { kind: "none" }
}

function formatMarkdownLink(path: string, anchor?: string) {
  const encodedPath = encodeURI(path).replaceAll("(", "%28").replaceAll(")", "%29")
  const encodedAnchor = anchor ? `#${encodeURIComponent(anchor)}` : ""
  return `${encodedPath}${encodedAnchor}`
}

function formatNoteRouteLink(path: string, anchor?: string) {
  return `/notes/view/${formatMarkdownLink(path, anchor)}`
}

function unescapeWikilinkPart(value: string) {
  return value.replace(/\\([|#[\]])/g, "$1").trim()
}

function parseWikilink(raw: string) {
  const pipeIndex = raw.indexOf("|")
  const targetPart = pipeIndex === -1 ? raw : raw.slice(0, pipeIndex).replace(/\\$/, "")
  const aliasPart = pipeIndex === -1 ? undefined : raw.slice(pipeIndex + 1)
  const hashIndex = targetPart.indexOf("#")
  const path = unescapeWikilinkPart(hashIndex === -1 ? targetPart : targetPart.slice(0, hashIndex))
  const anchor = hashIndex === -1 ? undefined : unescapeWikilinkPart(targetPart.slice(hashIndex + 1))
  const alias = aliasPart === undefined ? undefined : unescapeWikilinkPart(aliasPart)
  return { path, anchor, alias }
}

function markdownLinkLabel(value: string) {
  return value.replace(/\]/g, "\\]")
}

function preprocessMarkdownLinks(
  markdown: string,
  input: {
    fromPath: string
    pathLookup: ReadonlyMap<string, string>
    stemLookup: ReadonlyMap<string, string>
  },
) {
  return markdown.replace(WIKILINK_RE, (full, rawTarget: string) => {
    const parsed = parseWikilink(String(rawTarget ?? ""))
    const target = `${parsed.path}${parsed.anchor ? `#${parsed.anchor}` : ""}`
    const resolved = resolveNoteTarget({
      href: target,
      fromPath: input.fromPath,
      pathLookup: input.pathLookup,
      stemLookup: input.stemLookup,
    })
    if (resolved.kind !== "note" && resolved.kind !== "anchor") return full

    const label = markdownLinkLabel(
      parsed.alias || parsed.path || parsed.anchor || (resolved.kind === "note" ? resolved.path : resolved.anchor),
    )
    if (resolved.kind === "anchor") return `[${label}](#${encodeURIComponent(resolved.anchor)})`
    return `[${label}](${formatNoteRouteLink(resolved.path, resolved.anchor)})`
  })
}

function parseBlocks(content: string): Block[] {
  const blocks: Block[] = []
  const re = /```([a-zA-Z0-9_-]+)?\s*\n([\s\S]*?)```/g
  let offset = 0
  for (const match of content.matchAll(re)) {
    const index = match.index ?? 0
    if (index > offset) blocks.push({ type: "markdown", text: content.slice(offset, index) })
    const lang = String(match[1] ?? "")
      .toLowerCase()
      .trim()
    const code = String(match[2] ?? "").trim()
    if (lang === "mermaid" || lang === "plantuml" || lang === "puml") {
      blocks.push({ type: "diagram", lang, code })
    } else if (lang === "html") {
      blocks.push({ type: "html", code })
    } else {
      blocks.push({ type: "markdown", text: match[0] })
    }
    offset = index + match[0].length
  }
  if (offset < content.length) blocks.push({ type: "markdown", text: content.slice(offset) })
  return blocks.filter((block) => {
    if (block.type === "diagram") return true
    if (block.type === "html") return block.code.trim().length > 0
    return block.text.trim().length > 0
  })
}

function stripInlineMarkdown(text: string) {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[\`*_~]/g, "")
    .trim()
}

function extractNoteHeadings(content: string): NoteHeading[] {
  const headings: NoteHeading[] = []
  const seen = new Map<string, number>()
  let inFence = false
  let inFrontmatter = false
  const lines = content.replace(/\r\n?/g, "\n").split("\n")

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ""
    if (index === 0 && line.trim() === "---") {
      inFrontmatter = true
      continue
    }
    if (inFrontmatter) {
      if (line.trim() === "---") inFrontmatter = false
      continue
    }
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue

    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (!match) continue
    const text = stripInlineMarkdown(match[2] ?? "")
    if (!text) continue
    const base = anchorSlug(text) || "section"
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    headings.push({ depth: match[1]!.length, text, anchor: count === 0 ? base : `${base}-${count}` })
  }
  return headings
}

function hasExplicitIndex(headings: NoteHeading[]) {
  return headings.some((heading) => heading.depth <= 2 && anchorSlug(heading.text) === "index")
}

function isAtomicNotePath(path: string) {
  return normalizePath(path).split("/")[0]?.toLowerCase() === "atomic"
}

function HtmlFrame(props: { title: string; content: string; onNavigate?: (href: string) => void; class?: string }) {
  let frame: HTMLIFrameElement | undefined
  let cleanup: (() => void) | undefined

  const bindNavigation = () => {
    cleanup?.()
    if (!frame || !props.onNavigate) return
    const doc = frame.contentDocument
    if (!doc) return

    const onClick = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const anchor = target.closest("a[href]")
      if (!(anchor instanceof HTMLAnchorElement)) return
      const href = anchor.getAttribute("href") ?? ""
      if (!href) return
      if (isExternalHref(href)) return
      event.preventDefault()
      event.stopPropagation()
      props.onNavigate?.(href)
    }

    doc.addEventListener("click", onClick)
    cleanup = () => doc.removeEventListener("click", onClick)
  }

  createEffect(() => {
    props.content
    queueMicrotask(bindNavigation)
  })

  onCleanup(() => {
    cleanup?.()
  })

  return (
    <iframe
      ref={(element) => {
        frame = element
      }}
      onLoad={bindNavigation}
      title={props.title}
      sandbox="allow-same-origin allow-popups"
      class={`w-full min-h-56 rounded-lg border border-border-weaker-base bg-white ${props.class ?? ""}`}
      srcdoc={props.content}
    />
  )
}

function DiagramBlock(props: { lang: DiagramLang; code: string }) {
  const bridge = useSurfaceSessionBridge()
  const [state, setState] = createStore({ html: "", error: "" })
  let disposed = false
  onCleanup(() => {
    disposed = true
  })

  createEffect(() => {
    const code = props.code
    const lang = props.lang
    setState({ html: "", error: "" })
    const theme = document.documentElement.dataset.colorScheme === "light" ? "default" : "dark"
    const cacheKey = `${lang}:${lang === "mermaid" ? theme : "default"}:${code}`
    const cached = readDiagramCache(cacheKey)
    if (cached) {
      setState("html", cached)
      return
    }
    void (async () => {
      try {
        if (lang === "mermaid") {
          await loadMermaid(bridge.getMermaidScriptUrl())
          window.mermaid?.initialize({
            startOnLoad: false,
            theme,
            securityLevel: "antiscript",
            fontFamily: "inherit",
          })
          const id =
            typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
              ? `surface-mermaid-${crypto.randomUUID()}`
              : `surface-mermaid-${Date.now()}-${Math.floor(Math.random() * 1e9)}`
          const { svg } = await window.mermaid!.render(id, code)
          writeDiagramCache(cacheKey, svg)
          if (!disposed) setState("html", svg)
          return
        }
        const svg = await bridge.renderPlantUML(code)
        const normalized = svg.replace(/<\?xml[^>]*>/, "").trim()
        writeDiagramCache(cacheKey, normalized)
        if (!disposed) setState("html", normalized)
      } catch (err) {
        if (!disposed) setState("error", err instanceof Error ? err.message : String(err))
      }
    })()
  })

  return (
    <div class="rounded-lg border border-border-weaker-base bg-surface-base/60 p-3 overflow-auto">
      <Show when={state.html} fallback={<div class="text-12-regular text-text-weak">Rendering {props.lang}…</div>}>
        {(value) => <div class="min-w-max text-text-base" innerHTML={value()} />}
      </Show>
      <Show when={state.error}>{(value) => <div class="mt-2 text-12-regular text-danger">{value()}</div>}</Show>
    </div>
  )
}

function NoteTree(props: {
  nodes: NoteTreeNode[]
  level: number
  activePath?: string
  expanded: Readonly<Record<string, boolean>>
  autoExpand: ReadonlySet<string>
  onToggle: (path: string, open: boolean) => void
  onSelect: (path: string) => void
}) {
  const rowPadding = (level: number, file: boolean) => `${Math.max(0, 8 + level * 12 - (file ? 24 : 4))}px`
  const iconNode = (file: SurfaceNoteFile): FileNode =>
    ({
      name: file.name,
      path: file.path,
      absolute: file.path,
      type: "file",
      ignored: false,
    }) as FileNode

  return (
    <div class="flex flex-col gap-0.5">
      <For each={props.nodes}>
        {(node) => (
          <Switch>
            <Match when={node.type === "directory"}>
              {(() => {
                const directory = node as Extract<NoteTreeNode, { type: "directory" }>
                const open = () => props.autoExpand.has(directory.path) || !!props.expanded[directory.path]
                return (
                  <Collapsible
                    variant="ghost"
                    class="w-full"
                    data-scope="filetree"
                    forceMount={false}
                    open={open()}
                    onOpenChange={(next) => props.onToggle(directory.path, next)}
                  >
                    <Collapsible.Trigger>
                      <button
                        type="button"
                        class="w-full min-w-0 h-6 flex items-center justify-start gap-x-1.5 rounded-md px-1.5 py-0 text-left hover:bg-surface-raised-base-hover active:bg-surface-base-active transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                        style={{ "padding-left": rowPadding(props.level, false) }}
                        aria-expanded={open()}
                        aria-label={`Toggle note folder ${directory.path || directory.name}`}
                        title={directory.path}
                      >
                        <div class="size-4 flex items-center justify-center text-icon-weak">
                          <Icon name={open() ? "chevron-down" : "chevron-right"} size="small" />
                        </div>
                        <span class="flex-1 min-w-0 text-12-medium whitespace-nowrap truncate text-text-weak">
                          {directory.name}
                        </span>
                      </button>
                    </Collapsible.Trigger>
                    <Collapsible.Content class="relative pt-0.5">
                      <NoteTree
                        nodes={directory.children}
                        level={props.level + 1}
                        activePath={props.activePath}
                        expanded={props.expanded}
                        autoExpand={props.autoExpand}
                        onToggle={props.onToggle}
                        onSelect={props.onSelect}
                      />
                    </Collapsible.Content>
                  </Collapsible>
                )
              })()}
            </Match>
            <Match when={node.type === "file"}>
              {(() => {
                const fileNode = node as Extract<NoteTreeNode, { type: "file" }>
                const active = () => props.activePath === fileNode.file.path
                return (
                  <button
                    type="button"
                    class="w-full min-w-0 h-6 flex items-center justify-start gap-x-1.5 rounded-md px-1.5 py-0 text-left hover:bg-surface-raised-base-hover active:bg-surface-base-active transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                    aria-label={`Open note ${fileNode.file.path}`}
                    classList={{
                      "bg-surface-base-active": active(),
                    }}
                    style={{ "padding-left": rowPadding(props.level, true) }}
                    title={fileNode.file.path}
                    onClick={() => props.onSelect(fileNode.file.path)}
                  >
                    <div class="w-4 shrink-0" />
                    <FileIcon
                      node={iconNode(fileNode.file)}
                      class="size-4 filetree-icon filetree-icon--mono shrink-0"
                      mono
                    />
                    <span class="flex-1 min-w-0 text-12-medium whitespace-nowrap truncate text-text-weak">
                      {fileNode.file.name}
                    </span>
                  </button>
                )
              })()}
            </Match>
          </Switch>
        )}
      </For>
    </div>
  )
}

function buildNoteTree(files: SurfaceNoteFile[]): NoteTreeNode[] {
  const root: NoteTreeNode = { type: "directory", name: "", path: "", children: [] }
  const dirs = new Map<string, Extract<NoteTreeNode, { type: "directory" }>>([
    ["", root as Extract<NoteTreeNode, { type: "directory" }>],
  ])

  const upsertDirectory = (path: string) => {
    const normalized = normalizePath(path)
    const existing = dirs.get(normalized)
    if (existing) return existing
    const parentPath = parentDirectory(normalized)
    const parent = upsertDirectory(parentPath)
    const directory: Extract<NoteTreeNode, { type: "directory" }> = {
      type: "directory",
      name: baseName(normalized),
      path: normalized,
      children: [],
    }
    parent.children.push(directory)
    dirs.set(normalized, directory)
    return directory
  }

  for (const file of files) {
    const normalized = normalizePath(file.path)
    const dir = upsertDirectory(parentDirectory(normalized))
    dir.children.push({ type: "file", file: { ...file, path: normalized } })
  }

  const sortNode = (node: Extract<NoteTreeNode, { type: "directory" }>) => {
    node.children.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1
      const aName = a.type === "directory" ? a.name : a.file.name
      const bName = b.type === "directory" ? b.name : b.file.name
      return aName.localeCompare(bName)
    })
    for (const child of node.children) if (child.type === "directory") sortNode(child)
  }
  sortNode(root as Extract<NoteTreeNode, { type: "directory" }>)
  return (root as Extract<NoteTreeNode, { type: "directory" }>).children
}

function ancestorDirectories(path: string) {
  const normalized = normalizePath(path)
  const parts = normalized.split("/")
  const out: string[] = []
  for (let index = 0; index < parts.length - 1; index += 1) {
    const dir = parts.slice(0, index + 1).join("/")
    if (dir) out.push(dir)
  }
  return out
}

function NotePreview(props: {
  ext: string
  content: string
  path: string
  files: SurfaceNoteFile[]
  pendingAnchor?: string
  onAnchorHandled?: () => void
  onNavigate?: (href: string) => void
}) {
  const pathLookup = createMemo(() => buildPathLookup(props.files))
  const stemLookup = createMemo(() => buildStemLookup(props.files))
  const headings = createMemo(() => extractNoteHeadings(props.content))
  const generatedIndexHeadings = createMemo(() => headings().filter((heading) => heading.depth > 1))
  const showGeneratedIndex = createMemo(
    () => generatedIndexHeadings().length > 1 && !hasExplicitIndex(headings()) && !isAtomicNotePath(props.path),
  )
  const blocks = createMemo(() =>
    parseBlocks(props.content).map((block) =>
      block.type === "markdown"
        ? {
            ...block,
            text: preprocessMarkdownLinks(block.text, {
              fromPath: props.path,
              pathLookup: pathLookup(),
              stemLookup: stemLookup(),
            }),
          }
        : block,
    ),
  )
  let markdownRoot: HTMLDivElement | undefined
  let markdownClickCleanup: (() => void) | undefined

  const scrollToLocalAnchor = (anchor: string) => {
    const root = markdownRoot
    if (!root) return false
    const target = findAnchorElement(root, anchor)
    if (!(target instanceof HTMLElement)) return false
    target.scrollIntoView({ block: "start", behavior: "smooth" })
    return true
  }

  const scrollToIndex = () => {
    if (scrollToLocalAnchor("index")) return
    markdownRoot?.scrollIntoView({ block: "start", behavior: "smooth" })
  }

  const onMarkdownClick = (event: MouseEvent) => {
    const target = event.target
    if (!(target instanceof Element)) return
    const anchor = target.closest("a[href]")
    if (!(anchor instanceof HTMLAnchorElement)) return
    const href = anchor.getAttribute("href") ?? ""
    if (!href) return

    const localAnchor = localAnchorFromHref(href, props.path)
    if (localAnchor && scrollToLocalAnchor(localAnchor)) {
      event.preventDefault()
      event.stopPropagation()
      return
    }

    if (isExternalHref(href)) return
    event.preventDefault()
    event.stopPropagation()
    props.onNavigate?.(href)
  }

  createEffect(() => {
    const anchor = props.pendingAnchor
    const root = markdownRoot
    props.content
    if (!anchor || !root) return

    let frame: number | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    let observer: MutationObserver | undefined
    const cleanup = () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      if (timeout !== undefined) clearTimeout(timeout)
      observer?.disconnect()
    }
    const scrollToAnchor = () => {
      const target = findAnchorElement(root, anchor)
      if (!(target instanceof HTMLElement)) return
      target.scrollIntoView({ block: "start", behavior: "smooth" })
      props.onAnchorHandled?.()
      cleanup()
    }

    observer = new MutationObserver(scrollToAnchor)
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["id", "name"] })
    frame = requestAnimationFrame(scrollToAnchor)
    timeout = setTimeout(cleanup, 2000)
    onCleanup(cleanup)
  })

  onCleanup(() => markdownClickCleanup?.())

  return (
    <Switch>
      <Match when={props.ext === ".html" || props.ext === ".htm"}>
        <HtmlFrame title={props.path} content={props.content} class="h-full min-h-96" onNavigate={props.onNavigate} />
      </Match>
      <Match when={true}>
        <div
          ref={(element) => {
            markdownClickCleanup?.()
            markdownRoot = element
            element.addEventListener("click", onMarkdownClick, true)
            markdownClickCleanup = () => element.removeEventListener("click", onMarkdownClick, true)
          }}
          class="flex flex-col gap-4 text-13-regular text-text-base"
        >
          <div class="sticky top-0 z-10 flex justify-end">
            <button
              type="button"
              class="inline-flex items-center gap-1.5 rounded-md border border-border-weaker-base bg-background-base/95 px-2 py-1 text-12-medium text-text-base shadow-xs backdrop-blur hover:bg-surface-raised-base-hover"
              onClick={scrollToIndex}
            >
              <Icon name="arrow-up" size="small" />
              Back to index
            </button>
          </div>

          <Show when={showGeneratedIndex()}>
            <nav class="rounded-md border border-border-weaker-base bg-background-base p-3">
              <div class="mb-2 flex items-center gap-2 text-13-medium text-text-strong">
                <Icon name="bullet-list" size="small" />
                Index
              </div>
              <div class="flex flex-col gap-1">
                <For each={generatedIndexHeadings()}>
                  {(heading) => (
                    <button
                      type="button"
                      class="text-left text-12-regular text-text-weak hover:text-text-base"
                      style={{ "padding-left": `${Math.max(0, heading.depth - 2) * 12}px` }}
                      onClick={() => scrollToLocalAnchor(heading.anchor)}
                    >
                      {heading.text}
                    </button>
                  )}
                </For>
              </div>
            </nav>
          </Show>
          <For each={blocks()}>
            {(block) => (
              <Switch>
                <Match when={block.type === "markdown"}>
                  <Markdown
                    text={(block as Extract<Block, { type: "markdown" }>).text}
                    cacheKey={`notes:${props.path}:${(block as Extract<Block, { type: "markdown" }>).text.length}`}
                  />
                </Match>
                <Match when={block.type === "diagram"}>
                  <DiagramBlock
                    lang={(block as Extract<Block, { type: "diagram" }>).lang}
                    code={(block as Extract<Block, { type: "diagram" }>).code}
                  />
                </Match>
                <Match when={block.type === "html"}>
                  <HtmlFrame
                    title={`${props.path} (html block)`}
                    content={(block as Extract<Block, { type: "html" }>).code}
                    onNavigate={props.onNavigate}
                  />
                </Match>
              </Switch>
            )}
          </For>
        </div>
      </Match>
    </Switch>
  )
}

export function SurfaceNotesTab() {
  const bridge = useSurfaceSessionBridge()
  const server = useServer()
  const readOnly = createMemo(() => server.authRole() === "read")
  const [state, setState] = createStore({
    refresh: 0,
    query: notesTabCache.query,
    selectedPath: notesTabCache.selectedPath as string | undefined,
    expanded: { ...notesTabCache.expanded } as Record<string, boolean>,
    pendingAnchor: undefined as string | undefined,
    history: [...notesTabCache.history] as NoteHistoryEntry[],
    historyIndex: notesTabCache.historyIndex,
    viewMode: "preview" as "preview" | "edit",
    draftContent: "",
    draftLoadedPath: "",
    noteDirty: false,
    noteSaveStatus: "",
  })

  const sameHistoryEntry = (left: NoteHistoryEntry | undefined, right: NoteHistoryEntry) =>
    !!left && left.path === right.path && left.anchor === right.anchor

  const rememberSelection = (entry: NoteHistoryEntry) => {
    const current = state.history[state.historyIndex]
    if (sameHistoryEntry(current, entry)) return

    let next = state.history.slice(0, state.historyIndex + 1)
    next.push(entry)
    if (next.length > 50) next = next.slice(next.length - 50)
    const nextIndex = next.length - 1
    notesTabCache.history = next
    notesTabCache.historyIndex = nextIndex
    setState("history", next)
    setState("historyIndex", nextIndex)
  }

  const setSelected = (path: string, anchor?: string, options?: { remember?: boolean }) => {
    const normalized = normalizePath(path)
    const shouldRemember = options?.remember ?? true
    if (shouldRemember && state.historyIndex === -1 && state.selectedPath && state.selectedPath !== normalized) {
      rememberSelection({ path: state.selectedPath })
    }
    if (shouldRemember) rememberSelection({ path: normalized, anchor })
    for (const dir of ancestorDirectories(normalized)) {
      setState("expanded", dir, true)
      notesTabCache.expanded[dir] = true
    }
    notesTabCache.selectedPath = normalized
    setState("selectedPath", normalized)
    setState("pendingAnchor", anchor)
  }

  const toggleExpanded = (path: string, open: boolean) => {
    setState("expanded", path, open)
    if (open) notesTabCache.expanded[path] = true
    else delete notesTabCache.expanded[path]
  }

  const [tree] = createResource(
    () => state.refresh,
    async () => bridge.listNotes({ force: state.refresh > 0 }),
  )
  const treeData = createMemo(() => tree() ?? tree.latest)
  const files = createMemo(() => treeData()?.files ?? [])
  const pathLookup = createMemo(() => buildPathLookup(files()))
  const stemLookup = createMemo(() => buildStemLookup(files()))
  const searchMatches = createMemo(() => {
    const q = state.query.trim().toLowerCase()
    if (!q) return files()
    return files().filter((file) => file.path.toLowerCase().includes(q) || file.name.toLowerCase().includes(q))
  })
  const treeNodes = createMemo(() => buildNoteTree(files()))
  const autoExpand = createMemo(() => {
    const out = new Set<string>()
    if (state.query.trim()) {
      for (const file of searchMatches()) for (const dir of ancestorDirectories(file.path)) out.add(dir)
    }
    if (state.selectedPath) {
      for (const dir of ancestorDirectories(state.selectedPath)) out.add(dir)
    }
    return out
  })

  createEffect(() => {
    const selected = state.selectedPath
    if (selected && files().some((file) => file.path === selected)) return
    const preferred = notesTabCache.selectedPath
    if (preferred && files().some((file) => file.path === preferred)) {
      setSelected(preferred, undefined, { remember: false })
      return
    }
    const first = files()[0]
    if (first) setSelected(first.path, undefined, { remember: false })
  })

  const [note] = createResource(
    () => state.selectedPath,
    (path) => bridge.getNoteFile(path),
  )
  const noteData = createMemo(() => note() ?? note.latest)

  createEffect(() => {
    const data = noteData()
    if (!data || data.path === state.draftLoadedPath) return
    setState({
      draftContent: data.content,
      draftLoadedPath: data.path,
      noteDirty: false,
      noteSaveStatus: "",
    })
  })

  const saveSelectedNote = async () => {
    const path = state.selectedPath
    if (!path || readOnly()) {
      setState("noteSaveStatus", readOnly() ? "Read-only access: note saves are disabled." : "")
      return
    }
    setState("noteSaveStatus", "Saving…")
    try {
      const saved = await bridge.saveNoteFile(path, state.draftContent)
      setState({
        noteDirty: false,
        draftLoadedPath: saved.path,
        noteSaveStatus: saved.backup ? `Saved note. Backup: ${saved.backup}` : "Saved note.",
        refresh: state.refresh + 1,
      })
    } catch (error) {
      setState("noteSaveStatus", String(error))
    }
  }

  const handleNavigate = (href: string, fromPath: string) => {
    const target = resolveNoteTarget({
      href,
      fromPath,
      pathLookup: pathLookup(),
      stemLookup: stemLookup(),
    })
    if (target.kind === "blocked") return
    if (target.kind === "anchor") {
      setState("pendingAnchor", target.anchor)
      return
    }
    if (target.kind === "note") {
      setSelected(target.path, target.anchor)
      return
    }
  }

  const selectFromSearch = (path: string) => {
    setSelected(path)
    notesTabCache.query = ""
    setState("query", "")
  }

  const goHistory = (delta: -1 | 1) => {
    const nextIndex = state.historyIndex + delta
    const entry = state.history[nextIndex]
    if (!entry) return
    notesTabCache.historyIndex = nextIndex
    setState("historyIndex", nextIndex)
    setSelected(entry.path, entry.anchor, { remember: false })
  }

  const canGoBack = createMemo(() => state.historyIndex > 0)
  const canGoForward = createMemo(() => state.historyIndex >= 0 && state.historyIndex < state.history.length - 1)

  return (
    <div class="flex h-full min-h-0 flex-col overflow-hidden bg-background-base md:flex-row">
      <div class="max-h-72 shrink-0 border-b border-border-weaker-base p-3 flex flex-col gap-3 overflow-hidden md:max-h-none md:w-72 md:border-b-0 md:border-r">
        <div class="flex items-center justify-between gap-2">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <h2 class="text-15-medium text-text-strong">Notes</h2>
              <Show when={readOnly()}>
                <span class="rounded-full border border-border-weaker-base bg-surface-base px-2 py-0.5 text-11-medium text-text-weak">
                  Read-only
                </span>
              </Show>
            </div>
            <Show when={treeData()?.root}>
              {(root) => <div class="text-10-mono text-text-weak truncate">{root()}</div>}
            </Show>
          </div>
          <button
            type="button"
            class="px-2 py-1 rounded-md bg-surface-raised-base hover:bg-surface-raised-base-hover text-12-medium text-text-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            aria-label="Refresh notes"
            onClick={() => setState("refresh", (x) => x + 1)}
          >
            Refresh
          </button>
        </div>
        <input
          aria-label="Search notes"
          class="w-full px-2 py-1.5 rounded-md bg-surface-base border border-border-base text-12-regular text-text-base outline-none focus-visible:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          placeholder="Search notes"
          value={state.query}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return
            if (!state.query.trim()) return
            const first = searchMatches()[0]
            if (!first) return
            event.preventDefault()
            selectFromSearch(first.path)
          }}
          onInput={(event) => {
            const value = event.currentTarget.value
            notesTabCache.query = value
            setState("query", value)
          }}
        />
        <Show when={state.query.trim()}>
          <div class="rounded-md border border-border-weaker-base bg-surface-base max-h-44 overflow-y-auto">
            <Switch>
              <Match when={searchMatches().length === 0}>
                <div class="px-2 py-2 text-12-regular text-text-weak">No matching notes.</div>
              </Match>
              <Match when={true}>
                <For each={searchMatches().slice(0, 30)}>
                  {(file) => (
                    <button
                      type="button"
                      class="w-full px-2 py-1.5 text-left text-12-regular hover:bg-surface-raised-base-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                      onClick={() => selectFromSearch(file.path)}
                      title={file.path}
                    >
                      <div class="truncate text-text-strong">{file.name}</div>
                      <div class="truncate text-11-regular text-text-weak">{file.path}</div>
                    </button>
                  )}
                </For>
              </Match>
            </Switch>
          </div>
        </Show>
        <div class="flex-1 min-h-0 overflow-y-auto flex flex-col gap-1" role="tree" aria-label="Notes tree">
          <Switch>
            <Match when={tree.loading && files().length === 0}>
              <div class="text-12-regular text-text-weak">Loading notes…</div>
            </Match>
            <Match when={tree.error && files().length === 0}>
              <div class="text-12-regular text-danger">{String(tree.error)}</div>
            </Match>
            <Match when={files().length === 0}>
              <div class="text-12-regular text-text-weak">No notes found.</div>
            </Match>
            <Match when={true}>
              <NoteTree
                nodes={treeNodes()}
                level={0}
                activePath={state.selectedPath}
                expanded={state.expanded}
                autoExpand={autoExpand()}
                onToggle={toggleExpanded}
                onSelect={(path) => setSelected(path)}
              />
            </Match>
          </Switch>
        </div>
      </div>
      <div class="flex-1 min-w-0 min-h-0 overflow-y-auto p-4">
        <Switch>
          <Match when={note.loading && !noteData()}>
            <div class="text-12-regular text-text-weak">Loading note…</div>
          </Match>
          <Match when={note.error && !noteData()}>
            <div class="rounded-lg border border-danger/30 bg-danger/10 p-3 text-12-regular text-danger">
              {String(note.error)}
            </div>
          </Match>
          <Match when={noteData()} keyed>
            {(data) => (
              <div class="flex min-h-full flex-col gap-4">
                <div class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div class="min-w-0">
                    <h3 class="truncate text-15-medium text-text-strong">{data.path}</h3>
                    <div class="text-11-mono text-text-weak">
                      {data.ext} · {new Intl.NumberFormat().format(data.size)} bytes
                    </div>
                    <div class="mt-1 text-11-regular text-text-weak" role="status" aria-live="polite">
                      {state.noteSaveStatus ||
                        (readOnly() ? "Read-only access: note editing is disabled." : "Preview or edit this vault note.")}
                    </div>
                  </div>
                  <div class="flex shrink-0 flex-wrap items-center gap-1">
                    <button
                      type="button"
                      class="inline-flex items-center gap-1 rounded-md border border-border-weaker-base bg-surface-raised-base px-2 py-1 text-12-medium text-text-base hover:bg-surface-raised-base-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40"
                      disabled={!canGoBack()}
                      onClick={() => goHistory(-1)}
                    >
                      <Icon name="arrow-left" size="small" />
                      Back
                    </button>
                    <button
                      type="button"
                      class="inline-flex items-center gap-1 rounded-md border border-border-weaker-base bg-surface-raised-base px-2 py-1 text-12-medium text-text-base hover:bg-surface-raised-base-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40"
                      disabled={!canGoForward()}
                      onClick={() => goHistory(1)}
                    >
                      Forward
                      <Icon name="arrow-right" size="small" />
                    </button>
                    <button
                      type="button"
                      aria-pressed={state.viewMode === "preview"}
                      class="rounded-md border border-border-weaker-base bg-surface-raised-base px-2 py-1 text-12-medium text-text-base hover:bg-surface-raised-base-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                      classList={{ "bg-surface-raised-base-active text-text-strong": state.viewMode === "preview" }}
                      onClick={() => setState("viewMode", "preview")}
                    >
                      Preview
                    </button>
                    <button
                      type="button"
                      aria-pressed={state.viewMode === "edit"}
                      class="rounded-md border border-border-weaker-base bg-surface-raised-base px-2 py-1 text-12-medium text-text-base hover:bg-surface-raised-base-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                      classList={{ "bg-surface-raised-base-active text-text-strong": state.viewMode === "edit" }}
                      onClick={() => setState("viewMode", "edit")}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      aria-label={state.noteDirty ? "Save note with unsaved changes" : "Save note"}
                      class="rounded-md bg-accent px-2 py-1 text-12-medium text-background-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={readOnly() || !state.noteDirty || state.draftLoadedPath !== data.path}
                      onClick={saveSelectedNote}
                    >
                      Save{state.noteDirty ? " *" : ""}
                    </button>
                  </div>
                </div>
                <Switch>
                  <Match when={state.viewMode === "edit"}>
                    <textarea
                      aria-label={`Edit note ${data.path}`}
                      value={state.draftLoadedPath === data.path ? state.draftContent : data.content}
                      readOnly={readOnly()}
                      spellcheck={true}
                      onInput={(event) =>
                        setState({
                          draftContent: event.currentTarget.value,
                          draftLoadedPath: data.path,
                          noteDirty: true,
                          noteSaveStatus: "",
                        })
                      }
                      class="min-h-96 flex-1 resize-none rounded-lg border border-border-weaker-base bg-surface-base p-3 font-mono text-12-regular text-text-base outline-none focus-visible:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent read-only:cursor-not-allowed read-only:opacity-80"
                    />
                  </Match>
                  <Match when={true}>
                    <NotePreview
                      ext={data.ext}
                      content={state.draftLoadedPath === data.path && state.noteDirty ? state.draftContent : data.content}
                      path={data.path}
                      files={files()}
                      pendingAnchor={state.pendingAnchor}
                      onAnchorHandled={() => setState("pendingAnchor", undefined)}
                      onNavigate={(href) => handleNavigate(href, data.path)}
                    />
                  </Match>
                </Switch>
              </div>
            )}
          </Match>
          <Match when={true}>
            <div class="text-12-regular text-text-weak">Select a note to preview it.</div>
          </Match>
        </Switch>
      </div>
    </div>
  )
}
