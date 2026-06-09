import { Icon } from "@opencode-ai/ui/icon"
import { Markdown } from "@opencode-ai/ui/markdown"
import { For, Match, Show, Switch, createEffect, createMemo, createResource, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { unified } from "unified"
import remarkParse from "remark-parse"
import remarkMdx from "remark-mdx"
import { useSurfaceSessionBridge } from "@/surface/session-provider"
import { diagnosticError, emitDiagnosticLog } from "@/utils/diagnostic-log"
import { useSessionLayout } from "@/pages/session/session-layout"
import type { SurfaceTodoAgent } from "@/surface/ports"

const statusIconTone = (status: string) => {
  if (["completed", "done", "resolved"].includes(status)) {
    return "border-border-success-base bg-surface-success-weak text-text-on-success-base"
  }
  if (["in_progress", "in-progress", "running", "queued"].includes(status)) {
    return "border-border-warning-base bg-surface-warning-weak text-text-on-warning-base"
  }
  if (["pending", "open", "idle", "new", "missing-agent"].includes(status)) {
    return "border-border-critical-base bg-surface-critical-weak text-text-on-critical-base"
  }
  if (["cancelled", "failed", "blocked", "rejected"].includes(status)) {
    return "border-border-critical-base bg-surface-critical-weak text-text-on-critical-base"
  }
  return "border-border-weaker-base bg-surface-raised-base text-text-weak"
}

const todoDisplayStatus = (status: string) => {
  if (["completed", "done", "resolved"].includes(status)) return "done"
  if (["in_progress", "in-progress", "running", "queued"].includes(status)) return "running"
  if (["pending", "open", "idle", "new"].includes(status)) return "pending"
  return status
}

const isClosedTodoStatus = (status?: string) =>
  ["resolved", "done", "completed", "rejected", "cancelled"].includes(status ?? "")

const isRunningTodoStatus = (status?: string) =>
  ["in_progress", "in-progress", "running", "queued"].includes(status ?? "")

const compactID = (value?: string) => (value && value.length > 12 ? `${value.slice(0, 8)}…` : value)

const metadataValue = (value?: string) => value?.replace("T", " ").replace(/\.\d{3}Z$/, "Z")

const CALLOUT_TONES: Record<string, string> = {
  note: "border-border-info-base bg-surface-info-weak text-text-on-info-strong",
  info: "border-border-info-base bg-surface-info-weak text-text-on-info-strong",
  tip: "border-border-success-base bg-surface-success-weak text-text-on-success-base",
  success: "border-border-success-base bg-surface-success-weak text-text-on-success-base",
  warning: "border-border-warning-base bg-surface-warning-weak text-text-on-warning-strong",
  caution: "border-border-warning-base bg-surface-warning-weak text-text-on-warning-strong",
  important: "border-border-warning-base bg-surface-warning-weak text-text-on-warning-strong",
  danger: "border-border-critical-base bg-surface-critical-weak text-text-on-critical-base",
  bug: "border-border-critical-base bg-surface-critical-weak text-text-on-critical-base",
  question: "border-border-info-base bg-surface-info-weak text-text-on-info-strong",
  example: "border-border-weaker-base bg-surface-raised-base text-text-base",
  quote: "border-border-weaker-base bg-surface-raised-base text-text-base",
}

function normalizeTodoMarkdown(source: string) {
  const lines = source.split(/\r?\n/)
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const callout = lines[i]?.match(
      /^>\s*\[!(note|info|tip|success|warning|caution|important|danger|bug|question|example|quote)\]\s*(.*)$/i,
    )
    if (!callout) {
      out.push(lines[i] ?? "")
      continue
    }
    const type = (callout[1] ?? "note").toLowerCase()
    const title = (callout[2] ?? type).trim() || type
    const body: string[] = []
    while (i + 1 < lines.length && /^>/.test(lines[i + 1] ?? "")) {
      i++
      body.push((lines[i] ?? "").replace(/^>\s?/, ""))
    }
    out.push(
      `<div class="not-prose my-3 rounded-md border p-3 ${CALLOUT_TONES[type] ?? CALLOUT_TONES.note}">`,
      `<div class="mb-1 text-12-medium uppercase tracking-wide">${xmlEscape(title)}</div>`,
      "",
      body.join("\n"),
      "</div>",
    )
  }
  return out.join("\n")
}

function TodoMarkdown(props: { text: string; cacheKey?: string }) {
  return <Markdown text={normalizeTodoMarkdown(props.text)} cacheKey={props.cacheKey} />
}

const DEFAULT_TODO_AGENT_MODEL = "qgenie/anthropic::claude-4-6-sonnet"

type TodoBlock = {
  title: string
  markdown: string
  assignment?: string
  agentName?: string
  taskID?: string
  pendingComments: number
  checked: boolean
}

