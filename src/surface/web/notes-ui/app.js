/* ── app.js — Obsidian-style notes client ── */
/* globals: mermaid */

const $ = (id) => document.getElementById(id)
const params = new URLSearchParams(location.search)
const NOTES_BASE = location.pathname === "/notes" || location.pathname.startsWith("/notes/") ? "/notes" : ""
const EMBEDDED_IN_OPENCODE = window.parent !== window
let authToken = params.get("token") || localStorage.getItem("notesToken") || ""
if (authToken) localStorage.setItem("notesToken", authToken)

// ── State ──────────────────────────────────────────────────────────────────
let files = []
let fileByKey = new Map()
let fileByStem = new Map()
let currentPath = params.get("path") || ""
let collapsedFolders = new Set(JSON.parse(localStorage.getItem("notesCollapsedFolders") || "[]"))
let dirty = false
let viewMode = localStorage.getItem("notesViewMode") || "preview"
let graphNodes = []
let graphEdges = []
let graphDrag = null
let graphOffset = { x: 0, y: 0 }
let graphScale = 1
let panStart = null

function notesURL(path) {
  const normalized = String(path || "").startsWith("/") ? String(path) : `/${String(path || "")}`
  return `${NOTES_BASE}${normalized}`
}

function configureMermaid() {
  mermaid.initialize({
    startOnLoad: false,
    theme: document.body.classList.contains("theme-light") ? "default" : "dark",
    securityLevel: "antiscript",
    fontFamily: "inherit",
    deterministicIds: true,
    htmlLabels: true,
    flowchart: { htmlLabels: true, curve: "basis" },
    sequence: { useMaxWidth: true },
    gantt: { useMaxWidth: true },
  })
}

function setThemeMode(mode, rerender = true) {
  const isLight = mode === "light"
  document.body.classList.toggle("theme-light", isLight)
  document.body.classList.toggle("theme-dark", !isLight)
  document.documentElement.style.colorScheme = isLight ? "light" : "dark"
  configureMermaid()
  if (!rerender) return
  if (viewMode === "preview") renderPreview()
  if (graphNodes.length > 0) drawGraph()
}

function applyThemePayload(payload) {
  const root = document.documentElement
  if (payload?.vars && typeof payload.vars === "object") {
    Object.entries(payload.vars).forEach(([key, value]) => {
      if (!key.startsWith("--") || typeof value !== "string") return
      root.style.setProperty(key, value)
    })
  }
  setThemeMode(payload?.mode === "light" ? "light" : "dark")
}

window.addEventListener("message", (event) => {
  if (event.origin !== location.origin) return
  if (!event.data || event.data.type !== "opencode.theme") return
  applyThemePayload(event.data)
})

configureMermaid()

// ── API helper ─────────────────────────────────────────────────────────────
async function api(path, opts = {}, retry = true) {
  const headers = new Headers(opts.headers || {})
  if (authToken) headers.set("X-Notes-Token", authToken)
  const res = await fetch(path, { ...opts, headers })
  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = { ok: false, error: text }
  }
  if (!res.ok || data.ok === false) {
    if (retry && String(data.error || "").includes("LAN writes require")) {
      authToken = prompt("Write token required for LAN access:") || ""
      if (authToken) localStorage.setItem("notesToken", authToken)
      return api(path, opts, false)
    }
    throw new Error(data.error || res.statusText)
  }
  return data
}

// ── Escape HTML ────────────────────────────────────────────────────────────
function esc(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  )
}

function unesc(s) {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}

function noteDir(path) {
  const i = String(path || "").lastIndexOf("/")
  return i === -1 ? "" : path.slice(0, i)
}

function normalizeRel(baseDir, rel) {
  const parts = []
  const input = String(rel || "").replaceAll("\\", "/")
  if (!input.startsWith("/"))
    parts.push(
      ...String(baseDir || "")
        .split("/")
        .filter(Boolean),
    )
  for (const part of input.replace(/^\/+/, "").split("/")) {
    if (!part || part === ".") continue
    if (part === "..") parts.pop()
    else parts.push(part)
  }
  return parts.join("/")
}

function splitTarget(raw) {
  const s = unesc(raw || "").trim()
  const hashAt = s.indexOf("#")
  return hashAt === -1 ? { path: s, hash: "" } : { path: s.slice(0, hashAt), hash: s.slice(hashAt + 1) }
}

function rebuildFileIndex() {
  fileByKey = new Map()
  fileByStem = new Map()
  for (const f of files) {
    const p = f.path.toLowerCase()
    const noExt = p.replace(/\.[^.]+$/, "")
    const stem = f.name.replace(/\.[^.]+$/, "").toLowerCase()
    fileByKey.set(p, f.path)
    fileByKey.set(noExt, f.path)
    if (!fileByStem.has(stem)) fileByStem.set(stem, f.path)
  }
}

