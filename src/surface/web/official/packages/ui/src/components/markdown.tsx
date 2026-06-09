import { useMarked } from "../context/marked"
import { useI18n } from "../context/i18n"
import { useDiagram } from "../context/diagram"
import DOMPurify from "dompurify"
import morphdom from "morphdom"
import { checksum } from "@opencode-ai/core/util/encode"
import { ComponentProps, createEffect, createResource, createSignal, onCleanup, splitProps } from "solid-js"
import { isServer } from "solid-js/web"
import { stream } from "./markdown-stream"

declare global {
  interface Window {
    mermaid?: {
      initialize: (config: Record<string, unknown>) => void
      render: (id: string, source: string) => Promise<{ svg: string }>
    }
  }
}

type Entry = {
  hash: string
  html: string
}

type CopyLabels = {
  copy: string
  copied: string
}

type DiagramKind = "diagram" | "svg" | "html" | "web"
type DiagramLang = "mermaid" | "plantuml" | "puml"
type DiagramLabels = {
  close: string
  openPopup: string
  preview: string
  rendering: string
  resetZoom: string
  source: string
  zoomIn: string
  zoomOut: string
}
type ModalFrame = {
  body: HTMLDivElement
  close: () => void
}
type FrameSource = { type: "srcdoc"; value: string; sandbox: string } | { type: "url"; value: string; sandbox: string }

