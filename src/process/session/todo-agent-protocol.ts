import { EMBEDDED_AGENT_PROMPTS } from "@/agent/agent-prompts.gen"

export type TodoAgentAssignment =
  | {
      kind: "create-or-reuse"
      raw: string
      agentName: string
      providerID: string
      modelID: string
    }
  | {
      kind: "fork"
      raw: string
      sourceAgentName: string
      targetAgentName: string
      providerID: string
      modelID: string
    }

export type TodoAgentComment = {
  status: "pending" | "resolved"
  text: string
  startOffset: number
  endOffset: number
  markerStartOffset: number
  markerEndOffset: number
}

export type TodoAgentResponse = {
  text: string
  startOffset: number
  endOffset: number
}

export type TodoAgentTask = {
  title: string
  checked: boolean
  startOffset: number
  endOffset: number
  assignment?: TodoAgentAssignment
  promptText?: string
  promptStartOffset?: number
  promptEndOffset?: number
  conversationText?: string
  conversationStartOffset?: number
  conversationEndOffset?: number
  comments: TodoAgentComment[]
  responses: TodoAgentResponse[]
  diagnostics: string[]
}

export type TodoAgentParseResult = {
  tasks: TodoAgentTask[]
  diagnostics: string[]
}

const TASK_RE = /^(\s*)- \[([ xX])\]\s*(.*)$/
const AGENT_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/

function lineStarts(input: string) {
  const starts: number[] = []
  let offset = 0
  for (const line of input.split(/(?<=\n)/)) {
    starts.push(offset)
    offset += line.length
  }
  if (input.length === 0) starts.push(0)
  return starts
}

function stripTrailingNewline(line: string) {
  return line.replace(/\r?\n$/, "")
}

function trimBlock(text: string) {
  const withoutOuterBlank = text.replace(/^(?:[ \t]*\r?\n)+/, "").replace(/(?:\r?\n[ \t]*)+$/, "")
  const lines = withoutOuterBlank.split(/\r?\n/)
  const indents = lines.filter((line) => line.trim().length > 0).map((line) => line.match(/^[ \t]*/)?.[0].length ?? 0)
  const common = indents.length ? Math.min(...indents) : 0
  return lines.map((line) => line.slice(Math.min(common, line.length))).join("\n")
}

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

function mdxAttr(attrs: Record<string, string>, ...names: string[]) {
  for (const name of names) {
    const value = attrs[name]?.trim()
    if (value) return value
  }
}

function splitProviderModelAttr(model: string | undefined, component: string, provider?: string) {
  const value = model?.trim()
  const explicitProvider = provider?.trim()
  if (!value) return { ok: false as const, error: `${component} requires provider and model` }

  if (!explicitProvider) return { ok: false as const, error: `${component} requires provider=...` }
  if (value.includes("/")) return { ok: false as const, error: `${component} model must be upstream::model` }
  if (!value.includes("::")) return { ok: false as const, error: `${component} model must be upstream::model` }
  return { ok: true as const, providerID: explicitProvider, modelID: value }
}

function todoAgentAssignmentFromMdxAttrs(attrs: Record<string, string>, component: string) {
  const agent = component === "Agent" ? mdxAttr(attrs, "id", "agent", "name") : mdxAttr(attrs, "agent", "name", "id")
  const sourceAgent = mdxAttr(attrs, "from", "forkFrom", "sourceAgent")
  if (!agent) return { ok: false as const, error: `${component} requires id/name/agent` }
  const nameError = validateAgentName(agent)
  if (nameError) return { ok: false as const, error: nameError }
  const model = splitProviderModelAttr(
    mdxAttr(attrs, "model", "modelID"),
    component,
    mdxAttr(attrs, "provider", "providerID"),
  )
  if (!model.ok) return model
  if (sourceAgent || attrs.mode === "fork") {
    return {
      ok: true as const,
      assignment: {
        kind: "fork" as const,
        raw: [
          `assign: ${agent}`,
          `from: ${sourceAgent ?? agent}`,
          `provider: ${model.providerID}`,
          `model: ${model.modelID}`,
        ].join("\n"),
        sourceAgentName: sourceAgent ?? agent,
        targetAgentName: agent,
        providerID: model.providerID,
        modelID: model.modelID,
      },
    }
  }
  return {
    ok: true as const,
    assignment: {
      kind: "create-or-reuse" as const,
      raw: [`assign: ${agent}`, `provider: ${model.providerID}`, `model: ${model.modelID}`].join("\n"),
      agentName: agent,
      providerID: model.providerID,
      modelID: model.modelID,
    },
  }
}