function resolveNoteTarget(raw) {
  const { path, hash } = splitTarget(raw)
  if (/^(javascript|data|vbscript):/i.test(path)) return { unsafe: true }
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return null
  if (!path) return currentPath ? { path: currentPath, hash } : null

  let rel = path
    .replace(/^\/notes\/view\//, "")
    .replace(/^\/notes\/raw\//, "")
    .replace(/^\/view\//, "")
    .replace(/^\/raw\//, "")
    .replace(/^\/+/, "")
  try {
    rel = decodeURIComponent(rel)
  } catch {}
  if (/\.[a-z0-9]+$/i.test(rel) && !/\.(md|mdx|html?|txt)$/i.test(rel)) return null
  const candidates = [rel, normalizeRel(noteDir(currentPath), rel)]
  for (const c of candidates) {
    const hit = fileByKey.get(c.toLowerCase())
    if (hit) return { path: hit, hash }
  }
  const stem = rel
    .split("/")
    .pop()
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
  const byStem = fileByStem.get(stem)
  return byStem ? { path: byStem, hash } : { path: rel, hash, missing: true }
}

function appHref(path, hash = "") {
  return `${notesURL("/")}?path=${encodeURIComponent(path)}${hash ? `#${encodeURIComponent(hash)}` : ""}`
}

function openValue(path, hash = "") {
  return `${path}${hash ? `#${hash}` : ""}`
}

function headingId(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\w]+/g, "-")
}

// ── Preview code syntax highlighting ───────────────────────────────────────
function isHtmlLang(lang) {
  return ["html", "htm", "xml", "svg"].includes(String(lang || "").toLowerCase())
}

function highlightCode(src, lang = "") {
  const safe = esc(src)
  const l = lang.toLowerCase()
  if (["html", "xml", "svg"].includes(l)) {
    return safe
      .replace(/(&lt;\/?)([\w:-]+)/g, '$1<span class="tok-tag">$2</span>')
      .replace(
        /([\w:-]+)(=)(&quot;[^&]*?&quot;|'[^']*?')/g,
        '<span class="tok-attr">$1</span>$2<span class="tok-str">$3</span>',
      )
      .replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="tok-comment">$1</span>')
  }
  if (["c", "h", "cpp", "cxx", "cc", "js", "ts", "tsx", "jsx"].includes(l)) {
    return safe
      .replace(/(\/\/.*?$|\/\*[\s\S]*?\*\/)/gm, '<span class="tok-comment">$1</span>')
      .replace(/(&quot;.*?&quot;|'.*?')/g, '<span class="tok-str">$1</span>')
      .replace(/\b(0x[0-9a-fA-F]+|\d+)\b/g, '<span class="tok-num">$1</span>')
      .replace(
        /\b(const|static|volatile|struct|enum|typedef|return|if|else|for|while|do|switch|case|break|continue|sizeof|void|int|uint32_t|uint16_t|uint8_t|bool|true|false|function|let|const|var|async|await|class|new|try|catch|throw|import|export)\b/g,
        '<span class="tok-kw">$1</span>',
      )
      .replace(/\b([A-Za-z_]\w*)(?=\()/g, '<span class="tok-fn">$1</span>')
  }
  if (["bash", "sh", "shell"].includes(l)) {
    return safe
      .replace(/(#.*?$)/gm, '<span class="tok-comment">$1</span>')
      .replace(/(&quot;.*?&quot;|'.*?')/g, '<span class="tok-str">$1</span>')
      .replace(
        /\b(if|then|else|fi|for|in|do|done|case|esac|while|export|local|set)\b/g,
        '<span class="tok-kw">$1</span>',
      )
  }
  if (["plantuml", "puml", "mermaid"].includes(l)) {
    return safe
      .replace(/('.*?$|%%.*?$)/gm, '<span class="tok-comment">$1</span>')
      .replace(/(&quot;.*?&quot;|'.*?')/g, '<span class="tok-str">$1</span>')
      .replace(
        /\b(@startuml|@enduml|participant|actor|database|queue|control|skinparam|flowchart|graph|sequenceDiagram|classDiagram|stateDiagram-v2|subgraph|end|note|as)\b/g,
        '<span class="tok-kw">$1</span>',
      )
  }
  return safe
}

function renderCodeBlock(code, lang = "", copy = true) {
  const title = esc(lang || "text")
  const source = `<pre class="code-block"><div class="code-title">${title}</div>${copy ? '<button class="copy-btn" onclick="copyCode(this)">Copy</button>' : ""}<code class="lang-${esc(lang)}">${highlightCode(code, lang)}</code></pre>`
  if (!isHtmlLang(lang)) return source
  return `<div class="html-render-block" data-html-mode="preview"><div class="html-block-bar"><span>${title}</span><button class="html-toggle" data-html-toggle>Source</button></div><div class="html-source">${source}</div><div class="html-live"><iframe class="html-live-frame" sandbox="" srcdoc="${esc(code)}"></iframe></div></div>`
}

// ── PlantUML — native render via local /api/plantuml (plantuml binary) ──────
async function renderPlantUML(src) {
  try {
    const res = await fetch(notesURL("/api/plantuml"), {
      method: "POST",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: src,
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }))
      return `<div class="diagram-error">PlantUML error: ${esc(String(err.error || res.statusText))}</div>`
    }
    const svg = await res.text()
    // Wrap in a div so we can style it; strip XML declaration if present
    const clean = svg.replace(/<\?xml[^>]*>/, "").trim()
    return `<div class="diagram-svg">${clean}</div>`
  } catch (e) {
    return `<div class="diagram-error">PlantUML error: ${esc(String(e))}</div>`
  }
}

// ── Diagram extraction ─────────────────────────────────────────────────────
const DIAGRAMS = []

function extractDiagrams(src) {
  DIAGRAMS.length = 0
  let idx = 0
  return src.replace(/```(mermaid|plantuml|puml)([\s\S]*?)```/gi, (_, lang, code) => {
    const id = `DIAGRAM_${idx++}`
    DIAGRAMS.push({ id, lang: lang.toLowerCase(), code: code.trim() })
    return `\nDIAGRAM_BLOCK_${id}\n`
  })
}

// ── Inline renderer ────────────────────────────────────────────────────────
function renderInline(s) {
  s = esc(s)
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>")
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>")
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
  s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>")
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>")
  s = s.replace(/==([^=]+)==/g, "<mark>$1</mark>")
  s = s.replace(/(^|\s)(#[a-zA-Z][a-zA-Z0-9_/-]*)/g, (_, pre, tag) => `${pre}<span class="tag">${tag}</span>`)
  s = s.replace(/\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g, (_, target, hash, label) => {
    const resolved = resolveNoteTarget(`${target}${hash ? `#${hash}` : ""}`)
    const text = label || target
    if (!resolved || resolved.unsafe) return `<span class="broken-link">${text}</span>`
    const cls = resolved.missing ? "internal-link missing-link" : "internal-link"
    return `<a href="${esc(appHref(resolved.path, resolved.hash))}" data-open="${esc(openValue(resolved.path, resolved.hash))}" class="${cls}">${text}</a>`
  })
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
    const resolved = resolveNoteTarget(href)
    if (resolved?.unsafe) return `<span class="broken-link">${label}</span>`
    if (resolved) {
      const cls = resolved.missing ? "internal-link missing-link" : "internal-link"
      return `<a href="${esc(appHref(resolved.path, resolved.hash))}" data-open="${esc(openValue(resolved.path, resolved.hash))}" class="${cls}">${label}</a>`
    }
    return `<a href="${esc(unesc(href))}" target="_blank" rel="noopener">${label}</a>`
  })
  return s
}

// ── Raw editor syntax highlight ─────────────────────────────────────────────
function colorRawInline(line) {
  return esc(line)
    .replace(/(`[^`]+`)/g, '<span class="raw-code">$1</span>')
    .replace(/(\[\[[^\]]+\]\])/g, '<span class="raw-link">$1</span>')
    .replace(/(\[[^\]]+\]\([^)]+\))/g, '<span class="raw-link">$1</span>')
    .replace(/(\*\*[^*]+\*\*)/g, '<span class="raw-strong">$1</span>')
    .replace(/(^|\s)(#[a-zA-Z][\w/-]*)/g, '$1<span class="raw-tag">$2</span>')
    .replace(/(\*[^*]+\*)/g, '<span class="raw-em">$1</span>')
}

function highlightRawMarkdown(src) {
  const lines = src.split(/\r?\n/)
  const out = []
  let inFence = false
  let inFrontmatter = lines[0] === "---"

  lines.forEach((line, i) => {
    if ((i === 0 && line === "---") || inFrontmatter) {
      out.push(`<span class="raw-frontmatter">${esc(line)}</span>`)
      if (i > 0 && line === "---") inFrontmatter = false
      return
    }

    const fence = line.match(/^```\s*([\w-]*)/)
    if (fence) {
      inFence = !inFence
      out.push(`<span class="raw-fence">${esc(line)}</span>`)
      return
    }
    if (inFence) {
      out.push(`<span class="raw-code">${esc(line)}</span>`)
      return
    }
    if (/^#{1,6}\s/.test(line)) {
      out.push(`<span class="raw-heading">${colorRawInline(line)}</span>`)
      return
    }
    if (/^\s*[-*+]\s+(\[[ x]\]\s+)?/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      out.push(`<span class="raw-list">${colorRawInline(line)}</span>`)
      return
    }
    if (/^>\s?/.test(line)) {
      out.push(`<span class="raw-quote">${colorRawInline(line)}</span>`)
      return
    }
    if (line.includes("|")) {
      out.push(`<span class="raw-table">${colorRawInline(line)}</span>`)
      return
    }
    out.push(colorRawInline(line))
  })

  return out.join("\n")
}

function updateEditorHighlight() {
  const hi = $("editorHighlight")
  const ed = $("editor")
  if (!hi || !ed) return
  hi.innerHTML = highlightRawMarkdown(ed.value) + "\n"
}

function syncEditorHighlightScroll() {
  const hi = $("editorHighlight")
  const ed = $("editor")
  if (!hi || !ed) return
  hi.scrollTop = ed.scrollTop
  hi.scrollLeft = ed.scrollLeft
}

// ── MDX / Obsidian callout components ─────────────────────────────────────
function renderComponents(src) {
  // Obsidian callout: > [!type] Title\n> body
  src = src.replace(
    /^>\s*\[!(note|info|tip|warning|danger|caution|important|success|question|bug|example|quote)\]\s*(.*)\n((?:>.*\n?)*)/gim,
    (_, type, title, body) => {
      const icons = {
        note: "📝",
        info: "ℹ️",
        tip: "💡",
        warning: "⚠️",
        danger: "🔥",
        caution: "⚠️",
        important: "❗",
        success: "✅",
        question: "❓",
        bug: "🐛",
        example: "📋",
        quote: "💬",
      }
      const cls = type
        .toLowerCase()
        .replace("caution", "warning")
        .replace("important", "warning")
        .replace("success", "tip")
        .replace("question", "info")
        .replace("bug", "danger")
        .replace("example", "note")
        .replace("quote", "note")
      const bodyText = body.replace(/^>\s?/gm, "")
      return `<div class="callout ${cls}"><div class="callout-title"><span class="callout-icon">${icons[type] || "📝"}</span>${esc(title || type)}</div>${renderMarkdown(bodyText)}</div>`
    },
  )
  src = src.replace(
    /<Callout(?:\s+type="([^"]+)")?(?:\s+title="([^"]+)")?>([\s\S]*?)<\/Callout>/gi,
    (_, type = "info", title = "Note", body) =>
      `<div class="callout ${esc(type)}"><div class="callout-title">${esc(title)}</div>${renderMarkdown(body)}</div>`,
  )
  src = src.replace(
    /<Card(?:\s+title="([^"]+)")?>([\s\S]*?)<\/Card>/gi,
    (_, title = "", body) =>
      `<div class="card">${title ? `<div class="card-title">${esc(title)}</div>` : ""}${renderMarkdown(body)}</div>`,
  )
  return src
}

// ── YAML frontmatter renderer ──────────────────────────────────────────────
function parseYamlScalar(value) {
  const v = String(value || "").trim()
  if (!v) return ""
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1)
  if (v.startsWith("[") && v.endsWith("]"))
    return v
      .slice(1, -1)
      .split(",")
      .map((x) => x.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean)
  return v
}

function parseFrontmatter(lines) {
  const rows = []
  let current = null
  for (const raw of lines) {
    const item = raw.match(/^\s*-\s+(.+)$/)
    if (item && current) {
      if (!Array.isArray(current.value)) current.value = current.value ? [current.value] : []
      current.value.push(parseYamlScalar(item[1]))
      continue
    }
    const kv = raw.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/)
    if (kv) {
      current = { key: kv[1], value: parseYamlScalar(kv[2]) }
      rows.push(current)
      continue
    }
    if (current && /^\s+\S/.test(raw))
      current.value = `${Array.isArray(current.value) ? current.value.join(", ") : current.value} ${raw.trim()}`.trim()
  }
  return rows
}

function renderYamlValue(value) {
  if (Array.isArray(value))
    return `<div class="fm-chips">${value.map((v) => `<span class="fm-chip">${renderInline(String(v))}</span>`).join("")}</div>`
  const text = String(value ?? "")
  if (/^(true|false)$/i.test(text)) return `<span class="fm-bool">${esc(text)}</span>`
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return `<span class="fm-num">${esc(text)}</span>`
  return renderInline(text)
}

function renderFrontmatter(lines) {
  const rows = parseFrontmatter(lines)
  if (!rows.length) return `<div class="frontmatter"><pre>${esc(lines.join("\n"))}</pre></div>`
  return `<section class="frontmatter"><div class="frontmatter-title">Metadata</div><dl class="fm-grid">${rows.map((r) => `<dt>${esc(r.key)}</dt><dd>${renderYamlValue(r.value)}</dd>`).join("")}</dl></section>`
}

// ── Markdown renderer ──────────────────────────────────────────────────────
function createMarkdownState(lines) {
  return {
    lines,
    out: [],
    inCode: false,
    codeLang: "",
    codeLines: [],
    inList: false,
    listOrdered: false,
    inTable: false,
    tableHead: false,
    fmLines: [],
    fmDone: lines[0] !== "---",
  }
}

function closeList(state) {
  if (!state.inList) return
  state.out.push(state.listOrdered ? "</ol>" : "</ul>")
  state.inList = false
}

function closeTable(state) {
  if (!state.inTable) return
  state.out.push("</tbody></table>")
  state.inTable = false
}

function closeFlowBlocks(state) {
  closeList(state)
  closeTable(state)
}

function renderFrontmatterLine(state, line, index) {
  if (index === 0 && line === "---") return true
  if (state.fmDone || state.inCode || index === 0) return false
  if (line === "---") {
    state.fmDone = true
    state.out.push(renderFrontmatter(state.fmLines))
    return true
  }
  state.fmLines.push(line)
  return true
}

function renderFenceLine(state, line) {
  const fence = line.match(/^```(\w*)/)
  if (fence && !state.inCode) {
    closeFlowBlocks(state)
    state.inCode = true
    state.codeLang = fence[1].toLowerCase()
    state.codeLines = []
    return true
  }
  if (!state.inCode) return false
  if (line.startsWith("```")) {
    state.out.push(renderCodeBlock(state.codeLines.join("\n"), state.codeLang))
    state.inCode = false
    state.codeLang = ""
    state.codeLines = []
  } else {
    state.codeLines.push(line)
  }
  return true
}

function renderDiagramLine(state, line) {
  const match = line.match(/^DIAGRAM_BLOCK_(DIAGRAM_\d+)$/)
  if (!match) return false
  state.out.push(`<div class="diagram-wrap" data-diagram="${esc(match[1])}">Rendering diagram…</div>`)
  return true
}

function renderHeadingLine(state, line) {
  const match = line.match(/^(#{1,6})\s+(.+)$/)
  if (!match) return false
  closeFlowBlocks(state)
  const level = match[1].length
  const id = match[2].toLowerCase().replace(/[^\w]+/g, "-")
  state.out.push(`<h${level} id="${esc(id)}">${renderInline(match[2])}</h${level}>`)
  return true
}

function renderHorizontalRuleLine(state, line) {
  if (!/^---+$/.test(line) && !/^\*\*\*+$/.test(line)) return false
  closeList(state)
  state.out.push("<hr>")
  return true
}

function tableCells(line) {
  if (!line.includes("|")) return null
  const cells = line.split("|").filter((_, i, all) => i > 0 && i < all.length - 1)
  return cells.length > 0 ? cells : null
}

function renderTableLine(state, line) {
  const cells = tableCells(line)
  if (!cells) {
    closeTable(state)
    return false
  }
  if (!state.inTable) {
    closeList(state)
    state.out.push("<table><thead><tr>")
    cells.forEach((cell) => state.out.push(`<th>${renderInline(cell.trim())}</th>`))
    state.out.push("</tr></thead><tbody>")
    state.inTable = true
    state.tableHead = true
    return true
  }
  if (state.tableHead && /^[\s|:-]+$/.test(line)) {
    state.tableHead = false
    return true
  }
  state.out.push("<tr>")
  cells.forEach((cell) => state.out.push(`<td>${renderInline(cell.trim())}</td>`))
  state.out.push("</tr>")
  return true
}

function ensureList(state, ordered) {
  if (state.inList && state.listOrdered === ordered) return
  if (state.inList) state.out.push(state.listOrdered ? "</ol>" : "</ul>")
  state.out.push(ordered ? "<ol>" : "<ul>")
  state.inList = true
  state.listOrdered = ordered
}

function renderListLine(state, line) {
  const checkbox = line.match(/^(\s*)[-*+]\s+\[([ x])\]\s+(.*)$/)
  if (checkbox) {
    ensureList(state, false)
    state.out.push(
      `<li><input type="checkbox" ${checkbox[2] === "x" ? "checked" : ""} disabled> ${renderInline(checkbox[3])}</li>`,
    )
    return true
  }

  const unordered = line.match(/^(\s*)[-*+]\s+(.*)$/)
  if (unordered) {
    ensureList(state, false)
    state.out.push(`<li>${renderInline(unordered[2])}</li>`)
    return true
  }

  const ordered = line.match(/^(\s*)\d+\.\s+(.*)$/)
  if (ordered) {
    ensureList(state, true)
    state.out.push(`<li>${renderInline(ordered[2])}</li>`)
    return true
  }

  if (state.inList && !/^\s/.test(line)) closeList(state)
  return false
}

function renderSimpleLine(state, line) {
  if (line.startsWith("> ")) {
    state.out.push(`<blockquote>${renderInline(line.slice(2))}</blockquote>`)
    return true
  }
  if (/^\s*$/.test(line)) {
    state.out.push("")
    return true
  }
  state.out.push(`<p>${renderInline(line)}</p>`)
  return true
}

const markdownLineRenderers = [
  renderFenceLine,
  renderDiagramLine,
  renderHeadingLine,
  renderHorizontalRuleLine,
  renderTableLine,
  renderListLine,
  renderSimpleLine,
]

function renderMarkdown(src) {
  const state = createMarkdownState(renderComponents(src).split(/\r?\n/))
  state.lines.forEach((line, index) => {
    if (renderFrontmatterLine(state, line, index)) return
    markdownLineRenderers.some((renderer) => renderer(state, line))
  })
  closeList(state)
  closeTable(state)
  if (state.inCode) state.out.push(renderCodeBlock(state.codeLines.join("\n"), state.codeLang, false))
  return state.out.join("\n")
}

// ── Render preview ─────────────────────────────────────────────────────────
async function renderPreview() {
  const previewEl = $("preview")
  const ed = $("editor")
  if (!previewEl || !ed) return
  const ext = currentPath.toLowerCase().split(".").pop()
  const text = ed.value

  if (!currentPath) {
    previewEl.innerHTML = '<p style="color:var(--text-faint);padding:2em">Select or create a note.</p>'
    return
  }
  if (ext === "html" || ext === "htm") {
    previewEl.innerHTML = `<iframe style="width:100%;height:calc(100vh - 130px);background:white;border:1px solid var(--border);border-radius:var(--radius-lg)" sandbox="allow-same-origin allow-scripts" srcdoc="${esc(text)}"></iframe>`
    return
  }

  const srcWithPH = extractDiagrams(text)
  previewEl.innerHTML = renderMarkdown(srcWithPH)
  await renderDiagrams(previewEl)
  buildTOC(previewEl)
}

function setViewMode(mode) {
  viewMode = mode === "raw" ? "raw" : "preview"
  localStorage.setItem("notesViewMode", viewMode)
  const pane = $("paneContainer")
  if (pane) {
    pane.classList.toggle("mode-raw", viewMode === "raw")
    pane.classList.toggle("mode-preview", viewMode === "preview")
    pane.classList.remove("split")
  }
  const btn = $("viewToggle")
  if (btn) {
    btn.textContent = viewMode === "preview" ? "Raw" : "Preview"
    btn.title = viewMode === "preview" ? "Switch to raw editor" : "Switch to rendered preview"
    btn.classList.toggle("active", viewMode === "preview")
  }
  if (viewMode === "preview") renderPreview()
  else {
    updateEditorHighlight()
    $("editor")?.focus()
  }
}

function diagramChrome(inner) {
  return `<div class="diagram-toolbar"><button class="diagram-tb-btn" data-diagram-zoom="in">＋</button><button class="diagram-tb-btn" data-diagram-zoom="out">−</button><button class="diagram-tb-btn" data-diagram-zoom="reset">Reset</button></div><div class="diagram-pan"><div class="diagram-canvas">${inner}</div></div>`
}

function initDiagramPan(wrap) {
  const pan = wrap.querySelector(".diagram-pan")
  const canvas = wrap.querySelector(".diagram-canvas")
  if (!pan || !canvas) return
  const state = { x: 24, y: 18, scale: 1, dragging: false, sx: 0, sy: 0 }
  const apply = () => {
    canvas.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.scale})`
  }
  const zoomAt = (factor, cx = pan.clientWidth / 2, cy = pan.clientHeight / 2) => {
    const old = state.scale
    state.scale = Math.max(0.15, Math.min(5, state.scale * factor))
    state.x = cx - ((cx - state.x) / old) * state.scale
    state.y = cy - ((cy - state.y) / old) * state.scale
    apply()
  }
  apply()
  pan.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault()
      const r = pan.getBoundingClientRect()
      zoomAt(e.deltaY < 0 ? 1.12 : 0.88, e.clientX - r.left, e.clientY - r.top)
    },
    { passive: false },
  )
  pan.addEventListener("pointerdown", (e) => {
    state.dragging = true
    state.sx = e.clientX - state.x
    state.sy = e.clientY - state.y
    pan.classList.add("panning")
    pan.setPointerCapture(e.pointerId)
  })
  pan.addEventListener("pointermove", (e) => {
    if (!state.dragging) return
    state.x = e.clientX - state.sx
    state.y = e.clientY - state.sy
    apply()
  })
  pan.addEventListener("pointerup", (e) => {
    state.dragging = false
    pan.classList.remove("panning")
    pan.releasePointerCapture(e.pointerId)
  })
  wrap.querySelectorAll("[data-diagram-zoom]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const action = btn.dataset.diagramZoom
      if (action === "in") zoomAt(1.2)
      else if (action === "out") zoomAt(0.8)
      else {
        state.x = 24
        state.y = 18
        state.scale = 1
        apply()
      }
    }),
  )
}

async function renderDiagrams(container) {
  const wraps = container.querySelectorAll("[data-diagram]")
  let mermaidIdx = 0
  for (const wrap of wraps) {
    const ph = DIAGRAMS.find((d) => d.id === wrap.dataset.diagram)
    if (!ph) continue
    try {
      if (ph.lang === "mermaid") {
        // Use mermaid.render() — returns SVG string, no DOM dependency
        const id = "mermaid-render-" + mermaidIdx++
        const { svg } = await mermaid.render(id, ph.code)
        wrap.innerHTML = diagramChrome(svg)
        wrap.removeAttribute("data-diagram")
        initDiagramPan(wrap)
      } else {
        wrap.innerHTML = diagramChrome(await renderPlantUML(ph.code))
        wrap.removeAttribute("data-diagram")
        initDiagramPan(wrap)
      }
    } catch (e) {
      wrap.innerHTML = `<div class="diagram-error">${esc(ph.lang)} error: ${esc(String(e))}</div>`
    }
  }
}

// ── TOC ────────────────────────────────────────────────────────────────────
function buildTOC(container) {
  const toc = $("toc")
  if (!toc) return
  const heads = container.querySelectorAll("h1,h2,h3,h4")
  if (heads.length < 2) {
    toc.classList.add("hidden")
    return
  }
  toc.innerHTML = '<div class="toc-title">Contents</div>'
  heads.forEach((h) => {
    const depth = parseInt(h.tagName[1]) - 1
    const item = document.createElement("a")
    item.className = "toc-item"
    item.style.setProperty("--depth", depth)
    item.textContent = h.textContent
    item.onclick = () => h.scrollIntoView({ behavior: "smooth" })
    toc.appendChild(item)
  })
}

// ── File tree ──────────────────────────────────────────────────────────────
function buildTree() {
  const tree = $("tree")
  if (!tree) return
  const root = { folders: new Map(), files: [] }
  for (const f of files) {
    let node = root
    const parts = f.path.split("/")
    for (const part of parts.slice(0, -1)) {
      if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), files: [] })
      node = node.folders.get(part)
    }
    node.files.push(f)
  }
  const activeDirs = new Set()
  const cp = currentPath.split("/")
  for (let i = 1; i < cp.length; i++) activeDirs.add(cp.slice(0, i).join("/"))

  function renderNode(node, parentEl, prefix = "", depth = 0) {
    ;[...node.folders.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .forEach(([name, child]) => {
        const full = prefix ? `${prefix}/${name}` : name
        const isCollapsed = collapsedFolders.has(full) && !activeDirs.has(full)
        const row = document.createElement("div")
        row.className = "tree-folder" + (!isCollapsed ? " open" : "")
        row.dataset.folder = full
        row.style.paddingLeft = `${8 + depth * 12}px`
        row.innerHTML = `<span class="tree-folder-icon">▸</span><span>${esc(name)}</span>`
        parentEl.appendChild(row)
        const children = document.createElement("div")
        children.className = "tree-children" + (isCollapsed ? " collapsed" : "")
        parentEl.appendChild(children)
        renderNode(child, children, full, depth + 1)
      })
    node.files
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((f) => {
        const el = document.createElement("div")
        el.className = "file-item" + (f.path === currentPath ? " active" : "")
        el.dataset.path = f.path
        el.style.paddingLeft = `${20 + depth * 12}px`
        el.innerHTML = `<span style="flex:1;overflow:hidden;text-overflow:ellipsis">${esc(f.name.replace(/\.[^.]+$/, ""))}</span><span class="file-ext">${esc(f.ext.slice(1))}</span>`
        parentEl.appendChild(el)
      })
  }

  tree.innerHTML = ""
  renderNode(root, tree)
}

async function loadTree() {
  const data = await api(notesURL("/api/tree"))
  files = data.files
  rebuildFileIndex()
  const rootLabel = $("rootLabel")
  if (rootLabel) rootLabel.textContent = data.root
  buildTree()
  if (!currentPath && files[0]) await openFile(files[0].path)
}

// ── Open file ──────────────────────────────────────────────────────────────
async function openFile(path) {
  const target = splitTarget(path)
  const targetPath = target.path || currentPath
  if (!targetPath) return
  if (dirty && !confirm("Discard unsaved changes?")) return
  const data = await api(notesURL("/api/file?path=" + encodeURIComponent(targetPath)))
  currentPath = data.path
  history.replaceState(null, "", appHref(currentPath, target.hash))
  const statusPath = $("statusPath")
  if (statusPath) statusPath.textContent = currentPath
  const rawLink = $("rawLink")
  if (rawLink) rawLink.href = notesURL("/raw/" + currentPath.split("/").map(encodeURIComponent).join("/"))
  $("editor").value = data.content
  updateEditorHighlight()
  dirty = false
  updateStatus()
  updateTabBar()
  buildTree()
  await renderPreview()
  if (target.hash) scrollToHash(target.hash)
  await loadBacklinks()
  const statusExt = $("statusExt")
  if (statusExt) statusExt.textContent = data.ext
}

function scrollToHash(hash) {
  const preview = $("preview")
  if (!preview) return
  let raw = hash || ""
  try {
    raw = decodeURIComponent(raw)
  } catch {}
  const id = raw || headingId(raw)
  requestAnimationFrame(() => {
    const el = document.getElementById(id) || document.getElementById(headingId(raw))
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" })
  })
}

// ── Tab bar ────────────────────────────────────────────────────────────────
const openTabPaths = []
function updateTabBar() {
  const openTabs = $("openTabs")
  if (!openTabs) return
  if (!openTabPaths.includes(currentPath)) openTabPaths.push(currentPath)
  openTabs.innerHTML = openTabPaths
    .map((p) => {
      const name = p
        .split("/")
        .pop()
        .replace(/\.[^.]+$/, "")
      return `<div class="tab-item${p === currentPath ? " active" : ""}${dirty && p === currentPath ? " dirty" : ""}" data-path="${esc(p)}">
      <span>${esc(name)}</span>
      <span class="tab-close" data-close="${esc(p)}">×</span>
    </div>`
    })
    .join("")
}

// ── Save ───────────────────────────────────────────────────────────────────
async function saveFile() {
  if (!currentPath) return
  await api(notesURL("/api/file?path=" + encodeURIComponent(currentPath)), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: $("editor").value }),
  })
  dirty = false
  updateStatus()
  updateTabBar()
}

// ── New / Rename / Delete ──────────────────────────────────────────────────
async function newFile() {
  const path = prompt("New note path (.md, .mdx, .html, .txt):", "new-note.md")
  if (!path) return
  await api(notesURL("/api/file"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, content: `# ${path.replace(/\.[^.]+$/, "")}\n\n` }),
  })
  await loadTree()
  await openFile(path)
}
async function renameFile() {
  if (!currentPath) return
  const to = prompt("Rename/move to:", currentPath)
  if (!to || to === currentPath) return
  await api(notesURL("/api/move"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from: currentPath, to }),
  })
  const idx = openTabPaths.indexOf(currentPath)
  if (idx >= 0) openTabPaths[idx] = to
  currentPath = to
  await loadTree()
  await openFile(to)
}
async function deleteFile() {
  if (!currentPath) return
  if (!confirm(`Delete ${currentPath}? A backup will be created.`)) return
  await api(notesURL("/api/file?path=" + encodeURIComponent(currentPath)), { method: "DELETE" })
  const idx = openTabPaths.indexOf(currentPath)
  if (idx >= 0) openTabPaths.splice(idx, 1)
  currentPath = openTabPaths[openTabPaths.length - 1] || ""
  $("editor").value = ""
  await loadTree()
  if (currentPath) await openFile(currentPath)
  else {
    const statusPath = $("statusPath")
    if (statusPath) statusPath.textContent = "No file selected"
    $("preview").innerHTML = ""
    updateTabBar()
  }
}