const max = 200
const cache = new Map<string, Entry>()
const diagramCache = new Map<string, string>()
const richBlockCleanups = new WeakMap<HTMLElement, () => void>()
const diagramCacheLimit = 256
const plantUmlStreamingDelayMs = 800
const plantUmlRenderTimeoutMs = 30_000
let mermaidLoad: Promise<void> | undefined
let mermaidLoadUrl = ""
const urlPattern = /^https?:\/\/[^\s<>()`"']+$/

if (typeof window !== "undefined" && DOMPurify.isSupported) {
  DOMPurify.addHook("afterSanitizeAttributes", (node: Element) => {
    if (!(node instanceof HTMLAnchorElement)) return
    if (node.target !== "_blank") return

    const rel = node.getAttribute("rel") ?? ""
    const set = new Set(rel.split(/\s+/).filter(Boolean))
    set.add("noopener")
    set.add("noreferrer")
    node.setAttribute("rel", Array.from(set).join(" "))
  })
}

const config = {
  USE_PROFILES: { html: true, mathMl: true },
  SANITIZE_NAMED_PROPS: true,
  FORBID_TAGS: ["style"],
  FORBID_CONTENTS: ["style", "script"],
  ADD_TAGS: ["svg", "path"],
  ADD_ATTR: ["d", "viewBox", "preserveAspectRatio", "xmlns"],
}

const svgConfig = {
  USE_PROFILES: { svg: true, svgFilters: true },
  SANITIZE_NAMED_PROPS: true,
  FORBID_TAGS: ["script", "foreignObject", "iframe"],
  FORBID_CONTENTS: ["script", "foreignObject", "iframe"],
}

const iconPaths = {
  copy: '<path d="M6.2513 6.24935V2.91602H17.0846V13.7493H13.7513M13.7513 6.24935V17.0827H2.91797V6.24935H13.7513Z" stroke="currentColor" stroke-linecap="round"/>',
  check: '<path d="M5 11.9657L8.37838 14.7529L15 5.83398" stroke="currentColor" stroke-linecap="square"/>',
}

function sanitize(html: string) {
  if (!DOMPurify.isSupported) return html
  return DOMPurify.sanitize(html, config)
}

function sanitizeSvg(html: string) {
  if (!DOMPurify.isSupported) return html
  return DOMPurify.sanitize(html, svgConfig)
}

function escape(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function fallback(markdown: string) {
  return escape(markdown).replace(/\r\n?/g, "\n").replace(/\n/g, "<br>")
}

function touch(key: string, value: Entry) {
  cache.delete(key)
  cache.set(key, value)

  if (cache.size <= max) return
  const first = cache.keys().next().value
  if (!first) return
  cache.delete(first)
}

function touchDiagramCache(key: string, value: string) {
  diagramCache.delete(key)
  diagramCache.set(key, value)
  if (diagramCache.size <= diagramCacheLimit) return
  const first = diagramCache.keys().next().value
  if (!first) return
  diagramCache.delete(first)
}

function readDiagramCache(key: string) {
  const value = diagramCache.get(key)
  if (!value) return
  touchDiagramCache(key, value)
  return value
}

function normalizeDiagramLang(raw: string): DiagramLang | undefined {
  const value = raw.trim().toLowerCase()
  if (value === "mermaid") return "mermaid"
  if (value === "plantuml") return "plantuml"
  if (value === "puml") return "puml"
}

function codeUrl(text: string) {
  const href = text.trim().replace(/[),.;!?]+$/, "")
  if (!urlPattern.test(href)) return
  try {
    const url = new URL(href)
    return url.toString()
  } catch {
    return
  }
}

function iframeUrl(text: string) {
  const first = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
  if (!first || !urlPattern.test(first)) return
  try {
    const url = new URL(first)
    if (url.protocol !== "http:" && url.protocol !== "https:") return
    return url.toString()
  } catch {
    return
  }
}

function cleanupRichBlock(block: Element) {
  if (!(block instanceof HTMLElement)) return
  const cleanup = richBlockCleanups.get(block)
  if (!cleanup) return
  cleanup()
  richBlockCleanups.delete(block)
}

function cleanupRichBlocks(root: Element) {
  cleanupRichBlock(root)
  for (const block of root.querySelectorAll('[data-component="markdown-rich-block"]')) {
    cleanupRichBlock(block)
  }
}

function trackRichBlock(host: HTMLElement, cleanup?: () => void) {
  if (!cleanup) return
  richBlockCleanups.set(host, cleanup)
}

function createIcon(path: string, slot: string) {
  const icon = document.createElement("div")
  icon.setAttribute("data-component", "icon")
  icon.setAttribute("data-size", "small")
  icon.setAttribute("data-slot", slot)
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.setAttribute("data-slot", "icon-svg")
  svg.setAttribute("fill", "none")
  svg.setAttribute("viewBox", "0 0 20 20")
  svg.setAttribute("aria-hidden", "true")
  svg.innerHTML = path
  icon.appendChild(svg)
  return icon
}

function createCopyButton(labels: CopyLabels) {
  const button = document.createElement("button")
  button.type = "button"
  button.setAttribute("data-component", "icon-button")
  button.setAttribute("data-variant", "secondary")
  button.setAttribute("data-size", "small")
  button.setAttribute("data-slot", "markdown-copy-button")
  button.setAttribute("aria-label", labels.copy)
  button.setAttribute("data-tooltip", labels.copy)
  button.appendChild(createIcon(iconPaths.copy, "copy-icon"))
  button.appendChild(createIcon(iconPaths.check, "check-icon"))
  return button
}

function setCopyState(button: HTMLButtonElement, labels: CopyLabels, copied: boolean) {
  if (copied) {
    button.setAttribute("data-copied", "true")
    button.setAttribute("aria-label", labels.copied)
    button.setAttribute("data-tooltip", labels.copied)
    return
  }
  button.removeAttribute("data-copied")
  button.setAttribute("aria-label", labels.copy)
  button.setAttribute("data-tooltip", labels.copy)
}

function ensureCodeWrapper(block: HTMLPreElement, labels: CopyLabels) {
  if (block.getAttribute("data-component") === "markdown-enhanced-block") return
  if (block.closest('[data-component="markdown-rich-block"]')) return

  const parent = block.parentElement
  if (!parent) return
  const wrapped = parent.getAttribute("data-component") === "markdown-code"
  if (!wrapped) {
    const wrapper = document.createElement("div")
    wrapper.setAttribute("data-component", "markdown-code")
    parent.replaceChild(wrapper, block)
    wrapper.appendChild(block)
    wrapper.appendChild(createCopyButton(labels))
    return
  }

  const buttons = Array.from(parent.querySelectorAll('[data-slot="markdown-copy-button"]')).filter(
    (el): el is HTMLButtonElement => el instanceof HTMLButtonElement,
  )

  if (buttons.length === 0) {
    parent.appendChild(createCopyButton(labels))
    return
  }

  for (const button of buttons.slice(1)) {
    button.remove()
  }
}

function markdownAnchorSlug(text: string) {
  return text
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 _-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}

function anchorSlugMatches(value: string, needleSlug: string) {
  const valueSlug = markdownAnchorSlug(value)
  if (valueSlug === needleSlug) return true
  if (needleSlug.startsWith("user-content-") && valueSlug === needleSlug.slice("user-content-".length)) return true
  if (valueSlug.startsWith("user-content-") && valueSlug.slice("user-content-".length) === needleSlug) return true
  return false
}

function markHeadingAnchors(root: HTMLDivElement) {
  const seen = new Map<string, number>()
  for (const heading of Array.from(root.querySelectorAll<HTMLHeadingElement>("h1, h2, h3, h4, h5, h6"))) {
    const existing = heading.id.trim()
    if (existing) continue

    const base = markdownAnchorSlug(heading.textContent ?? "") || "section"
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    heading.id = count === 0 ? base : `${base}-${count}`
  }
}

function safeDecodeAnchor(input: string) {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

function findMarkdownAnchor(root: HTMLElement, anchor: string) {
  const needle = safeDecodeAnchor(anchor).trim()
  if (!needle) return
  const needleSlug = markdownAnchorSlug(needle)
  for (const element of Array.from(root.querySelectorAll<HTMLElement>("[id], [name]"))) {
    const id = element.getAttribute("id") ?? ""
    const name = element.getAttribute("name") ?? ""
    if (id === needle || name === needle) return element
    if ((id && anchorSlugMatches(id, needleSlug)) || (name && anchorSlugMatches(name, needleSlug))) return element
  }
  for (const heading of Array.from(root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"))) {
    if (anchorSlugMatches(heading.textContent ?? "", needleSlug)) return heading
  }
}

function setupLocalAnchorNavigation(root: HTMLDivElement) {
  const onClick = (event: MouseEvent) => {
    const target = event.target
    if (!(target instanceof Element)) return
    const anchor = target.closest("a[href]")
    if (!(anchor instanceof HTMLAnchorElement)) return
    const href = anchor.getAttribute("href") ?? ""
    if (!href.startsWith("#")) return

    const targetElement = findMarkdownAnchor(root, href.slice(1))
    if (!(targetElement instanceof HTMLElement)) return
    event.preventDefault()
    event.stopPropagation()
    targetElement.scrollIntoView({ block: "start", behavior: "smooth" })
  }
  root.addEventListener("click", onClick, true)
  return () => root.removeEventListener("click", onClick, true)
}

function markCodeLinks(root: HTMLDivElement) {
  const codeNodes = Array.from(root.querySelectorAll(":not(pre) > code"))
  for (const code of codeNodes) {
    const href = codeUrl(code.textContent ?? "")
    const parentLink =
      code.parentElement instanceof HTMLAnchorElement && code.parentElement.classList.contains("external-link")
        ? code.parentElement
        : null

    if (!href) {
      if (parentLink) parentLink.replaceWith(code)
      continue
    }

    if (parentLink) {
      parentLink.href = href
      continue
    }

    const link = document.createElement("a")
    link.href = href
    link.className = "external-link"
    link.target = "_blank"
    link.rel = "noopener noreferrer"
    code.parentNode?.replaceChild(link, code)
    link.appendChild(code)
  }
}

function decorate(root: HTMLDivElement, labels: CopyLabels) {
  markHeadingAnchors(root)
  const blocks = Array.from(root.querySelectorAll("pre"))
  for (const block of blocks) {
    ensureCodeWrapper(block, labels)
  }
  markCodeLinks(root)
}

function setupCodeCopy(root: HTMLDivElement, getLabels: () => CopyLabels) {
  const timeouts = new Map<HTMLButtonElement, ReturnType<typeof setTimeout>>()

  const updateLabel = (button: HTMLButtonElement) => {
    const labels = getLabels()
    const copied = button.getAttribute("data-copied") === "true"
    setCopyState(button, labels, copied)
  }

  const handleClick = async (event: MouseEvent) => {
    const target = event.target
    if (!(target instanceof Element)) return

    const button = target.closest('[data-slot="markdown-copy-button"]')
    if (!(button instanceof HTMLButtonElement)) return
    const code = button.closest('[data-component="markdown-code"]')?.querySelector("code")
    const content = code?.textContent ?? ""
    if (!content) return
    const clipboard = navigator?.clipboard
    if (!clipboard) return
    await clipboard.writeText(content)
    const labels = getLabels()
    setCopyState(button, labels, true)
    const existing = timeouts.get(button)
    if (existing) clearTimeout(existing)
    const timeout = setTimeout(() => setCopyState(button, labels, false), 2000)
    timeouts.set(button, timeout)
  }

  const buttons = Array.from(root.querySelectorAll('[data-slot="markdown-copy-button"]'))
  for (const button of buttons) {
    if (button instanceof HTMLButtonElement) updateLabel(button)
  }

  root.addEventListener("click", handleClick)

  return () => {
    root.removeEventListener("click", handleClick)
    for (const timeout of timeouts.values()) clearTimeout(timeout)
  }
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

function createToolbarButton(label: string, action: string, text: string) {
  const button = document.createElement("button")
  button.type = "button"
  button.setAttribute("data-slot", "markdown-diagram-button")
  button.setAttribute("data-action", action)
  button.setAttribute("aria-label", label)
  button.textContent = text
  return button
}

function createPanZoomViewport(container: HTMLElement, html: string) {
  const pan = document.createElement("div")
  pan.setAttribute("data-slot", "markdown-diagram-pan")
  const canvas = document.createElement("div")
  canvas.setAttribute("data-slot", "markdown-diagram-canvas")
  canvas.innerHTML = html
  pan.appendChild(canvas)
  container.appendChild(pan)

  let scale = 1
  let offsetX = 0
  let offsetY = 0
  let drag:
    | {
        x: number
        y: number
      }
    | undefined

  const clamp = (value: number) => Math.min(4, Math.max(0.2, value))
  const apply = () => {
    canvas.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`
  }
  const zoomAt = (factor: number, x = pan.clientWidth / 2, y = pan.clientHeight / 2) => {
    const next = clamp(scale * factor)
    if (next === scale) return
    const ratio = next / scale
    offsetX = x - (x - offsetX) * ratio
    offsetY = y - (y - offsetY) * ratio
    scale = next
    apply()
  }
  const reset = () => {
    scale = 1
    offsetX = 0
    offsetY = 0
    apply()
  }

  const abort = new AbortController()
  pan.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault()
      const rect = pan.getBoundingClientRect()
      zoomAt(event.deltaY < 0 ? 1.12 : 0.88, event.clientX - rect.left, event.clientY - rect.top)
    },
    { passive: false, signal: abort.signal },
  )
  pan.addEventListener(
    "pointerdown",
    (event) => {
      drag = { x: event.clientX - offsetX, y: event.clientY - offsetY }
      pan.classList.add("panning")
      pan.setPointerCapture(event.pointerId)
    },
    { signal: abort.signal },
  )
  pan.addEventListener(
    "pointermove",
    (event) => {
      if (!drag) return
      offsetX = event.clientX - drag.x
      offsetY = event.clientY - drag.y
      apply()
    },
    { signal: abort.signal },
  )
  pan.addEventListener(
    "pointerup",
    (event) => {
      drag = undefined
      pan.classList.remove("panning")
      pan.releasePointerCapture(event.pointerId)
    },
    { signal: abort.signal },
  )
  pan.addEventListener(
    "pointercancel",
    () => {
      drag = undefined
      pan.classList.remove("panning")
    },
    { signal: abort.signal },
  )

  apply()
  return {
    zoomIn: () => zoomAt(1.2),
    zoomOut: () => zoomAt(0.8),
    reset,
    destroy: () => abort.abort(),
  }
}