function firstMdxComponent(source: string, name: string) {
  const re = new RegExp(`<\\s*${name}\\b([^>]*)\\/?\\s*>`, "m")
  const match = source.match(re)
  return match ? mdxAttrs(match[1] ?? "") : undefined
}

function mdxTaskBrief(block: string) {
  const lines = block.split(/\r?\n/).filter((line) => !/^\s*<[A-Z][A-Za-z0-9]*\b[^>]*>\s*$/.test(line.trim()))
  if (lines.length > 0) lines[0] = lines[0]!.replace(/^\s*- \[[ xX]\]\s*/, "")
  return trimBlock(lines.join("\n"))
}

function mdxTagBodies(source: string, name: string) {
  const re = new RegExp(String.raw`^\s*<\s*${name}\b([^>]*)>([\s\S]*?)^\s*<\s*\/\s*${name}\s*>`, "gm")
  return Array.from(source.matchAll(re)).map((match) => ({
    attrs: mdxAttrs(match[1] ?? ""),
    body: trimBlock(match[2] ?? ""),
    raw: match[0] ?? "",
    startOffset: match.index ?? 0,
    endOffset: (match.index ?? 0) + (match[0]?.length ?? 0),
  }))
}

function mdxFirstTagBody(source: string, name: string) {
  return mdxTagBodies(source, name)[0]?.body
}

function stripTodoMdxConversationTags(source: string) {
  return trimBlock(
    source
      .replace(/<\s*Brief\b[^>]*>([\s\S]*?)<\s*\/\s*Brief\s*>/g, "$1")
      .replace(/<\s*Conversation\b[^>]*>|<\s*\/\s*Conversation\s*>/g, ""),
  )
}

function parseTodoMdxAgentComponents(markdown: string): TodoAgentTask[] {
  const re = /^\s*<\s*Agent\b([^>]*)>([\s\S]*?)^\s*<\s*\/\s*Agent\s*>/gm
  const tasks: TodoAgentTask[] = []
  for (const match of markdown.matchAll(re)) {
    const startOffset = match.index ?? 0
    const endOffset = startOffset + (match[0]?.length ?? 0)
    const attrs = mdxAttrs(match[1] ?? "")
    const body = trimBlock(match[2] ?? "")
    const agentName = mdxAttr(attrs, "id", "agent", "name") ?? "todo_agent"
    const title = mdxAttr(attrs, "title", "name") ?? agentName
    const task: TodoAgentTask = {
      title,
      checked: ["done", "completed"].includes(attrs.status ?? ""),
      startOffset,
      endOffset,
      promptText: body,
      comments: [],
      responses: [],
      diagnostics: [],
    }
    const parsed = todoAgentAssignmentFromMdxAttrs(attrs, "Agent")
    if (parsed.ok) task.assignment = parsed.assignment
    else task.diagnostics.push(parsed.error)
    for (const comment of mdxTagBodies(markdown.slice(endOffset), "Comment")) {
      const to = mdxAttr(comment.attrs, "to", "agent")
      if (to !== agentName) continue
      task.comments.push({
        status: ["resolved", "done"].includes(comment.attrs.status ?? "") ? "resolved" : "pending",
        text: comment.body,
        startOffset: endOffset + comment.startOffset,
        endOffset: endOffset + comment.endOffset,
        markerStartOffset: endOffset + comment.startOffset,
        markerEndOffset: endOffset + comment.startOffset,
      })
    }
    tasks.push(task)
  }
  return tasks
}