// ── Search ─────────────────────────────────────────────────────────────────
async function search() {
  const q = $("search").value.trim()
  if (!q) {
    $("searchResults").innerHTML = ""
    return
  }
  const data = await api(notesURL("/api/search?q=" + encodeURIComponent(q)))
  $("searchResults").innerHTML =
    data.results
      .map(
        (r) =>
          `<div class="hit${r.kind === "file" ? " file-hit" : ""}" data-path="${esc(r.path)}">
      <div class="hit-path">${esc(r.path)}${r.line ? ":" + r.line : ""}</div>
      <div class="hit-text">${r.kind === "file" ? "Filename match" : esc(r.text)}</div>
    </div>`,
      )
      .join("") || '<div class="muted" style="padding:8px">No matches.</div>'
}

// ── Backlinks ──────────────────────────────────────────────────────────────
async function loadBacklinks() {
  if (!currentPath) return
  const data = await api(notesURL("/api/backlinks?path=" + encodeURIComponent(currentPath)))
  const backlinksList = $("backlinksList")
  if (!backlinksList) return
  backlinksList.innerHTML = data.backlinks.length
    ? data.backlinks.map((b) => `<div class="backlink-item" data-path="${esc(b.path)}">${esc(b.path)}</div>`).join("")
    : '<div class="muted" style="padding:8px;font-size:12px">No backlinks.</div>'
}