function openModalFrame(input: { title: string; labels: DiagramLabels }): ModalFrame {
  const overlay = document.createElement("div")
  overlay.setAttribute("data-component", "markdown-rich-modal")
  const dialog = document.createElement("div")
  dialog.setAttribute("data-slot", "markdown-rich-modal-dialog")
  const header = document.createElement("div")
  header.setAttribute("data-slot", "markdown-rich-modal-header")
  const title = document.createElement("div")
  title.setAttribute("data-slot", "markdown-rich-modal-title")
  title.textContent = input.title
  const close = createToolbarButton(input.labels.close, "close", "×")
  close.setAttribute("data-slot", "markdown-rich-modal-close")
  header.append(title, close)
  const body = document.createElement("div")
  body.setAttribute("data-slot", "markdown-rich-modal-body")
  dialog.append(header, body)
  overlay.appendChild(dialog)
  document.body.appendChild(overlay)
  document.body.classList.add("markdown-rich-modal-open")

  let closed = false
  const onClose = () => {
    if (closed) return
    closed = true
    overlay.removeEventListener("click", onClickOverlay)
    close.removeEventListener("click", onClose)
    window.removeEventListener("keydown", onKey)
    overlay.remove()
    if (!document.querySelector('[data-component="markdown-rich-modal"]')) {
      document.body.classList.remove("markdown-rich-modal-open")
    }
  }
  const onClickOverlay = (event: MouseEvent) => {
    if (event.target === overlay) onClose()
  }
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return
    onClose()
  }
  overlay.addEventListener("click", onClickOverlay)
  close.addEventListener("click", onClose)
  window.addEventListener("keydown", onKey)

  return {
    body,
    close: onClose,
  }
}