function MetaChip(props: { label: string; tone?: string; title?: string; spinning?: boolean }) {
  return (
    <span
      class={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] leading-none font-mono ${props.tone ?? "border-border-weaker-base bg-surface-raised-base text-text-weak"}`}
      title={props.title}
    >
      <Show when={props.spinning}>
        <span
          class="inline-block size-2 shrink-0 animate-spin rounded-full border border-current border-r-transparent"
          aria-hidden="true"
        />
      </Show>
      {props.label}
    </span>
  )
}

function mdxAttr(attrs: Record<string, string>, ...names: string[]) {
  for (const name of names) {
    const value = attrs[name]?.trim()
    if (value) return value
  }
}

function xmlEscape(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

function mdxTagBodies(source: string, name: string) {
  const re = new RegExp(String.raw`^\s*<\s*${name}\b([^>]*)>([\s\S]*?)^\s*<\s*\/\s*${name}\s*>`, "gm")
  return Array.from(source.matchAll(re)).map((match) => ({
    attrs: mdxAttrs(match[1] ?? ""),
    body: (match[2] ?? "").trim(),
    raw: match[0] ?? "",
    startOffset: match.index,
    endOffset: match.index === undefined ? undefined : match.index + (match[0]?.length ?? 0),
  }))
}

function mdxFirstTagBody(source: string, name: string) {
  return mdxTagBodies(source, name)[0]?.body
}

function parseTodoBlocks(source: string): TodoBlock[] {
  const lines = source.split(/\r?\n/)
  const blocks: TodoBlock[] = []
  const agentRe = /^\s*<\s*Agent\b([^>]*)>([\s\S]*?)^\s*<\s*\/\s*Agent\s*>/gm
  const allComments = mdxTagBodies(source, "Comment")
  for (const match of source.matchAll(agentRe)) {
    const attrs = mdxAttrs(match[1] ?? "")
    const body = match[2] ?? ""
    const id = mdxAttr(attrs, "id", "name", "agent")
    if (!id) continue
    const status = mdxAttr(attrs, "status")
    const relatedComments = allComments.filter((comment) => {
      const to = mdxAttr(comment.attrs, "to", "agent")
      return to === id
    })
    blocks.push({
      title: mdxAttr(attrs, "name") ?? id,
      markdown: [match[0] ?? body, ...relatedComments.map((comment) => comment.raw)].filter(Boolean).join("\n\n"),
      agentName: id,
      taskID: id,
      pendingComments: relatedComments.filter((comment) => !isClosedTodoStatus(comment.attrs.status)).length,
      checked: status === "done" || status === "completed",
    })
  }

  let i = 0
  const isTask = (line: string) => /^\s*[-*+]\s+\[[ xX~-]\]\s+/.test(line)
  const isHeading = (line: string) => /^##\s+/.test(line)
  const agentName = (assignment: string) => assignment.match(/^([A-Za-z][A-Za-z0-9_-]*)$/)?.[1]
  while (i < lines.length) {
    if (!isTask(lines[i] ?? "")) {
      i++
      continue
    }
    const start = i
    i++
    while (i < lines.length && !isTask(lines[i] ?? "") && !isHeading(lines[i] ?? "")) i++
    const blockLines = lines.slice(start, i)
    const markdown = blockLines.join("\n")
    const first = blockLines[0] ?? ""
    const title = first.replace(/^\s*[-*+]\s+\[[ xX~-]\]\s+/, "").trim()
    const assignment = markdown.match(/^\s*assign:\s*(.+)$/m)?.[1]?.trim()
    const taskID = markdown.match(/<\s*Task\b[^>]*\bid\s*=\s*["']([^"']+)["']/)?.[1]?.trim()
    blocks.push({
      title,
      markdown,
      assignment,
      agentName: assignment ? agentName(assignment) : undefined,
      taskID,
      pendingComments: blockLines.filter((line) => /^\s*comment>\s*$/.test(line)).length,
      checked: /^\s*[-*+]\s+\[[xX]\]/.test(first),
    })
  }
  return blocks
}

function systemsText(source: string) {
  return source.match(/^## Systems\s*\n([\s\S]*)$/m)?.[1]
}

type TodoMdxComponentTag = {
  name: string
  attrs: Record<string, string>
  raw: string
  body?: string
}

type TodoMdxPart = { kind: "markdown"; text: string } | { kind: "component"; tag: TodoMdxComponentTag }

const TODO_MDX_COMPONENTS = new Set([
  "Agent",
  "Comment",
  "Task",
  "TaskToggle",
  "AgentStatus",
  "OpenChat",
  "TodoPatch",
  "CommentBox",
  "LogLink",
  "Artifact",
  "AgentPanel",
])

function mdxAttrs(source: string) {
  const attrs: Record<string, string> = {}
  const re = /([A-Za-z_:][A-Za-z0-9_:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/g
  for (const match of source.matchAll(re)) {
    const key = match[1]
    if (!key) continue
    attrs[key] = (match[2] ?? match[3] ?? match[4] ?? "").trim()
  }
  return attrs
}

function parseTodoMdxComponentLine(line: string): TodoMdxComponentTag | undefined {
  const trimmed = line.trim()
  const match = trimmed.match(/^<\s*([A-Z][A-Za-z0-9]*)\b([^>]*)\/?\s*>$/)
  const name = match?.[1]
  if (!name || !TODO_MDX_COMPONENTS.has(name)) return undefined
  return { name, attrs: mdxAttrs(match[2] ?? ""), raw: trimmed }
}

function stripTodoMdxFrontmatter(source: string) {
  return source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
}

const TODO_MDX_BLOCK_COMPONENTS = new Set(["Agent", "Comment"])

function parseTodoMdxParts(source: string): TodoMdxPart[] {
  const parts: TodoMdxPart[] = []
  const markdown: string[] = []
  let inFence = false
  const lines = source.split(/\r?\n/)
  const flush = () => {
    if (markdown.length === 0) return
    parts.push({ kind: "markdown", text: markdown.join("\n") })
    markdown.length = 0
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ""
    if (/^\s*```/.test(line)) inFence = !inFence
    if (inFence) {
      markdown.push(line)
      continue
    }

    const maybeBlockName = line.trim().match(/^<\s*(Agent|Comment)\b/)?.[1]
    if (maybeBlockName) {
      const openLines = [line]
      let openEndLine = i
      while (!openLines.join("\n").includes(">") && openEndLine + 1 < lines.length) {
        openEndLine++
        openLines.push(lines[openEndLine] ?? "")
      }
      const openSource = openLines.join("\n").trim()
      const open = openSource.match(/^<\s*([A-Z][A-Za-z0-9]*)\b([\s\S]*?)>\s*$/)
      const name = open?.[1]
      if (name && TODO_MDX_BLOCK_COMPONENTS.has(name) && !openSource.endsWith("/>") && !openSource.startsWith("</")) {
        const body: string[] = []
        let foundClose = false
        for (let j = openEndLine + 1; j < lines.length; j++) {
          const next = lines[j] ?? ""
          if (new RegExp(`^\\s*<\\s*/\\s*${name}\\s*>\\s*$`).test(next)) {
            foundClose = true
            i = j
            break
          }
          body.push(next)
        }
        if (foundClose) {
          flush()
          parts.push({
            kind: "component",
            tag: { name, attrs: mdxAttrs(open[2] ?? ""), raw: openSource, body: body.join("\n") },
          })
          continue
        }
      }
    }

    const tag = parseTodoMdxComponentLine(line)
    if (tag) {
      flush()
      parts.push({ kind: "component", tag })
    } else {
      markdown.push(line)
    }
  }
  flush()
  return parts
}