// ── Graph (canvas) ─────────────────────────────────────────────────────────
async function loadGraph() {
  const data = await api(notesURL("/api/graph"))
  const canvas = $("graphCanvas")
  if (!canvas) return
  const W = canvas.parentElement.clientWidth
  const H = Math.max(canvas.parentElement.clientHeight - 40, 200)
  canvas.width = W
  canvas.height = H
  graphNodes = data.nodes.map((path, i) => {
    const angle = (i / data.nodes.length) * Math.PI * 2
    const r = Math.min(W, H) * 0.35
    return { path, x: W / 2 + r * Math.cos(angle), y: H / 2 + r * Math.sin(angle) }
  })
  graphEdges = data.edges
  const graphInfo = $("graphInfo")
  if (graphInfo) graphInfo.textContent = `${data.nodes.length} notes · ${data.edges.length} links`
  drawGraph()
}

function drawGraph() {
  const canvas = $("graphCanvas")
  const ctx = canvas.getContext("2d")
  const W = canvas.width,
    H = canvas.height
  const isDark = document.body.classList.contains("theme-dark")
  ctx.clearRect(0, 0, W, H)
  ctx.save()
  ctx.translate(graphOffset.x, graphOffset.y)
  ctx.scale(graphScale, graphScale)
  ctx.strokeStyle = isDark ? "#313244" : "#d0d3e0"
  ctx.lineWidth = 1
  graphEdges.forEach((e) => {
    const s = graphNodes.find((n) => n.path === e.from),
      d = graphNodes.find((n) => n.path === e.to)
    if (!s || !d) return
    ctx.beginPath()
    ctx.moveTo(s.x, s.y)
    ctx.lineTo(d.x, d.y)
    ctx.stroke()
  })
  graphNodes.forEach((n) => {
    const active = n.path === currentPath
    ctx.beginPath()
    ctx.arc(n.x, n.y, active ? 7 : 5, 0, Math.PI * 2)
    ctx.fillStyle = active ? (isDark ? "#f38ba8" : "#dc2626") : isDark ? "#cba6f7" : "#7c3aed"
    ctx.fill()
    ctx.fillStyle = isDark ? "#6c7086" : "#6b7280"
    ctx.font = "10px system-ui"
    ctx.fillText(
      n.path
        .split("/")
        .pop()
        .replace(/\.[^.]+$/, ""),
      n.x + 8,
      n.y + 4,
    )
  })
  ctx.restore()
}