function validateAgentName(agentName: string) {
  if (AGENT_NAME_RE.test(agentName)) return undefined
  return `invalid agent name "${agentName}"; use letters, numbers, underscore, or dash, starting with a letter`
}

function parseSeparateTodoAgentAssignment(input: {
  agent: string
  provider?: string
  model?: string
  sourceAgent?: string
}): { ok: true; assignment: TodoAgentAssignment } | { ok: false; error: string } {
  const agent = input.agent.trim()

  const nameError = validateAgentName(agent)
  if (nameError) return { ok: false, error: nameError }

  const sourceAgent = input.sourceAgent?.trim()
  if (sourceAgent && !AGENT_NAME_RE.test(sourceAgent)) {
    return { ok: false, error: `invalid source agent name "${sourceAgent}"` }
  }

  const model = splitProviderModelAttr(input.model, "assigned task", input.provider)
  if (!model.ok) return model

  const raw = [
    `assign: ${agent}`,
    ...(sourceAgent ? [`from: ${sourceAgent}`] : []),
    `provider: ${model.providerID}`,
    `model: ${model.modelID}`,
  ].join("\n")

  if (sourceAgent) {
    return {
      ok: true,
      assignment: {
        kind: "fork",
        raw,
        sourceAgentName: sourceAgent,
        targetAgentName: agent,
        providerID: model.providerID,
        modelID: model.modelID,
      },
    }
  }
  return {
    ok: true,
    assignment: {
      kind: "create-or-reuse",
      raw,
      agentName: agent,
      providerID: model.providerID,
      modelID: model.modelID,
    },
  }
}

type MarkdownTaskRange = { line: number; indent: number; title: string; checked: boolean }

type TaskMetadata = {
  assignLine: number
  assignValue: string
  providerValue?: string
  providerLine: number
  modelValue?: string
  modelLine: number
  sourceAgentValue?: string
  sourceAgentLine: number
  promptEndLine: number
  conversationLine: number
  conversationEndLine: number
}

type ConversationMarker = {
  kind: "pending" | "resolved" | "agent"
  line: number
  offset: number
  markerEnd: number
}