function TodoMdxPreview(props: {
  source: string
  blocks: TodoBlock[]
  agents: SurfaceTodoAgent[]
  statuses: Record<string, { type: string }>
  runningAgents: Record<string, boolean>
  busy: boolean
  runBlock: (block: TodoBlock, options?: { openChat?: boolean }) => Promise<SurfaceTodoAgent | undefined>
  openChatForAgent: (agentName?: string) => void
  patch: (operations: Array<Record<string, unknown>>) => void | Promise<void>
}) {
  const parts = createMemo(() =>
    parseTodoMdxParts(stripTodoMdxFrontmatter(props.source || "_No todo file attached yet._")),
  )
  const [commentUi, setCommentUi] = createStore({
    open: {} as Record<string, boolean>,
    draft: {} as Record<string, string>,
  })
  const [agentCreate, setAgentCreate] = createStore({
    open: false,
    id: "",
    scope: "Systems",
    model: DEFAULT_TODO_AGENT_MODEL,
    prompt: "Refine the selected scope and handle queued comments.",
  })

  const agentState = (agentName?: string) => {
    if (!agentName) return "missing-agent"
    if (props.runningAgents[agentName]) return "running"
    const agent = agentSession(agentName)
    return agent ? (props.statuses[agent.sessionID]?.type ?? "pending") : "pending"
  }
  const blockForAgent = (agentName?: string) => props.blocks.find((block) => block.agentName === agentName)
  const agentSession = (agentName?: string) => props.agents.find((item) => item.name === agentName)
  const component = (tag: TodoMdxComponentTag) => {
    const agentName = tag.attrs.agent ?? tag.attrs.name
    const taskID = tag.attrs.task ?? tag.attrs.taskID ?? tag.attrs.id
    if (tag.name === "AgentStatus") {
      return (
        <MetaChip
          label={`@${agentName ?? "agent"} ${agentState(agentName)}`}
          tone={statusIconTone(agentState(agentName))}
        />
      )
    }
    if (tag.name === "OpenChat") {
      return (
        <button
          type="button"
          class="my-1 inline-flex items-center gap-1 rounded border border-border-weaker-base bg-surface-raised-base px-2 py-1 text-12-medium text-text-base hover:bg-surface-raised-base-hover"
          onClick={() => props.openChatForAgent(agentName)}
        >
          <Icon name="branch" size="small" />
          Open @{agentName ?? "agent"} chat
        </button>
      )
    }
    if (tag.name === "Task" || tag.name === "TaskToggle") {
      return (
        <button
          type="button"
          class="my-1 inline-flex items-center gap-1 rounded border border-border-weaker-base bg-surface-raised-base px-2 py-1 text-12-medium text-text-base hover:bg-surface-raised-base-hover disabled:opacity-50"
          disabled={props.busy || !taskID}
          onClick={() =>
            taskID && void props.patch([{ type: "set-task-checked", taskID, checked: tag.attrs.checked !== "true" }])
          }
        >
          <Icon name="check-small" size="small" />
          {tag.name === "Task" ? `Task ${taskID ?? "metadata"}` : `Toggle ${taskID ?? "task"}`}
        </button>
      )
    }
    if (tag.name === "CommentBox" || tag.name === "TodoPatch") {
      return <MetaChip label={`${tag.name}${taskID ? ` ${taskID}` : ""}`} />
    }
    if (tag.name === "LogLink" || tag.name === "Artifact") {
      return <MetaChip label={tag.attrs.label ?? tag.attrs.path ?? tag.attrs.source ?? tag.name} />
    }
    if (tag.name === "AgentPanel") {
      return <MetaChip label={`agents ${tag.attrs.agents ?? ""}`.trim()} />
    }
    return (
      <MetaChip
        label={`Unsupported ${tag.name}`}
        tone="border-border-critical-base bg-surface-critical-weak text-text-on-critical-base"
      />
    )
  }
  const mdxComponents = {
    Artifact: (componentProps: any) => (
      <MetaChip label={String(componentProps.label ?? componentProps.path ?? componentProps.url ?? "Artifact")} />
    ),
    AgentStatus: (componentProps: any) => {
      const agentName = componentProps.agent ? String(componentProps.agent) : undefined
      return (
        <MetaChip
          label={`@${agentName ?? "agent"} ${agentState(agentName)}`}
          tone={statusIconTone(agentState(agentName))}
        />
      )
    },
    OpenChat: (componentProps: any) => {
      const agentName = componentProps.agent ? String(componentProps.agent) : undefined
      const agent = agentSession(agentName)
      return (
        <button
          type="button"
          class="not-prose my-1 inline-flex items-center gap-1 rounded border border-border-weaker-base bg-surface-raised-base px-2 py-1 text-12-medium text-text-base hover:bg-surface-raised-base-hover disabled:opacity-50"
          disabled={!agent}
          onClick={() => props.openChatForAgent(agentName)}
        >
          <Icon name="branch" size="small" />
          Open @{agentName ?? "agent"} chat
        </button>
      )
    },
  }

  const mdxTree = createMemo(() => {
    const mdxSource = stripTodoMdxFrontmatter(props.source || "_No todo file attached yet._")
    try {
      return { source: mdxSource, tree: unified().use(remarkParse).use(remarkMdx).parse(mdxSource) as any }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  })

  const nodeSource = (node: any, source: string) => {
    const start = node?.position?.start?.offset
    const end = node?.position?.end?.offset
    return typeof start === "number" && typeof end === "number" ? source.slice(start, end) : ""
  }

  const mdxProps = (node: any) => {
    const attrs: Record<string, unknown> = {}
    for (const attr of node.attributes ?? []) {
      if (attr.type !== "mdxJsxAttribute" || !attr.name) continue
      if (attr.value === null || attr.value === undefined) attrs[attr.name] = true
      else if (typeof attr.value === "string") attrs[attr.name] = attr.value
      else if (typeof attr.value?.value === "string") attrs[attr.name] = attr.value.value
      else attrs[attr.name] = String(attr.value)
    }
    return attrs
  }

  const renderNodes = (nodes: any[] | undefined, source: string): any => (
    <For each={nodes ?? []}>{(node) => renderNode(node, source)}</For>
  )

  const childElements = (node: any, name?: string) =>
    (node.children ?? []).filter(
      (child: any) =>
        (child.type === "mdxJsxFlowElement" || child.type === "mdxJsxTextElement") && (!name || child.name === name),
    )

  const textFromNode = (node: any, source: string) => {
    const raw = nodeSource(node, source)
    const open = raw.indexOf(">")
    const close = raw.lastIndexOf("</")
    return open >= 0 && close > open ? raw.slice(open + 1, close).trim() : raw
  }

  const commentStatusTone = (status: string) => {
    if (["resolved", "done"].includes(status))
      return "border-border-success-base bg-surface-success-weak text-text-on-success-base"
    if (["running", "in-progress"].includes(status))
      return "border-border-warning-base bg-surface-warning-weak text-text-on-warning-base"
    if (["open", "pending"].includes(status))
      return "border-border-critical-base bg-surface-critical-weak text-text-on-critical-base"
    if (status === "info") return "border-border-weaker-base bg-surface-raised-base text-text-weak"
    return "border-border-critical-base bg-surface-critical-weak text-text-on-critical-base"
  }

  const commentsForAgent = (source: string, agentID?: string, agentName?: string) =>
    mdxTagBodies(source, "Comment").filter((comment) => {
      const to = mdxAttr(comment.attrs, "to", "agent")
      return !!to && (to === agentID || to === agentName)
    })

  const replaceNodeSource = (node: any, source: string, replacement: string) => {
    const start = node?.position?.start?.offset
    const end = node?.position?.end?.offset
    if (typeof start !== "number" || typeof end !== "number") return
    return `${source.slice(0, start)}${replacement}${source.slice(end)}`
  }

  const patchNodeOpenAttr = (node: any, source: string, attr: string, value: string) => {
    const raw = nodeSource(node, source)
    const openEnd = raw.indexOf(">")
    if (openEnd < 0) return
    const open = raw.slice(0, openEnd + 1)
    const escaped = xmlEscape(value)
    const nextOpen = new RegExp(`\\b${attr}\\s*=\\s*["'][^"']*["']`).test(open)
      ? open.replace(new RegExp(`\\b${attr}\\s*=\\s*["'][^"']*["']`), `${attr}="${escaped}"`)
      : open.replace(/\s*>$/, ` ${attr}="${escaped}">`)
    return replaceNodeSource(node, source, `${nextOpen}${raw.slice(openEnd + 1)}`)
  }

  const insertCommentBlock = (source: string, comment: string) => {
    const commentsHeading = /^## Comments\s*$/m.exec(source)
    if (!commentsHeading) return `${source.trimEnd()}\n\n## Comments\n\n${comment}\n`
    const insertAt = commentsHeading.index + commentsHeading[0].length
    return `${source.slice(0, insertAt)}\n\n${comment}${source.slice(insertAt).replace(/^\n*/, "\n")}`
  }

  const insertAgentBlock = (source: string, agentBlock: string) => {
    const agentsHeading = /^### Agents\s*$/m.exec(source)
    if (agentsHeading) {
      const insertAt = agentsHeading.index + agentsHeading[0].length
      return `${source.slice(0, insertAt)}\n\n${agentBlock}${source.slice(insertAt).replace(/^\n*/, "\n")}`
    }
    const tasksHeading = /^## Tasks\s*$/m.exec(source)
    if (tasksHeading) {
      const insertAt = tasksHeading.index + tasksHeading[0].length
      return `${source.slice(0, insertAt)}\n\n### Agents\n\n${agentBlock}${source.slice(insertAt).replace(/^\n*/, "\n")}`
    }
    return `${source.trimEnd()}\n\n## Tasks\n\n### Agents\n\n${agentBlock}\n`
  }

  const createAgentBlock = (source: string) => {
    const id = agentCreate.id.trim()
    if (!id) return
    const model = agentCreate.model.trim() || DEFAULT_TODO_AGENT_MODEL
    const scope = agentCreate.scope.trim() || "Systems"
    const prompt = agentCreate.prompt.trim() || `Handle ${scope}.`
    const block = `<Agent id="${xmlEscape(id)}" scope="${xmlEscape(scope)}" mode="auto" model="${xmlEscape(model)}" status="pending">
${prompt}
</Agent>`
    void props.patch([{ type: "replace-source", source: insertAgentBlock(source, block) }])
    setAgentCreate({
      open: false,
      id: "",
      scope: "Systems",
      model: DEFAULT_TODO_AGENT_MODEL,
      prompt: "Refine the selected scope and handle queued comments.",
    })
  }

  const newCommentBlock = (input: { to: string; target?: string; body: string; replyTo?: string }) => {
    const id = `c-${Date.now().toString(36)}`
    const attrs = [
      `id="${xmlEscape(id)}"`,
      `from="human"`,
      `to="${xmlEscape(input.to)}"`,
      input.target ? `target="${xmlEscape(input.target)}"` : undefined,
      input.replyTo ? `replyTo="${xmlEscape(input.replyTo)}"` : undefined,
      `status="pending"`,
      `created="${new Date().toISOString()}"`,
    ]
      .filter(Boolean)
      .join(" ")
    return `<Comment ${attrs}>\n${input.body.trim()}\n</Comment>`
  }

  const renderCommentCard = (input: {
    node?: any
    attrs: Record<string, string>
    body: string
    source: string
    startOffset?: number
    endOffset?: number
    raw?: string
  }) => {
    const status = input.attrs.status || "pending"
    const commentID = input.attrs.id
    const target = input.attrs.target
    const to = input.attrs.to || input.attrs.agent
    const from = input.attrs.from || "?"
    const created = metadataValue(input.attrs.created)
    const resolved = metadataValue(input.attrs.resolved ?? input.attrs.resolvedAt)
    const targetAgent = to ? props.blocks.find((block) => block.agentName === to) : undefined
    const targetRunning = !!to && !!props.runningAgents[to] && !isClosedTodoStatus(status)
    const displayStatus = targetRunning ? "running" : status
    const commentClosed = isClosedTodoStatus(status)
    const reply = () => {
      if (!to) return
      const body = globalThis.prompt?.("Reply comment")?.trim()
      if (!body) return
      const nextSource = insertCommentBlock(input.source, newCommentBlock({ to, target, body, replyTo: commentID }))
      void props.patch([{ type: "replace-source", source: nextSource }])
    }
    return (
      <section class="not-prose my-2 rounded-md border border-border-weaker-base bg-background-base p-2 text-text-base">
        <div class="mb-1 flex flex-wrap items-center gap-2">
          <strong class="text-12-medium text-text-strong">
            {from} → {to ?? "unassigned"}
          </strong>
          <MetaChip
            label={todoDisplayStatus(displayStatus)}
            tone={statusIconTone(displayStatus)}
            spinning={targetRunning}
          />
          <Show when={input.attrs.priority}>{(value) => <MetaChip label={`priority ${value()}`} />}</Show>
          <Show when={target}>{(value) => <MetaChip label={`target ${value()}`} />}</Show>
          <Show when={created}>{(value) => <MetaChip label={`created ${value()}`} title={input.attrs.created} />}</Show>
          <Show when={resolved}>
            {(value) => (
              <MetaChip label={`resolved ${value()}`} title={input.attrs.resolved ?? input.attrs.resolvedAt} />
            )}
          </Show>
          <Show when={commentID}>{(value) => <MetaChip label={value()} />}</Show>
        </div>
        <div class="prose prose-sm max-w-none text-text-base">
          <TodoMarkdown text={input.body} />
        </div>
        <div class="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            class="inline-flex min-h-7 items-center justify-center rounded-md border border-border-weaker-base bg-surface-raised-base px-3 py-1.5 text-12-medium text-text-base hover:bg-surface-raised-base-hover disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!to}
            onClick={reply}
          >
            Reply
          </button>
          <button
            type="button"
            class="inline-flex min-h-7 items-center justify-center rounded-md border border-border-info-base bg-surface-info-weak px-3 py-1.5 text-12-medium text-text-on-info-strong disabled:cursor-not-allowed disabled:opacity-50"
            disabled={props.busy || targetRunning || commentClosed || !targetAgent}
            title={
              commentClosed
                ? "Comment already done"
                : targetAgent
                  ? `Run @${to}`
                  : "Comment target is not an agent in this todo"
            }
            onClick={() => targetAgent && !commentClosed && void props.runBlock(targetAgent)}
          >
            <Show when={targetRunning} fallback={commentClosed ? "Done" : "Run target agent"}>
              <span class="inline-flex items-center gap-1">
                <span
                  class="inline-block size-3 animate-spin rounded-full border border-current border-r-transparent"
                  aria-hidden="true"
                />
                Working…
              </span>
            </Show>
          </button>
        </div>
      </section>
    )
  }

  const renderAgentNode = (node: any, source: string) => {
    const attrs = Object.fromEntries(Object.entries(mdxProps(node)).map(([key, value]) => [key, String(value)]))
    const id = mdxAttr(attrs, "id", "name", "agent") ?? "agent"
    const displayName = mdxAttr(attrs, "name") ?? id
    const agent = agentSession(id)
    const mode = mdxAttr(attrs, "mode") ?? "auto"
    const model =
      mdxAttr(attrs, "model", "modelID") ?? (agent ? `${agent.providerID}/${agent.modelID}` : DEFAULT_TODO_AGENT_MODEL)
    const scope = mdxAttr(attrs, "scope") ?? "document"
    const runtimeState = agentState(id)
    const statusAttr = mdxAttr(attrs, "status")
    const status = props.runningAgents[id] ? "running" : (statusAttr ?? runtimeState)
    const body = textFromNode(node, source)
    const relatedComments = commentsForAgent(source, id, displayName)
    const openCommentCount = relatedComments.filter((comment) => !isClosedTodoStatus(comment.attrs.status)).length
    const block =
      props.blocks.find((item) => item.agentName === id) ??
      ({
        title: displayName,
        markdown: nodeSource(node, source),
        agentName: id,
        taskID: id,
        pendingComments: openCommentCount,
        checked: false,
      } satisfies TodoBlock)
    const agentRunning = !!props.runningAgents[id]
    const canRunAgent = !props.busy && !agentRunning && (!agent || openCommentCount > 0)
    const runLabel = agentRunning
      ? "Working…"
      : !agent
        ? mode === "fork"
          ? "Fork agent"
          : "Create agent"
        : openCommentCount > 0
          ? `Run ${openCommentCount} comment${openCommentCount === 1 ? "" : "s"}`
          : "Add comment to continue"
    const runTitle = !agent
      ? `Create @${id}`
      : openCommentCount > 0
        ? `Run @${id} on pending comments`
        : "This agent already exists; use comments for follow-up work or open chat."
    const updateAgentAttr = (attr: string, value: string) => {
      const nextSource = patchNodeOpenAttr(node, source, attr, value)
      if (nextSource) void props.patch([{ type: "replace-source", source: nextSource }])
    }
    const addComment = () => setCommentUi("open", id, (value) => !value)
    const queueComment = () => {
      const body = commentUi.draft[id]?.trim()
      if (!body) return
      const nextSource = insertCommentBlock(source, newCommentBlock({ to: id, target: scope, body }))
      setCommentUi("draft", id, "")
      setCommentUi("open", id, false)
      void props.patch([{ type: "replace-source", source: nextSource }])
    }
    return (
      <section class="not-prose my-4 rounded-lg border border-border-weaker-base bg-background-base p-3 text-text-base shadow-xs">
        <div class="mb-2 flex flex-wrap items-center gap-2">
          <h4 class="min-w-0 flex-1 text-14-medium text-text-strong">Agent @{displayName}</h4>
          <MetaChip
            label={todoDisplayStatus(status)}
            tone={statusIconTone(status)}
            spinning={isRunningTodoStatus(status)}
          />
          <MetaChip label={`id ${id}`} />
          <MetaChip label={`scope ${scope}`} title={scope} />
          <MetaChip label={`mode ${mode}`} />
          <MetaChip label={`model ${model}`} title={model} />
          <Show when={agent} fallback={<MetaChip label="no session" />}>
            {(session) => <MetaChip label={`session ${compactID(session().sessionID)}`} title={session().sessionID} />}
          </Show>
          <MetaChip label={`${openCommentCount} open comments`} />
        </div>
        <div class="mb-3 rounded-md border border-border-weaker-base bg-surface-base p-2">
          <TodoMarkdown text={body} />
        </div>
        <Show when={relatedComments.length > 0}>
          <div class="mb-3 flex flex-col gap-2">
            <For each={relatedComments}>
              {(comment) =>
                renderCommentCard({
                  attrs: comment.attrs,
                  body: comment.body,
                  source,
                  raw: comment.raw,
                  startOffset: comment.startOffset,
                  endOffset: comment.endOffset,
                })
              }
            </For>
          </div>
        </Show>
        <Show when={commentUi.open[id]}>
          <div class="mb-3 rounded-md border border-border-warning-base bg-surface-warning-weak p-2">
            <div class="mb-2 flex items-center justify-between gap-2">
              <div class="text-12-medium text-text-on-warning-base">Queue comment to @{id}</div>
              <MetaChip label={`target ${scope}`} />
            </div>
            <textarea
              class="min-h-20 w-full resize-y rounded-md border border-border-weaker-base bg-background-base px-2 py-1.5 text-12-regular text-text-base outline-none focus:border-border-info-base"
              placeholder={`Message for ${id}`}
              value={commentUi.draft[id] ?? ""}
              onInput={(event) => setCommentUi("draft", id, event.currentTarget.value)}
            />
            <div class="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                class="inline-flex min-h-7 items-center justify-center rounded-md border border-border-warning-base bg-background-base px-3 py-1.5 text-12-medium text-text-on-warning-base disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!commentUi.draft[id]?.trim()}
                onClick={queueComment}
              >
                Queue to @{id}
              </button>
              <button
                type="button"
                class="inline-flex min-h-7 items-center justify-center rounded-md border border-border-weaker-base bg-surface-raised-base px-3 py-1.5 text-12-medium text-text-base hover:bg-surface-raised-base-hover"
                onClick={() => setCommentUi("open", id, false)}
              >
                Cancel
              </button>
            </div>
          </div>
        </Show>
        <div class="flex flex-wrap items-center gap-2">
          <button
            type="button"
            class="inline-flex min-h-7 items-center justify-center rounded-md border border-border-info-base bg-surface-info-weak px-3 py-1.5 text-12-medium text-text-on-info-strong shadow-xs hover:bg-surface-info-base/20 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!canRunAgent}
            title={runTitle}
            onClick={() => canRunAgent && void props.runBlock(block)}
          >
            <Show when={agentRunning} fallback={runLabel}>
              <span class="inline-flex items-center gap-1">
                <span
                  class="inline-block size-3 animate-spin rounded-full border border-current border-r-transparent"
                  aria-hidden="true"
                />
                Working…
              </span>
            </Show>
          </button>
          <button
            type="button"
            class="inline-flex min-h-7 items-center justify-center rounded-md border border-border-info-base bg-surface-info-weak px-3 py-1.5 text-12-medium text-text-on-info-strong shadow-xs hover:bg-surface-info-base/20 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!canRunAgent}
            title={runTitle}
            onClick={() => canRunAgent && void props.runBlock(block, { openChat: true })}
          >
            {agent ? "Run comments & open chat" : "Create & open chat"}
          </button>
          <button
            type="button"
            class="inline-flex min-h-7 items-center justify-center rounded-md border border-border-weaker-base bg-surface-raised-base px-3 py-1.5 text-12-medium text-text-base hover:bg-surface-raised-base-hover disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!agent}
            title={agent ? `Open ${id} chat` : `Run ${id} first to create a chat session`}
            onClick={() => props.openChatForAgent(id)}
          >
            Open chat
          </button>
          <button
            type="button"
            class="inline-flex min-h-7 items-center justify-center rounded-md border border-border-weaker-base bg-surface-raised-base px-3 py-1.5 text-12-medium text-text-base hover:bg-surface-raised-base-hover"
            onClick={addComment}
          >
            Add comment
          </button>
        </div>
        <details class="mt-3 rounded-md border border-border-weaker-base bg-surface-base p-2">
          <summary class="cursor-pointer text-12-medium text-text-weak">Advanced MDX props</summary>
          <div class="mt-2 grid gap-2 md:grid-cols-2">
            <label class="inline-flex flex-col gap-1 text-11-mono text-text-weak">
              mode
              <select
                class="rounded border border-border-weaker-base bg-background-base px-1 py-0.5 text-11-mono text-text-base"
                value={mode}
                onChange={(event) => updateAgentAttr("mode", event.currentTarget.value)}
              >
                <option value="auto">auto</option>
                <option value="fork">fork</option>
                <option value="new">new</option>
              </select>
            </label>
            <label class="inline-flex flex-col gap-1 text-11-mono text-text-weak">
              model
              <input
                class="rounded border border-border-weaker-base bg-background-base px-1.5 py-0.5 text-11-mono text-text-base"
                value={model}
                onChange={(event) =>
                  updateAgentAttr("model", event.currentTarget.value.trim() || DEFAULT_TODO_AGENT_MODEL)
                }
              />
            </label>
            <div class="md:col-span-2 text-11-regular text-text-weak">
              Status is read-only in the main card. Backend run state or an agent/backend MDX patch should move this
              agent between pending, running, and done.
            </div>
          </div>
        </details>
      </section>
    )
  }

  const headingPlainText = (node: any): string =>
    (node.children ?? [])
      .map((child: any) => {
        if (typeof child.value === "string") return child.value
        if (child.children) return headingPlainText(child)
        return ""
      })
      .join("")
      .trim()

  const headingSlug = (text: string) =>
    text
      .toLowerCase()
      .replace(/<[^>]+>/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "section"

  const indexItems = (tree: any) => {
    const items: Array<{ depth: number; text: string; slug: string }> = []
    const visit = (node: any) => {
      if (!node) return
      if (node.type === "heading" && node.depth >= 2 && node.depth <= 3) {
        const text = headingPlainText(node)
        if (text && text.toLowerCase() !== "index") items.push({ depth: node.depth, text, slug: headingSlug(text) })
      }
      for (const child of node.children ?? []) visit(child)
    }
    visit(tree)
    return items
  }

  const renderGeneratedIndex = (tree: any) => (
    <nav class="not-prose my-3 rounded-md border border-border-weaker-base bg-surface-base p-3">
      <div class="mb-2 text-12-medium text-text-strong">Generated index</div>
      <div class="flex flex-col gap-1 text-12-regular">
        <For each={indexItems(tree)}>
          {(item) => (
            <a
              class={
                item.depth === 3 ? "pl-4 text-text-weak hover:text-text-base" : "text-text-base hover:text-text-strong"
              }
              href={`#${item.slug}`}
            >
              {item.depth === 3 ? "↳ " : ""}
              {item.text}
            </a>
          )}
        </For>
      </div>
    </nav>
  )

  const renderTrustedPreview = (name: string, attrs: Record<string, unknown>) => {
    if (name === "StateMachineViewer") {
      return (
        <section class="not-prose my-3 rounded-lg border border-border-info-base bg-surface-info-weak p-3">
          <div class="mb-2 flex flex-wrap items-center gap-2">
            <h4 class="min-w-0 flex-1 text-13-medium text-text-on-info-strong">StateMachineViewer</h4>
            <MetaChip label={`spec ${String(attrs.spec ?? "inline")}`} />
            <MetaChip label="trusted preview" />
          </div>
          <div class="flex flex-wrap items-center gap-2 text-12-regular text-text-base">
            <span class="rounded border border-border-weaker-base bg-background-base px-2 py-1">idle</span>
            <span>→</span>
            <span class="rounded border border-border-weaker-base bg-background-base px-2 py-1">running</span>
            <span>→</span>
            <span class="rounded border border-border-weaker-base bg-background-base px-2 py-1">done</span>
            <span>/</span>
            <span class="rounded border border-border-weaker-base bg-background-base px-2 py-1">failed</span>
          </div>
        </section>
      )
    }
    if (name === "ApiContractCheck") {
      return (
        <section class="not-prose my-3 rounded-lg border border-border-info-base bg-surface-info-weak p-3">
          <div class="mb-2 flex flex-wrap items-center gap-2">
            <h4 class="min-w-0 flex-1 text-13-medium text-text-on-info-strong">ApiContractCheck</h4>
            <MetaChip label={String(attrs.route ?? "route")} />
            <MetaChip label="trusted preview" />
          </div>
          <div class="flex flex-wrap items-center gap-2 text-12-regular text-text-base">
            <span class="rounded border border-border-weaker-base bg-background-base px-2 py-1">schema</span>
            <span>✓</span>
            <span class="rounded border border-border-weaker-base bg-background-base px-2 py-1">request</span>
            <span>✓</span>
            <span class="rounded border border-border-weaker-base bg-background-base px-2 py-1">response</span>
          </div>
        </section>
      )
    }
    return undefined
  }

  const renderAgentCreationMenu = (source: string) => (
    <div class="not-prose my-3 rounded-lg border border-border-weaker-base bg-surface-base p-3">
      <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div class="text-13-medium text-text-strong">Agent creation menu</div>
          <div class="text-11-regular text-text-weak">Create a delegated agent with explicit id, scope, and model.</div>
        </div>
        <button
          type="button"
          class="inline-flex min-h-7 items-center justify-center rounded-md border border-border-info-base bg-surface-info-weak px-3 py-1.5 text-12-medium text-text-on-info-strong hover:bg-surface-info-base/20"
          onClick={() => setAgentCreate("open", (value) => !value)}
        >
          {agentCreate.open ? "Close" : "New agent"}
        </button>
      </div>
      <Show when={agentCreate.open}>
        <div class="grid gap-2 md:grid-cols-2">
          <label class="flex flex-col gap-1 text-11-mono text-text-weak">
            agent id
            <input
              class="rounded border border-border-weaker-base bg-background-base px-2 py-1 text-12-regular text-text-base"
              value={agentCreate.id}
              placeholder="systems-agent"
              onInput={(event) => setAgentCreate("id", event.currentTarget.value)}
            />
          </label>
          <label class="flex flex-col gap-1 text-11-mono text-text-weak">
            scope
            <input
              class="rounded border border-border-weaker-base bg-background-base px-2 py-1 text-12-regular text-text-base"
              value={agentCreate.scope}
              onInput={(event) => setAgentCreate("scope", event.currentTarget.value)}
            />
          </label>
          <label class="md:col-span-2 flex flex-col gap-1 text-11-mono text-text-weak">
            model
            <input
              class="rounded border border-border-weaker-base bg-background-base px-2 py-1 text-12-regular text-text-base"
              value={agentCreate.model}
              onInput={(event) => setAgentCreate("model", event.currentTarget.value)}
            />
          </label>
          <label class="md:col-span-2 flex flex-col gap-1 text-11-mono text-text-weak">
            first prompt
            <textarea
              class="min-h-20 resize-y rounded border border-border-weaker-base bg-background-base px-2 py-1 text-12-regular text-text-base"
              value={agentCreate.prompt}
              onInput={(event) => setAgentCreate("prompt", event.currentTarget.value)}
            />
          </label>
          <div class="md:col-span-2 flex flex-wrap gap-2">
            <button
              type="button"
              class="inline-flex min-h-7 items-center justify-center rounded-md border border-border-info-base bg-surface-info-weak px-3 py-1.5 text-12-medium text-text-on-info-strong disabled:opacity-50"
              disabled={!agentCreate.id.trim()}
              onClick={() => createAgentBlock(source)}
            >
              Create agent
            </button>
            <button
              type="button"
              class="inline-flex min-h-7 items-center justify-center rounded-md border border-border-weaker-base bg-surface-raised-base px-3 py-1.5 text-12-medium text-text-base hover:bg-surface-raised-base-hover"
              onClick={() => setAgentCreate("open", false)}
            >
              Cancel
            </button>
          </div>
        </div>
      </Show>
    </div>
  )

  const renderNode = (node: any, source: string): any => {
    if (!node) return undefined
    if (node.type === "root") return renderNodes(node.children, source)
    if (node.type === "mdxjsEsm") {
      const raw = nodeSource(node, source)
      return raw.trim() ? (
        <div class="not-prose my-2 rounded border border-border-weaker-base bg-surface-raised-base px-2 py-1 text-11-mono text-text-weak">
          {raw.trim()}
        </div>
      ) : undefined
    }
    if (node.type === "heading" && node.depth === 2 && headingPlainText(node).toLowerCase() === "index") {
      return (
        <>
          <TodoMarkdown text={nodeSource(node, source)} />
          {renderGeneratedIndex(mdxTree().tree)}
        </>
      )
    }
    if (node.type === "heading" && node.depth === 3 && headingPlainText(node).toLowerCase() === "agents") {
      return (
        <>
          <TodoMarkdown text={nodeSource(node, source)} />
          {renderAgentCreationMenu(source)}
        </>
      )
    }
    if (node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement") {
      if (node.name === "Agent") return renderAgentNode(node, source)
      if (node.name === "Comment") {
        const attrs = Object.fromEntries(Object.entries(mdxProps(node)).map(([key, value]) => [key, String(value)]))
        return renderCommentCard({ node, attrs, body: textFromNode(node, source), source })
      }
      if (node.name === "svg") return <TodoMarkdown text={`\`\`\`svg\n${nodeSource(node, source)}\n\`\`\``} />
      const preview = renderTrustedPreview(String(node.name), mdxProps(node))
      if (preview) return preview
      const name = node.name as keyof typeof mdxComponents
      const Component = mdxComponents[name]
      if (!Component) {
        return (
          <div class="not-prose rounded-md border border-border-weaker-base bg-surface-raised-base p-2 text-12-regular text-text-weak">
            Trusted MDX component preview unavailable: {String(node.name)}
          </div>
        )
      }
      return <Component {...mdxProps(node)}>{renderNodes(node.children, source)}</Component>
    }
    const raw = nodeSource(node, source)
    if (raw.trim()) return <TodoMarkdown text={raw} />
    return undefined
  }

  return (
    <Switch>
      <Match when={mdxTree().error}>
        <div class="rounded-md border border-border-critical-base bg-surface-critical-weak p-3 text-12-regular text-text-on-critical-base">
          <div class="mb-1 text-12-medium">Todo MDX render error</div>
          <pre class="whitespace-pre-wrap text-11-mono">{mdxTree().error}</pre>
        </div>
      </Match>
      <Match when={mdxTree().tree}>
        <div class="prose prose-sm max-w-none text-text-base">{renderNode(mdxTree().tree, mdxTree().source ?? "")}</div>
      </Match>
    </Switch>
  )
}