const gCanvas = $("graphCanvas")
if (gCanvas) {
  gCanvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault()
      graphScale = Math.max(0.3, Math.min(3, graphScale * (e.deltaY < 0 ? 1.1 : 0.9)))
      drawGraph()
    },
    { passive: false },
  )
  gCanvas.addEventListener("mousedown", (e) => {
    const rect = gCanvas.getBoundingClientRect()
    const mx = (e.clientX - rect.left - graphOffset.x) / graphScale
    const my = (e.clientY - rect.top - graphOffset.y) / graphScale
    const hit = graphNodes.find((n) => Math.hypot(n.x - mx, n.y - my) < 10)
    if (hit) graphDrag = hit
    else panStart = { x: e.clientX - graphOffset.x, y: e.clientY - graphOffset.y }
  })
  document.addEventListener("mousemove", (e) => {
    if (graphDrag) {
      const rect = gCanvas.getBoundingClientRect()
      graphDrag.x = (e.clientX - rect.left - graphOffset.x) / graphScale
      graphDrag.y = (e.clientY - rect.top - graphOffset.y) / graphScale
      drawGraph()
    } else if (panStart) {
      graphOffset.x = e.clientX - panStart.x
      graphOffset.y = e.clientY - panStart.y
      drawGraph()
    }
  })
  document.addEventListener("mouseup", (e) => {
    if (graphDrag) {
      const rect = gCanvas.getBoundingClientRect()
      const mx = (e.clientX - rect.left - graphOffset.x) / graphScale
      const my = (e.clientY - rect.top - graphOffset.y) / graphScale
      if (Math.hypot(graphDrag.x - mx, graphDrag.y - my) < 3) openFile(graphDrag.path)
    }
    graphDrag = null
    panStart = null
  })
}