function createHtmlFrame(source: FrameSource) {
  const frame = document.createElement("iframe")
  frame.setAttribute("data-slot", "markdown-html-frame")
  frame.setAttribute("sandbox", source.sandbox)
  if (source.type === "srcdoc") frame.srcdoc = source.value
  else frame.src = source.value
  return frame
}

function appendFramePreview(host: HTMLElement, source: FrameSource) {
  const preview = document.createElement("div")
  preview.setAttribute("data-slot", "markdown-html-preview")
  preview.appendChild(createHtmlFrame(source))
  host.appendChild(preview)
}

function openFramePopup(input: { title: string; labels: DiagramLabels; source: FrameSource }) {
  const modal = openModalFrame({ title: input.title, labels: input.labels })
  modal.body.appendChild(createHtmlFrame(input.source))
}

function mountDiagramBlock(input: { host: HTMLElement; html: string; title: string; labels: DiagramLabels }) {
  const toolbar = document.createElement("div")
  toolbar.setAttribute("data-slot", "markdown-diagram-toolbar")
  toolbar.append(
    createToolbarButton(input.labels.zoomIn, "zoom-in", "＋"),
    createToolbarButton(input.labels.zoomOut, "zoom-out", "−"),
    createToolbarButton(input.labels.resetZoom, "reset", "Reset"),
    createToolbarButton(input.labels.openPopup, "popup", "Popup"),
  )
  input.host.append(toolbar)

  const viewport = document.createElement("div")
  viewport.setAttribute("data-slot", "markdown-diagram-viewport")
  input.host.append(viewport)
  const pan = createPanZoomViewport(viewport, input.html)

  const onAction = (event: MouseEvent) => {
    const target = event.target
    if (!(target instanceof Element)) return
    const action = target.closest<HTMLButtonElement>('[data-slot="markdown-diagram-button"]')?.dataset.action
    if (!action) return
    if (action === "zoom-in") return pan.zoomIn()
    if (action === "zoom-out") return pan.zoomOut()
    if (action === "reset") return pan.reset()
    if (action !== "popup") return

    const modal = openModalFrame({ title: input.title, labels: input.labels })
    const modalRoot = document.createElement("div")
    modalRoot.setAttribute("data-component", "markdown-rich-block")
    modalRoot.setAttribute("data-kind", "diagram")
    modal.body.appendChild(modalRoot)
    mountDiagramBlock({
      host: modalRoot,
      html: input.html,
      title: input.title,
      labels: input.labels,
    })
  }

  toolbar.addEventListener("click", onAction)
  const cleanup = () => {
    toolbar.removeEventListener("click", onAction)
    pan.destroy()
  }
  trackRichBlock(input.host, cleanup)
  return cleanup
}