export function SurfaceTasksTab(props: { sessionID?: string }) {
  const bridge = useSurfaceSessionBridge()
  const { tabs, view } = useSessionLayout()
  const [state, setState] = createStore({
    refresh: 0,
    busy: false,
    error: undefined as string | undefined,
    editing: false,
    draft: "",
    runningAgents: {} as Record<string, boolean>,
  })

  const debugTodo = (
    message: string,
    extra?: Record<string, unknown>,
    level: "debug" | "info" | "warn" | "error" = "info",
  ) => {
    console.log(`[web.todo] ${message}`, extra ?? {})
    emitDiagnosticLog({
      service: "web.todo",
      level,
      message,
      extra: { sessionID: props.sessionID, refresh: state.refresh, ...(extra ?? {}) },
    })
  }
  const [snapshot, actions] = createResource(
    () => (props.sessionID ? `${props.sessionID}:${state.refresh}` : undefined),
    async () => {
      debugTodo("snapshot.fetch.start")
      const result = await bridge.getTodoSnapshot(props.sessionID!, { force: state.refresh > 0 })
      debugTodo("snapshot.fetch.done", {
        taskPath: result.taskPath,
        todos: result.todos.length,
        tree: result.tree?.length ?? 0,
        sourceChars: result.source?.length ?? 0,
        status: result.status,
      })
      return result
    },
  )
  const [agents, agentActions] = createResource(
    () => (props.sessionID ? `${props.sessionID}:${state.refresh}` : undefined),
    async () => {
      const result = (await bridge.listTodoAgents(props.sessionID!)).agents
      debugTodo("agents.fetch.done", { count: result.length, agents: result.map((agent) => agent.name) })
      return result
    },
  )
  const [statuses, statusActions] = createResource(
    () => state.refresh,
    async () => {
      try {
        const result = await bridge.getSessionStatuses()
        debugTodo("statuses.fetch.done", { count: Object.keys(result).length })
        return result
      } catch (error) {
        debugTodo("statuses.fetch.error", { error: diagnosticError(error) }, "error")
        return {} as Record<string, { type: string }>
      }
    },
  )

  createEffect(() => {
    const stop = bridge.onTodoSnapshot?.((event) => {
      if (event.sessionID === props.sessionID) {
        debugTodo("snapshot.event", { taskPath: event.snapshot.taskPath, status: event.snapshot.status })
        void actions.refetch()
      }
    })
    if (stop) onCleanup(stop)
  })

  const source = createMemo(() => snapshot()?.source ?? "")
  const blocks = createMemo(() => parseTodoBlocks(source()))
  const defaultTodoSource = (title: string) => `# ${title}

## Index

Generated by the Todo UI from headings.

## Systems

### Goal / Intent

Define the systems context for ${title} before implementation.

### Contract / Specification

Todo MDX has two built-in UI cards:

- \`<Agent>\` defines an agent assignment. Its status is displayed as a read-only badge; backend run state or an agent/backend MDX patch owns status changes.
- \`<Comment>\` queues a message to an agent. It starts as \`pending\`; the target agent/backend moves it through \`running\` to \`done\` after handling.

Normal users run agents, open chat, and add/reply to comments. Manual status edits belong in advanced/admin workflows, not the card UI.

### Components and files

### What needs to change

### Open questions

## Tasks

### Agents

<Agent id="systems-agent" scope="Systems" mode="auto" provider="qgenie" model="anthropic::claude-4-6-sonnet" status="pending">
Refine ## Systems until implementation is unblocked.
</Agent>

### Todos

- [ ] Refine \`## Systems\` until the task is fully understood.

## Comments
`

  const mdxSummary = createMemo(() => {
    const list = blocks()
    if (list.length === 0) return "No MDX tasks"
    const done = list.filter((block) => block.checked).length
    const interactive = list.filter((block) => block.agentName).length
    return `${done}/${list.length} checked · ${interactive} agent task${interactive === 1 ? "" : "s"}`
  })

  const refresh = () => {
    setState("refresh", (x) => x + 1)
    void actions.refetch()
    void agentActions.refetch()
    void statusActions.refetch()
  }

  const patch = async (operations: Array<Record<string, unknown>>) => {
    if (!props.sessionID) return
    if (!snapshot()?.taskPath) {
      const replace = operations.find((op) => op.type === "replace-source") as { source?: string } | undefined
      const title = replace?.source?.match(/^#\s+(.+)$/m)?.[1]?.trim() || "New Todo"
      await createTodoFile(title)
    }
    setState("busy", true)
    setState("error", undefined)
    debugTodo("patch.start", { operations: operations.map((op) => op.type), baseHash: snapshot()?.hash })
    try {
      await bridge.patchTodoFile(props.sessionID, { baseHash: snapshot()?.hash, operations })
      debugTodo("patch.done")
      refresh()
    } catch (error) {
      debugTodo("patch.error", { error: diagnosticError(error) }, "error")
      setState("error", error instanceof Error ? error.message : String(error))
      return undefined
    } finally {
      setState("busy", false)
    }
  }

  const createTodoFile = async (titleInput?: string) => {
    if (!props.sessionID) return
    const title = titleInput?.trim() || globalThis.prompt?.("Todo title", "New Todo")?.trim()
    if (!title) return
    setState("busy", true)
    setState("error", undefined)
    try {
      const created = await bridge.createTodoFile(props.sessionID, {
        title,
        slug: title,
        project: "opencode",
        body: `Define the systems context for ${title} before implementation.`,
      })
      const source = defaultTodoSource(title)
      await bridge.patchTodoFile(props.sessionID, {
        baseHash: created.hash,
        operations: [{ type: "replace-source", source }],
      })
      setState("draft", source)
      refresh()
    } catch (error) {
      debugTodo("create.error", { error: diagnosticError(error) }, "error")
      setState("error", error instanceof Error ? error.message : String(error))
      return undefined
    } finally {
      setState("busy", false)
    }
  }

  const attachTodoFile = async () => {
    if (!props.sessionID) return
    const path = globalThis.prompt?.("Todo path to attach", "scratchpad/task/opencode/active/todo-")?.trim()
    if (!path) return
    setState("busy", true)
    setState("error", undefined)
    try {
      await bridge.attachTodoFile(props.sessionID, path)
      refresh()
    } catch (error) {
      debugTodo("attach.error", { path, error: diagnosticError(error) }, "error")
      setState("error", error instanceof Error ? error.message : String(error))
      return undefined
    } finally {
      setState("busy", false)
    }
  }

  const saveDraft = async () => {
    if (snapshot()?.taskPath) return patch([{ type: "replace-source", source: state.draft }])
    const title = state.draft.match(/^#\s+(.+)$/m)?.[1]?.trim() || "New Todo"
    await createTodoFile(title)
    if (state.draft.trim()) await patch([{ type: "replace-source", source: state.draft }])
  }

  const openChatForSession = (agent: SurfaceTodoAgent) => {
    const tab = `chat://session/${encodeURIComponent(agent.sessionID)}`
    if (!view().reviewPanel.opened()) view().reviewPanel.open()
    void tabs()
      .open(tab)
      .then(() => tabs().setActive(tab))
    debugTodo("open_chat.tab", { agent: agent.name, agentSessionID: agent.sessionID, tab })
  }

  const runBlock = async (block: TodoBlock, options?: { openChat?: boolean }) => {
    if (!props.sessionID) return
    setState("busy", true)
    setState("error", undefined)
    if (block.agentName) setState("runningAgents", block.agentName, true)
    const followUp = block.pendingComments > 0
    debugTodo("run_task.start", {
      title: block.title,
      agent: block.agentName,
      followUp,
      markdownChars: block.markdown.length,
    })
    try {
      // Keep the Web UI responsive: dispatch todo-agent runs asynchronously.
      // The running badge/spinner stays active while the backend session is expected
      // to process and patch handled comments.
      const result = await bridge.runTodoAgentTask(props.sessionID, {
        taskMarkdown: block.markdown,
        systemsText: systemsText(source()),
        mode: followUp ? "follow-up" : "initial",
        async: true,
      })
      debugTodo("run_task.accepted", {
        title: block.title,
        agent: result.agent?.name ?? block.agentName,
        agentSessionID: result.agent?.sessionID,
        accepted: result.accepted,
      })
      refresh()
      if (options?.openChat && result.agent) openChatForSession(result.agent)
      if (block.agentName) window.setTimeout(() => setState("runningAgents", block.agentName!, false), 60_000)
      return result.agent
    } catch (error) {
      debugTodo(
        "run_task.error",
        { title: block.title, agent: block.agentName, error: diagnosticError(error) },
        "error",
      )
      setState("error", error instanceof Error ? error.message : String(error))
      if (block.agentName) setState("runningAgents", block.agentName, false)
      return undefined
    } finally {
      setState("busy", false)
    }
  }

  const openChatForAgent = (agentName?: string) => {
    const agent = agentName ? agents()?.find((item) => item.name === agentName) : undefined
    if (!agent) {
      setState("error", "No agent session yet; run this Agent first.")
      return
    }
    openChatForSession(agent)
  }

  return (
    <div class="h-full min-h-0 w-full overflow-y-auto bg-background-base">
      <div class="flex min-h-full w-full max-w-none flex-col gap-5 p-5">
        <header class="border-b border-border-weaker-base pb-3">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <h2 class="flex items-center gap-2 text-18-medium text-text-strong">
                <Icon name="branch" size="small" />
                Todo MDX
              </h2>
              <p class="mt-1 text-12-regular text-text-weak">Interactive MDX agent workspace.</p>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <button
                type="button"
                class="rounded-md border border-border-info-base bg-surface-info-weak px-2 py-1 text-12-medium text-text-on-info-strong disabled:opacity-50"
                disabled={state.busy}
                onClick={() => void createTodoFile()}
              >
                Create todo
              </button>
              <button
                type="button"
                class="rounded-md border border-border-weaker-base bg-surface-raised-base px-2 py-1 text-12-medium text-text-base hover:bg-surface-raised-base-hover disabled:opacity-50"
                disabled={state.busy}
                onClick={() => void attachTodoFile()}
              >
                Attach todo
              </button>
              <button
                type="button"
                class="rounded-md border border-border-weaker-base bg-surface-raised-base px-2 py-1 text-12-medium text-text-base hover:bg-surface-raised-base-hover"
                onClick={refresh}
              >
                Refresh
              </button>
            </div>
          </div>
        </header>

        <Show when={state.error}>
          {(error) => (
            <div class="rounded-md border border-border-critical-base bg-surface-critical-weak p-2 text-12-regular text-text-on-critical-base">
              {error()}
            </div>
          )}
        </Show>

        <Switch>
          <Match when={snapshot.loading}>
            <div class="text-12-regular text-text-weak">Loading Todo MDX...</div>
          </Match>
          <Match when={snapshot.error}>
            <div class="rounded-md border border-border-critical-base bg-surface-critical-weak p-3 text-12-regular text-text-on-critical-base">
              {String(snapshot.error)}
            </div>
          </Match>
          <Match when={snapshot()} keyed>
            {(data) => (
              <>
                <div class="flex flex-wrap items-center gap-2 text-11-mono text-text-weak">
                  <Show when={data.taskPath}>{(note) => <span class="truncate">{note()}</span>}</Show>
                  <span class="rounded border border-border-weaker-base bg-surface-raised-base px-1.5 py-0.5">
                    {mdxSummary()}
                  </span>
                  <Show when={data.hash}>
                    {(hash) => (
                      <span class="rounded border border-border-weaker-base bg-surface-raised-base px-1.5 py-0.5">
                        {hash().slice(0, 8)}
                      </span>
                    )}
                  </Show>
                </div>

                <section class="rounded-lg border border-border-weaker-base bg-background-base p-3 shadow-xs">
                  <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 class="flex items-center gap-2 text-13-medium text-text-strong">
                        <Icon name="pencil-line" size="small" />
                        Todo MDX
                      </h3>
                      <p class="mt-1 text-12-regular text-text-weak">
                        One source file. Edit raw MDX or preview interactive task controls.
                      </p>
                    </div>
                    <div class="flex flex-wrap gap-2">
                      <button
                        type="button"
                        class="rounded border px-2 py-1 text-12-medium"
                        classList={{
                          "border-border-info-base bg-surface-info-weak text-text-on-info-strong": !state.editing,
                          "border-border-weaker-base bg-surface-raised-base text-text-base": state.editing,
                        }}
                        onClick={() => setState("editing", false)}
                      >
                        Preview
                      </button>
                      <button
                        type="button"
                        class="rounded border px-2 py-1 text-12-medium"
                        classList={{
                          "border-border-info-base bg-surface-info-weak text-text-on-info-strong": state.editing,
                          "border-border-weaker-base bg-surface-raised-base text-text-base": !state.editing,
                        }}
                        onClick={() => {
                          setState("draft", source() || defaultTodoSource("New Todo"))
                          setState("editing", true)
                        }}
                      >
                        Edit
                      </button>
                      <Show when={state.editing}>
                        <button
                          type="button"
                          class="rounded border border-border-weaker-base bg-surface-raised-base px-2 py-1 text-12-medium text-text-base disabled:opacity-50"
                          disabled={state.busy}
                          onClick={() => void saveDraft()}
                        >
                          Save
                        </button>
                      </Show>
                    </div>
                  </div>
                  <Show
                    when={state.editing}
                    fallback={
                      <TodoMdxPreview
                        source={source()}
                        blocks={blocks()}
                        agents={agents() ?? []}
                        statuses={statuses() ?? {}}
                        runningAgents={state.runningAgents}
                        busy={state.busy}
                        runBlock={runBlock}
                        openChatForAgent={openChatForAgent}
                        patch={patch}
                      />
                    }
                  >
                    <textarea
                      class="min-h-[560px] w-full resize-y rounded-md border border-border-base bg-surface-base p-3 font-mono text-12-regular text-text-base outline-none"
                      value={state.draft}
                      disabled={state.busy}
                      onInput={(event) => setState("draft", event.currentTarget.value)}
                    />
                  </Show>
                </section>
              </>
            )}
          </Match>
        </Switch>
      </div>
    </div>
  )
}