// ── Status bar ─────────────────────────────────────────────────────────────
function updateStatus() {
  const ed = $("editor")
  if (!ed) return
  const text = ed.value
  const words = text.trim() ? text.trim().split(/\s+/).length : 0
  const statusWords = $("statusWords")
  if (statusWords) statusWords.textContent = `${words} words`
  const statusLines = $("statusLines")
  if (statusLines) statusLines.textContent = `${text.split("\n").length} lines`
  const statusDirty = $("statusDirty")
  if (statusDirty) statusDirty.textContent = dirty ? "● unsaved" : ""
}

// ── Copy code ──────────────────────────────────────────────────────────────
window.copyCode = (btn) => {
  const code = btn.nextElementSibling?.textContent || ""
  navigator.clipboard.writeText(code).then(() => {
    btn.textContent = "Copied!"
    setTimeout(() => (btn.textContent = "Copy"), 1500)
  })
}

// ── Assistant ──────────────────────────────────────────────────────────────
async function ask() {
  const question = $("question")
  const answer = $("answer")
  if (!question || !answer) return
  const data = await api(notesURL("/api/ai/ask"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: question.value, path: currentPath }),
  })
  answer.textContent = data.answer
}

// ── Ribbon / panel switching ───────────────────────────────────────────────
document.querySelectorAll(".ribbon-btn[data-panel]").forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll(".ribbon-btn").forEach((b) => b.classList.remove("active"))
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"))
    btn.classList.add("active")
    $(btn.dataset.panel)?.classList.add("active")
    if (btn.dataset.panel === "graph-panel") loadGraph()
  }
})