function mountHtmlBlock(input: { host: HTMLElement; code: string; title: string; labels: DiagramLabels }) {
  const toolbar = document.createElement("div")
  toolbar.setAttribute("data-slot", "markdown-diagram-toolbar")
  const toggle = createToolbarButton(input.labels.source, "toggle", input.labels.source)
  toolbar.append(toggle, createToolbarButton(input.labels.openPopup, "popup", "Popup"))
  input.host.append(toolbar)

  const frameSource: FrameSource = {
    type: "srcdoc",
    value: input.code,
    sandbox: "allow-scripts allow-popups allow-forms",
  }
  appendFramePreview(input.host, frameSource)

  const source = document.createElement("pre")
  source.setAttribute("data-slot", "markdown-html-source")
  source.innerHTML = `<code>${escape(input.code)}</code>`
  input.host.append(source)

  let mode: "preview" | "source" = "preview"
  const apply = () => {
    input.host.setAttribute("data-mode", mode)
    toggle.textContent = mode === "preview" ? input.labels.source : input.labels.preview
  }
  apply()

  const onAction = (event: MouseEvent) => {
    const target = event.target
    if (!(target instanceof Element)) return
    const action = target.closest<HTMLButtonElement>('[data-slot="markdown-diagram-button"]')?.dataset.action
    if (!action) return
    if (action === "toggle") {
      mode = mode === "preview" ? "source" : "preview"
      apply()
      return
    }
    if (action !== "popup") return
    openFramePopup({ title: input.title, labels: input.labels, source: frameSource })
  }

  toolbar.addEventListener("click", onAction)
  const cleanup = () => toolbar.removeEventListener("click", onAction)
  trackRichBlock(input.host, cleanup)
  return cleanup
}