function tasksSectionBounds(lines: string[]) {
  const tasksHeading = lines.findIndex((line) => stripTrailingNewline(line).trim() === "## Tasks")
  const scanStart = tasksHeading >= 0 ? tasksHeading + 1 : 0
  const nextTopHeading =
    tasksHeading >= 0
      ? lines.findIndex((line, index) => index > tasksHeading && /^##\s+/.test(stripTrailingNewline(line)))
      : -1
  const scanEnd = nextTopHeading >= 0 ? nextTopHeading : lines.length
  return { scanStart, scanEnd }
}

function collectMarkdownTaskRanges(lines: string[], scanStart: number, scanEnd: number): MarkdownTaskRange[] {
  const taskRanges: MarkdownTaskRange[] = []
  let inFence = false

  for (let i = scanStart; i < scanEnd; i++) {
    const line = stripTrailingNewline(lines[i] ?? "")
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const match = line.match(TASK_RE)
    if (!match) continue
    taskRanges.push({
      line: i,
      indent: match[1]?.length ?? 0,
      checked: (match[2] ?? " ").toLowerCase() === "x",
      title: match[3]?.trim() ?? "",
    })
  }

  return taskRanges
}

function markdownTaskEndLine(lines: string[], current: MarkdownTaskRange) {
  for (let i = current.line + 1; i < lines.length; i++) {
    const match = stripTrailingNewline(lines[i] ?? "").match(TASK_RE)
    if (match && (match[1]?.length ?? 0) <= current.indent) return i
  }
  return lines.length
}

function createTodoAgentTask(
  markdown: string,
  lines: string[],
  starts: number[],
  current: MarkdownTaskRange,
  endLine: number,
): TodoAgentTask {
  const startOffset = starts[current.line] ?? 0
  const endOffset = endLine < lines.length ? (starts[endLine] ?? markdown.length) : markdown.length
  return {
    title: current.title,
    checked: current.checked,
    startOffset,
    endOffset,
    comments: [],
    responses: [],
    diagnostics: [],
  }
}

function scanTaskMetadata(lines: string[], startLine: number, endLine: number): TaskMetadata {
  const metadata: TaskMetadata = {
    assignLine: -1,
    assignValue: "",
    providerLine: -1,
    modelLine: -1,
    sourceAgentLine: -1,
    promptEndLine: -1,
    conversationLine: -1,
    conversationEndLine: -1,
  }

  for (let i = startLine; i < endLine; i++) {
    const rawLine = stripTrailingNewline(lines[i] ?? "")
    const trimmed = rawLine.trim()
    if (metadata.assignLine < 0 && trimmed.startsWith("assign:")) {
      metadata.assignLine = i
      metadata.assignValue = trimmed.slice("assign:".length).trim()
    }
    if (metadata.providerValue === undefined && trimmed.startsWith("provider:")) {
      metadata.providerLine = i
      metadata.providerValue = trimmed.slice("provider:".length).trim()
    }
    if (metadata.modelValue === undefined && trimmed.startsWith("model:")) {
      metadata.modelLine = i
      metadata.modelValue = trimmed.slice("model:".length).trim()
    }
    if (metadata.sourceAgentValue === undefined && (trimmed.startsWith("from:") || trimmed.startsWith("fork:"))) {
      metadata.sourceAgentLine = i
      const prefix = trimmed.startsWith("from:") ? "from:" : "fork:"
      metadata.sourceAgentValue = trimmed.slice(prefix.length).trim()
    }
    if (metadata.promptEndLine < 0 && trimmed === "prompt_end:") metadata.promptEndLine = i
    if (metadata.conversationLine < 0 && trimmed === "conversation:") metadata.conversationLine = i
    if (metadata.conversationEndLine < 0 && trimmed === "conversation_end:") metadata.conversationEndLine = i
  }

  return metadata
}

function applySeparateAssignment(
  task: TodoAgentTask,
  metadata: TaskMetadata,
  markdown: string,
  lines: string[],
  starts: number[],
) {
  if (metadata.assignLine < 0) return

  const parsed = parseSeparateTodoAgentAssignment({
    agent: metadata.assignValue,
    provider: metadata.providerValue,
    model: metadata.modelValue,
    sourceAgent: metadata.sourceAgentValue,
  })
  if (parsed.ok) task.assignment = parsed.assignment
  else task.diagnostics.push(parsed.error)

  if (metadata.promptEndLine < 0) task.diagnostics.push("assigned task is missing prompt_end:")
  else if (metadata.promptEndLine <= metadata.assignLine) task.diagnostics.push("prompt_end: must appear after assign:")
  else {
    const metadataEndLine = Math.max(
      metadata.assignLine,
      metadata.providerLine,
      metadata.modelLine,
      metadata.sourceAgentLine,
    )
    task.promptStartOffset = (starts[metadataEndLine] ?? 0) + (lines[metadataEndLine]?.length ?? 0)
    task.promptEndOffset = starts[metadata.promptEndLine] ?? task.promptStartOffset
    task.promptText = trimBlock(markdown.slice(task.promptStartOffset, task.promptEndOffset))
  }
}

function conversationMarker(
  trimmed: string,
  line: number,
  offset: number,
  markerEnd: number,
): ConversationMarker | undefined {
  if (trimmed !== "comment>" && trimmed !== "comment resolved>" && trimmed !== "agent>") return undefined
  return {
    kind: trimmed === "agent>" ? "agent" : trimmed === "comment resolved>" ? "resolved" : "pending",
    line,
    offset,
    markerEnd,
  }
}

function isConversationMarkerEnd(trimmed: string, marker: ConversationMarker) {
  const isCommentEnd = trimmed === "comment_end>" && marker.kind !== "agent"
  const isAgentEnd = trimmed === "agent_end>" && marker.kind === "agent"
  return isCommentEnd || isAgentEnd
}

function appendConversationBlock(
  task: TodoAgentTask,
  marker: ConversationMarker,
  markdown: string,
  textEnd: number,
  endOffset: number,
) {
  const text = trimBlock(markdown.slice(marker.markerEnd, textEnd))
  if (marker.kind === "agent") {
    task.responses.push({ text, startOffset: marker.offset, endOffset })
    return
  }
  task.comments.push({
    status: marker.kind,
    text,
    startOffset: marker.offset,
    endOffset,
    markerStartOffset: marker.offset,
    markerEndOffset: marker.markerEnd,
  })
}

function parseConversationBlocks(
  task: TodoAgentTask,
  markdown: string,
  lines: string[],
  starts: number[],
  conversationLine: number,
  conversationEndLine: number,
) {
  let marker: ConversationMarker | undefined
  for (let i = conversationLine + 1; i < conversationEndLine; i++) {
    const trimmed = stripTrailingNewline(lines[i] ?? "").trim()
    const offset = starts[i] ?? 0
    if (!marker) {
      marker = conversationMarker(trimmed, i, offset, offset + (lines[i]?.length ?? 0))
      continue
    }
    if (!isConversationMarkerEnd(trimmed, marker)) continue
    appendConversationBlock(task, marker, markdown, offset, offset + (lines[i]?.length ?? 0))
    marker = undefined
  }
  if (marker) task.diagnostics.push(`${marker.kind === "agent" ? "agent" : "comment"} block is missing end marker`)
}

function applyConversation(
  task: TodoAgentTask,
  metadata: TaskMetadata,
  markdown: string,
  lines: string[],
  starts: number[],
) {
  if (metadata.conversationLine < 0) return

  if (metadata.conversationEndLine < 0) task.diagnostics.push("conversation: is missing conversation_end:")
  else if (metadata.conversationEndLine <= metadata.conversationLine)
    task.diagnostics.push("conversation_end: must appear after conversation:")
  else {
    task.conversationStartOffset =
      (starts[metadata.conversationLine] ?? 0) + (lines[metadata.conversationLine]?.length ?? 0)
    task.conversationEndOffset = starts[metadata.conversationEndLine] ?? task.conversationStartOffset
    task.conversationText = trimBlock(markdown.slice(task.conversationStartOffset, task.conversationEndOffset))
    parseConversationBlocks(task, markdown, lines, starts, metadata.conversationLine, metadata.conversationEndLine)
  }
}

export function parseTodoAgentTasks(markdown: string): TodoAgentParseResult {
  const lines = markdown.split(/(?<=\n)/)
  const starts = lineStarts(markdown)
  const diagnostics: string[] = []
  const mdxTasks = parseTodoMdxAgentComponents(markdown)
  diagnostics.push(...mdxTasks.flatMap((task) => task.diagnostics.map((x) => `${task.title}: ${x}`)))

  const { scanStart, scanEnd } = tasksSectionBounds(lines)
  const taskRanges = collectMarkdownTaskRanges(lines, scanStart, scanEnd)
  const tasks: TodoAgentTask[] = []

  for (const current of taskRanges) {
    const endLine = markdownTaskEndLine(lines, current)
    const task = createTodoAgentTask(markdown, lines, starts, current, endLine)
    const metadata = scanTaskMetadata(lines, current.line + 1, endLine)
    applySeparateAssignment(task, metadata, markdown, lines, starts)
    applyConversation(task, metadata, markdown, lines, starts)

    diagnostics.push(...task.diagnostics.map((x) => `${task.title}: ${x}`))
    tasks.push(task)
  }

  return { tasks: [...mdxTasks, ...tasks], diagnostics }
}

export function pendingTodoAgentComments(task: TodoAgentTask): TodoAgentComment[] {
  return task.comments.filter((comment) => comment.status === "pending")
}

function extractSystemPromptSection(markdown: string) {
  const match = markdown.match(/^##\s+System prompt\s*$/im)
  if (!match || match.index === undefined) return undefined
  const start = match.index + match[0].length
  const tail = markdown.slice(start)
  const next = tail.search(/^##\s+\S/im)
  return (next >= 0 ? tail.slice(0, next) : tail).trim()
}

function embeddedSystemPrompt(filename: string) {
  const content = EMBEDDED_AGENT_PROMPTS[filename]
  const body = content ? extractSystemPromptSection(content) : undefined
  if (!body) throw new Error(`missing bundled agent prompt: ${filename} ## System prompt`)
  return body
}

function todoBaseSystemPrompt() {
  return [embeddedSystemPrompt("_shared/base_todo.md"), embeddedSystemPrompt("_shared/tier1.md")].join("\n\n")
}

export function appendRoutedTodoAgentComments(taskMarkdown: string, fullSource: string): string {
  const parsed = parseTodoAgentTasks(taskMarkdown)
  const task = parsed.tasks[0]
  if (!task?.assignment) return taskMarkdown
  const agentName = task.assignment.kind === "fork" ? task.assignment.targetAgentName : task.assignment.agentName
  const existing = new Set(
    mdxTagBodies(taskMarkdown, "Comment")
      .map((comment) => mdxAttr(comment.attrs, "id") || comment.raw)
      .filter(Boolean),
  )
  const routed = mdxTagBodies(fullSource, "Comment").filter((comment) => {
    const to = mdxAttr(comment.attrs, "to", "agent")
    if (to !== agentName && to !== task.title) return false
    const key = mdxAttr(comment.attrs, "id") || comment.raw
    return !existing.has(key)
  })
  if (routed.length === 0) return taskMarkdown
  return `${taskMarkdown.trimEnd()}\n\n${routed.map((comment) => comment.raw).join("\n\n")}`
}

export function compileTodoAgentSystemPrompt(
  input: {
    agentName?: string
    mode?: "initial" | "follow-up"
    assignmentKind?: TodoAgentAssignment["kind"]
    sourceAgentName?: string
  } = {},
): string {
  const mode = input.mode ?? "initial"
  const assignmentKind = input.assignmentKind ?? "create-or-reuse"
  const runtime = [
    "### Runtime invocation",
    `- Agent: ${input.agentName ? `@${input.agentName}` : "(unresolved)"}`,
    `- Mode: ${mode}`,
    `- Assignment kind: ${assignmentKind}`,
  ]
  if (input.sourceAgentName) runtime.push(`- Fork source agent: @${input.sourceAgentName}`)
  return [todoBaseSystemPrompt(), runtime.join("\n")].join("\n\n")
}

export function compileTodoAgentPrompt(input: {
  task: TodoAgentTask
  systemsText?: string
  mode?: "initial" | "follow-up"
  pendingComments?: TodoAgentComment[]
}): string {
  const mode = input.mode ?? (pendingTodoAgentComments(input.task).length > 0 ? "follow-up" : "initial")
  const pending = input.pendingComments ?? pendingTodoAgentComments(input.task)
  const sections: string[] = []
  sections.push(`Todo task title:\n${input.task.title}`)
  if (input.task.assignment) sections.push(`Assignment line:\n${input.task.assignment.raw}`)
  sections.push(`Run mode:\n${mode}`)
  if (mode === "initial") {
    sections.push(
      `First-run task brief from todo.md:\n${input.task.promptText?.trim() || "(no additional task brief provided)"}`,
    )
  } else {
    sections.push(
      `Pending user comments to address:\n${
        pending.length > 0
          ? pending.map((comment, index) => `Comment ${index + 1} (pending):\n${comment.text}`).join("\n\n")
          : "(none)"
      }`,
    )
    if (pending.length > 0) {
      sections.push(
        [
          "Todo update requirement:",
          "- Address every pending comment listed above.",
          "- Do not say there are no pending comments when comments are listed.",
          "- Make your final response concise and suitable for a todo.md Comment; the runner will append it and mark handled comments done/resolved when patching is available.",
        ].join("\n"),
      )
    }
  }
  if (input.systemsText?.trim()) sections.push(`Relevant ## Systems context:\n${input.systemsText.trim()}`)
  sections.push(
    [
      "Output requested:",
      "- Start with the concrete result/status.",
      "- Then include concise validation evidence.",
      "- Then list remaining blockers/risks, or say none.",
      "- If pending comments were supplied, explicitly state that they were handled.",
      "- If you changed files, mention the important files only.",
    ].join("\n"),
  )
  return sections.join("\n\n---\n\n")
}

function linePrefixAtOffset(markdown: string, offset: number) {
  const lineStart = markdown.lastIndexOf("\n", Math.max(0, offset - 1)) + 1
  const lineEnd = markdown.indexOf("\n", offset)
  const line = markdown.slice(lineStart, lineEnd < 0 ? markdown.length : lineEnd)
  return line.match(/^\s*/)?.[0] ?? ""
}

function xmlAttrEscape(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

function upsertMdxAttr(openTag: string, attr: string, value: string) {
  const escaped = xmlAttrEscape(value)
  const re = new RegExp(`\\b${attr}\\s*=\\s*["'][^"']*["']`)
  if (re.test(openTag)) return openTag.replace(re, `${attr}="${escaped}"`)
  return openTag.replace(/\s*>$/, ` ${attr}="${escaped}">`)
}

function agentNameForTask(task: TodoAgentTask) {
  const assignment = task.assignment
  if (!assignment) return undefined
  return assignment.kind === "fork" ? assignment.targetAgentName : assignment.agentName
}

export function markTodoAgentCommentResolved(markdown: string, comment: TodoAgentComment): string {
  const marker = markdown.slice(comment.markerStartOffset, comment.markerEndOffset)
  const legacy = marker.replace("comment>", "comment resolved>")
  if (marker !== legacy)
    return markdown.slice(0, comment.markerStartOffset) + legacy + markdown.slice(comment.markerEndOffset)

  const searchStart = comment.markerStartOffset || comment.startOffset
  const relativeOpenStart = markdown.slice(searchStart, comment.endOffset).search(/<\s*Comment\b/)
  if (relativeOpenStart < 0) return markdown
  const openStart = searchStart + relativeOpenStart
  const openEnd = markdown.indexOf(">", openStart)
  if (openEnd < 0 || openEnd > comment.endOffset) return markdown
  const open = markdown.slice(openStart, openEnd + 1)
  if (!/^<\s*Comment\b/.test(open)) return markdown
  let next = upsertMdxAttr(open, "status", "done")
  if (!/\b(?:resolved|resolvedAt)\s*=/.test(next)) next = upsertMdxAttr(next, "resolvedAt", new Date().toISOString())
  if (next === open) return markdown
  return markdown.slice(0, openStart) + next + markdown.slice(openEnd + 1)
}

export function appendTodoAgentResponse(markdown: string, task: TodoAgentTask, responseText: string): string {
  const text = responseText.trimEnd()
  if (!text) return markdown
  if (task.conversationEndOffset !== undefined) {
    const indent = linePrefixAtOffset(markdown, task.conversationEndOffset)
    const block = `${indent}agent>\n${text}\n${indent}agent_end>\n\n`
    return markdown.slice(0, task.conversationEndOffset) + block + markdown.slice(task.conversationEndOffset)
  }

  const taskSource = markdown.slice(task.startOffset, task.endOffset).trimStart()
  if (!/^<\s*Agent\b/.test(taskSource)) throw new Error("task is missing conversation_end: range")

  const agent = agentNameForTask(task)
  const attrs = [
    agent ? `from="${xmlAttrEscape(agent)}"` : undefined,
    `status="done"`,
    `created="${new Date().toISOString()}"`,
  ]
    .filter(Boolean)
    .join(" ")
  const block = `

<Comment ${attrs}>
${text}
</Comment>`
  return `${markdown.slice(0, task.endOffset)}${block}${markdown.slice(task.endOffset)}`
}