// ── Right sidebar tabs ─────────────────────────────────────────────────────
document.querySelectorAll(".rs-icon").forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll(".rs-icon").forEach((b) => b.classList.remove("active"))
    document.querySelectorAll(".rs-panel").forEach((p) => p.classList.remove("active"))
    btn.classList.add("active")
    $(btn.dataset.rs)?.classList.add("active")
  }
})

// ── Raw / preview toggle ───────────────────────────────────────────────────
const viewToggle = $("viewToggle")
if (viewToggle) viewToggle.onclick = () => setViewMode(viewMode === "preview" ? "raw" : "preview")

// ── TOC toggle ─────────────────────────────────────────────────────────────
const tocToggle = $("tocToggle")
if (tocToggle)
  tocToggle.onclick = () => {
    const toc = $("toc")
    if (toc) toc.classList.toggle("hidden")
  }

// ── Theme toggle ───────────────────────────────────────────────────────────
const themeToggle = $("themeToggle")
if (themeToggle) {
  if (EMBEDDED_IN_OPENCODE) {
    themeToggle.style.display = "none"
  } else {
    themeToggle.onclick = () => {
      setThemeMode(document.body.classList.contains("theme-light") ? "dark" : "light")
    }
  }
}

// ── Sidebar resize ─────────────────────────────────────────────────────────
const resizeHandle = $("resizeHandle")
const sidebar = document.querySelector(".sidebar")
let resizing = false
if (resizeHandle && sidebar) {
  resizeHandle.addEventListener("mousedown", () => {
    resizing = true
    resizeHandle.classList.add("dragging")
  })
  document.addEventListener("mousemove", (e) => {
    if (!resizing) return
    sidebar.style.width = Math.max(160, Math.min(480, e.clientX - 44)) + "px"
  })
  document.addEventListener("mouseup", () => {
    resizing = false
    resizeHandle.classList.remove("dragging")
  })
}