function mountWebBlock(input: { host: HTMLElement; code: string; title: string; labels: DiagramLabels }) {
  const url = iframeUrl(input.code)
  if (!url) {
    setBlockError(input.host, "Expected a valid http(s) URL")
    return
  }

  const toolbar = document.createElement("div")
  toolbar.setAttribute("data-slot", "markdown-diagram-toolbar")
  toolbar.append(createToolbarButton(input.labels.openPopup, "popup", "Popup"))
  input.host.append(toolbar)

  const frameSource: FrameSource = {
    type: "url",
    value: url,
    sandbox: "allow-scripts allow-popups allow-forms allow-same-origin",
  }
  appendFramePreview(input.host, frameSource)

  const onAction = (event: MouseEvent) => {
    const target = event.target
    if (!(target instanceof Element)) return
    const action = target.closest<HTMLButtonElement>('[data-slot="markdown-diagram-button"]')?.dataset.action
    if (action !== "popup") return
    openFramePopup({ title: input.title, labels: input.labels, source: frameSource })
  }

  toolbar.addEventListener("click", onAction)
  const cleanup = () => toolbar.removeEventListener("click", onAction)
  trackRichBlock(input.host, cleanup)
  return cleanup
}

function timeout<T>(promise: Promise<T>, ms: number, message: string) {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        window.clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        window.clearTimeout(timer)
        reject(error)
      },
    )
  })
}