// ── Keyboard shortcuts ─────────────────────────────────────────────────────
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "s") {
    e.preventDefault()
    saveFile()
  }
  if ((e.ctrlKey || e.metaKey) && e.key === "p") {
    e.preventDefault()
    $("search")?.focus()
  }
})

// ── Event delegation ───────────────────────────────────────────────────────
document.body.addEventListener("click", async (e) => {
  const folder = e.target.closest("[data-folder]")?.dataset.folder
  if (folder) {
    e.preventDefault()
    if (collapsedFolders.has(folder)) collapsedFolders.delete(folder)
    else collapsedFolders.add(folder)
    localStorage.setItem("notesCollapsedFolders", JSON.stringify([...collapsedFolders]))
    buildTree()
    return
  }
  const htmlToggle = e.target.closest("[data-html-toggle]")
  if (htmlToggle) {
    e.preventDefault()
    const block = htmlToggle.closest(".html-render-block")
    const next = block?.dataset.htmlMode === "preview" ? "source" : "preview"
    if (block) block.dataset.htmlMode = next
    htmlToggle.textContent = next === "preview" ? "Source" : "Preview"
    return
  }
  const path = e.target.closest("[data-path]")?.dataset.path
  const open = e.target.closest("[data-open]")?.dataset.open
  const close = e.target.closest("[data-close]")?.dataset.close
  if (close) {
    e.stopPropagation()
    const idx = openTabPaths.indexOf(close)
    if (idx >= 0) openTabPaths.splice(idx, 1)
    if (close === currentPath) {
      currentPath = openTabPaths[openTabPaths.length - 1] || ""
      if (currentPath) await openFile(currentPath)
      else {
        const editor = $("editor")
        const preview = $("preview")
        if (editor) editor.value = ""
        if (preview) preview.innerHTML = ""
        updateTabBar()
      }
    } else updateTabBar()
    return
  }
  if (path || open) {
    e.preventDefault()
    try {
      await openFile(path || open)
    } catch (err) {
      alert("Open failed: " + err.message)
    }
  }
})

const editor = $("editor")
if (editor) {
  editor.addEventListener("input", () => {
    dirty = true
    updateStatus()
    updateTabBar()
    updateEditorHighlight()
    if (viewMode === "preview") renderPreview()
  })
  editor.addEventListener("scroll", syncEditorHighlightScroll)
}
const saveBtn = $("saveBtn")
if (saveBtn) saveBtn.onclick = saveFile
const newBtn = $("newBtn")
if (newBtn) newBtn.onclick = newFile
const renameBtn = $("renameBtn")
if (renameBtn) renameBtn.onclick = renameFile
const deleteBtn = $("deleteBtn")
if (deleteBtn) deleteBtn.onclick = deleteFile
const askBtn = $("askBtn")
if (askBtn) askBtn.onclick = ask
const searchInput = $("search")
if (searchInput)
  searchInput.addEventListener("input", () => {
    clearTimeout(window._st)
    window._st = setTimeout(search, 180)
  })

// ── Boot ───────────────────────────────────────────────────────────────────
setViewMode(viewMode)
loadTree()
  .then(async () => {
    let initialHash = location.hash ? location.hash.slice(1) : ""
    try {
      initialHash = decodeURIComponent(initialHash)
    } catch {}
    if (currentPath) await openFile(openValue(currentPath, initialHash))
    setViewMode(viewMode)
  })
  .catch((err) => alert("Boot error: " + err.message))