async function renderDiagram(
  runtime: ReturnType<typeof useDiagram>,
  input: { code: string; lang: DiagramLang; theme: "default" | "dark" },
) {
  if (input.lang === "mermaid") {
    if (!runtime) throw new Error("Mermaid renderer unavailable")
    await loadMermaid(runtime.getMermaidScriptUrl())
    window.mermaid?.initialize({
      startOnLoad: false,
      theme: input.theme,
      securityLevel: "antiscript",
      fontFamily: "inherit",
    })
    const id =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? `markdown-mermaid-${crypto.randomUUID()}`
        : `markdown-mermaid-${Date.now()}-${Math.floor(Math.random() * 1e9)}`
    const { svg } = await window.mermaid!.render(id, input.code)
    return svg.trim()
  }
  if (!runtime) throw new Error("PlantUML renderer unavailable")
  const svg = await timeout(
    runtime.renderPlantUML(input.code),
    plantUmlRenderTimeoutMs,
    "PlantUML render timed out. Check the local plantuml installation or diagram source.",
  )
  return svg.replace(/<\?xml[^>]*>/, "").trim()
}

function setBlockError(host: HTMLElement, message: string) {
  host.innerHTML = ""
  const error = document.createElement("div")
  error.setAttribute("data-slot", "markdown-rich-error")
  error.textContent = message
  host.appendChild(error)
}

function hydrateEnhancedBlocks(
  root: HTMLDivElement,
  runtime: ReturnType<typeof useDiagram>,
  labels: DiagramLabels,
  options?: { streaming?: boolean },
) {
  const blocks = Array.from(root.querySelectorAll<HTMLPreElement>('pre[data-component="markdown-enhanced-block"]'))
  for (const block of blocks) {
    if (block.dataset.hydrated === "true") continue
    block.dataset.hydrated = "true"

    const kind = (block.dataset.kind ?? "").trim().toLowerCase() as DiagramKind
    const lang = block.dataset.lang ?? ""
    const code = block.querySelector("code")?.textContent ?? ""
    const host = document.createElement("div")
    host.setAttribute("data-component", "markdown-rich-block")
    host.setAttribute("data-kind", kind)
    block.replaceWith(host)

    if (!code.trim()) {
      setBlockError(host, "Empty block")
      continue
    }

    if (kind === "html") {
      mountHtmlBlock({
        host,
        code,
        title: "HTML Preview",
        labels,
      })
      continue
    }

    if (kind === "web") {
      mountWebBlock({
        host,
        code,
        title: lang === "streamlit" ? "Streamlit Preview" : "Web Preview",
        labels,
      })
      continue
    }

    if (kind === "svg") {
      const clean = sanitizeSvg(code)
      if (!clean.trim()) {
        setBlockError(host, "Invalid SVG block")
        continue
      }
      mountDiagramBlock({
        host,
        html: clean,
        title: "SVG Diagram",
        labels,
      })
      continue
    }

    const diagramLang = normalizeDiagramLang(lang)
    if (!diagramLang) {
      setBlockError(host, `Unsupported diagram language: ${lang || "unknown"}`)
      continue
    }

    const loading = document.createElement("div")
    loading.setAttribute("data-slot", "markdown-rich-loading")
    loading.textContent = `${labels.rendering} ${diagramLang}…`
    host.appendChild(loading)

    const theme = document.documentElement.dataset.colorScheme === "light" ? "default" : "dark"
    const key = `${diagramLang}:${diagramLang === "mermaid" ? theme : "default"}:${code}`
    const cached = readDiagramCache(key)
    if (cached) {
      host.innerHTML = ""
      mountDiagramBlock({
        host,
        html: sanitizeSvg(cached),
        title: `${diagramLang[0]!.toUpperCase()}${diagramLang.slice(1)} Diagram`,
        labels,
      })
      continue
    }

    let disposed = false
    const render = () => {
      void renderDiagram(runtime, { code, lang: diagramLang, theme })
        .then((svg) => {
          if (disposed || !host.isConnected) return
          touchDiagramCache(key, svg)
          host.innerHTML = ""
          mountDiagramBlock({
            host,
            html: sanitizeSvg(svg),
            title: `${diagramLang[0]!.toUpperCase()}${diagramLang.slice(1)} Diagram`,
            labels,
          })
        })
        .catch((error) => {
          if (disposed || !host.isConnected) return
          setBlockError(host, error instanceof Error ? error.message : String(error))
        })
    }

    const delay = options?.streaming && diagramLang !== "mermaid" ? plantUmlStreamingDelayMs : 0
    const timer = delay > 0 ? window.setTimeout(render, delay) : undefined
    if (timer === undefined) render()
    trackRichBlock(host, () => {
      disposed = true
      if (timer !== undefined) window.clearTimeout(timer)
    })
  }
}

export function Markdown(
  props: ComponentProps<"div"> & {
    text: string
    cacheKey?: string
    streaming?: boolean
    class?: string
    classList?: Record<string, boolean>
  },
) {
  const [local, others] = splitProps(props, ["text", "cacheKey", "streaming", "class", "classList"])
  const marked = useMarked()
  const i18n = useI18n()
  const diagram = useDiagram()
  const [root, setRoot] = createSignal<HTMLDivElement>()
  const [html] = createResource(
    () => ({
      text: local.text,
      key: local.cacheKey,
      streaming: local.streaming ?? false,
    }),
    async (src) => {
      if (isServer) return fallback(src.text)
      if (!src.text) return ""

      const base = src.key ?? checksum(src.text)
      return Promise.all(
        stream(src.text, src.streaming).map(async (block, index) => {
          const hash = checksum(block.raw)
          const key = base ? `${base}:${index}:${block.mode}` : hash

          if (key && hash) {
            const cached = cache.get(key)
            if (cached && cached.hash === hash) {
              touch(key, cached)
              return cached.html
            }
          }

          const next = await Promise.resolve(marked.parse(block.src))
          const safe = sanitize(next)
          if (key && hash) touch(key, { hash, html: safe })
          return safe
        }),
      )
        .then((list) => list.join(""))
        .catch(() => fallback(src.text))
    },
    { initialValue: fallback(local.text) },
  )

  let copyCleanup: (() => void) | undefined
  let anchorCleanup: (() => void) | undefined

  createEffect(() => {
    const container = root()
    const content = local.text ? (html.latest ?? html() ?? "") : ""
    if (!container) return
    if (isServer) return

    if (!content) {
      container.innerHTML = ""
      return
    }

    const copyLabels = {
      copy: i18n.t("ui.message.copy"),
      copied: i18n.t("ui.message.copied"),
    }
    const diagramLabels: DiagramLabels = {
      close: i18n.t("ui.common.close"),
      openPopup: "Open popup",
      preview: "Preview",
      rendering: "Rendering",
      resetZoom: "Reset zoom",
      source: "Source",
      zoomIn: "Zoom in",
      zoomOut: "Zoom out",
    }

    const temp = document.createElement("div")
    temp.innerHTML = content
    decorate(temp, copyLabels)

    morphdom(container, temp, {
      childrenOnly: true,
      onBeforeNodeDiscarded: (node) => {
        if (node instanceof Element) cleanupRichBlocks(node)
        return true
      },
      onBeforeElUpdated: (fromEl, toEl) => {
        if (
          fromEl instanceof HTMLButtonElement &&
          toEl instanceof HTMLButtonElement &&
          fromEl.getAttribute("data-slot") === "markdown-copy-button" &&
          toEl.getAttribute("data-slot") === "markdown-copy-button" &&
          fromEl.getAttribute("data-copied") === "true"
        ) {
          setCopyState(toEl, copyLabels, true)
        }
        if (fromEl.getAttribute("data-component") === "markdown-rich-block") cleanupRichBlock(fromEl)
        if (fromEl.isEqualNode(toEl)) return false
        return true
      },
    })

    if (!copyCleanup) {
      copyCleanup = setupCodeCopy(container, () => ({
        copy: i18n.t("ui.message.copy"),
        copied: i18n.t("ui.message.copied"),
      }))
    }
    if (!anchorCleanup) anchorCleanup = setupLocalAnchorNavigation(container)

    hydrateEnhancedBlocks(container, diagram, diagramLabels, { streaming: local.streaming ?? false })
  })

  onCleanup(() => {
    if (copyCleanup) copyCleanup()
    if (anchorCleanup) anchorCleanup()
    const container = root()
    if (container) cleanupRichBlocks(container)
  })

  return (
    <div
      data-component="markdown"
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
      ref={setRoot}
      {...others}
    />
  )
}
