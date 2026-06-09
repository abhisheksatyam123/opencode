import { createHash } from "node:crypto"
import {
  appendTodoAgentResponse,
  markTodoAgentCommentResolved,
  parseTodoAgentTasks,
} from "@/process/session/todo-agent-protocol"

export namespace TodoFilePatch {
  export type Operation =
    | { type: "append-system-fact"; text: string; agentName?: string }
    | { type: "add-task"; markdown: string; afterTaskID?: string; afterTitle?: string }
    | { type: "append-agent-response"; taskID?: string; taskTitle?: string; text: string }
    | { type: "resolve-comments"; taskID?: string; taskTitle?: string; commentText?: string; allPending?: boolean }
    | { type: "set-task-checked"; taskID?: string; taskTitle?: string; checked: boolean }
    | { type: "add-comment"; taskID?: string; taskTitle?: string; text: string }
    | { type: "replace-source"; source: string }

  export type ApplyInput = {
    source: string
    baseHash?: string
    operations: Operation[]
  }

  export type ApplyResult = {
    source: string
    changed: boolean
    hash: string
    applied: number
  }

  export class ConflictError extends Error {
    constructor(
      message: string,
      readonly detail?: unknown,
    ) {
      super(message)
      this.name = "TodoFilePatchConflictError"
    }
  }

  export function hash(source: string) {
    return createHash("sha256").update(source).digest("hex")
  }

  function isMergeable(op: Operation) {
    return op.type === "append-system-fact" || op.type === "add-task"
  }

  function ensureBase(input: ApplyInput) {
    if (!input.baseHash) return
    if (input.baseHash === hash(input.source)) return
    const unsafe = input.operations.filter((op) => !isMergeable(op))
    if (unsafe.length > 0) {
      throw new ConflictError("todo.md changed since this patch was based", {
        expected: input.baseHash,
        actual: hash(input.source),
        unsafeOperations: unsafe.map((op) => op.type),
      })
    }
  }

  function taskIDFromBlock(block: string) {
    return (
      block.match(/^\s*id:\s*(\S+)\s*$/m)?.[1] ??
      block.match(/<\s*(?:Task|Agent)\b[^>]*\bid\s*=\s*["']([^"']+)["']/)?.[1]
    )
  }

  function taskBlockSource(source: string, task: { startOffset: number; endOffset: number }) {
    return source.slice(task.startOffset, task.endOffset)
  }

  function findTask(source: string, input: { taskID?: string; taskTitle?: string }) {
    const tasks = parseTodoAgentTasks(source).tasks
    if (input.taskID) {
      const byID = tasks.find((task) => taskIDFromBlock(taskBlockSource(source, task)) === input.taskID)
      if (byID) return byID
    }
    if (input.taskTitle) {
      const byTitle = tasks.find((task) => task.title.trim() === input.taskTitle?.trim())
      if (byTitle) return byTitle
    }
    throw new ConflictError(
      `todo task not found${input.taskID ? `: ${input.taskID}` : input.taskTitle ? `: ${input.taskTitle}` : ""}`,
    )
  }

  function appendSystemsFact(source: string, op: Extract<Operation, { type: "append-system-fact" }>) {
    const fact = op.text.trim()
    if (!fact) return source
    const line = `- ${op.agentName ? `${op.agentName}: ` : ""}${fact}`
    const systems = /^## Systems\s*$/m.exec(source)
    if (!systems) return `${source.trimEnd()}\n\n## Systems\n\n${line}\n`
    const afterHeading = systems.index + systems[0].length
    const nextHeading = source.slice(afterHeading).search(/^##\s+\S/m)
    const insertAt = nextHeading >= 0 ? afterHeading + nextHeading : source.length
    const before = source.slice(0, insertAt).trimEnd()
    const after = source.slice(insertAt)
    if (before.includes(line)) return source
    return `${before}\n${line}\n${after.startsWith("\n") ? after : after ? `\n${after}` : ""}`
  }

  function addTask(source: string, op: Extract<Operation, { type: "add-task" }>) {
    const taskMarkdown = op.markdown.trimEnd()
    if (!taskMarkdown.trim()) return source
    if (op.afterTaskID || op.afterTitle) {
      const task = findTask(source, { taskID: op.afterTaskID, taskTitle: op.afterTitle })
      return `${source.slice(0, task.endOffset).trimEnd()}\n\n${taskMarkdown}\n${source.slice(task.endOffset)}`
    }
    const systems = /^## Systems\s*$/m.exec(source)
    const insertAt = systems?.index ?? source.length
    return `${source.slice(0, insertAt).trimEnd()}\n\n${taskMarkdown}\n\n${source.slice(insertAt).replace(/^\n+/, "")}`
  }

  function appendResponse(source: string, op: Extract<Operation, { type: "append-agent-response" }>) {
    const task = findTask(source, { taskID: op.taskID, taskTitle: op.taskTitle })
    return appendTodoAgentResponse(source, task, op.text)
  }

  function resolveComments(source: string, op: Extract<Operation, { type: "resolve-comments" }>) {
    let next = source
    const task = findTask(source, { taskID: op.taskID, taskTitle: op.taskTitle })
    const pending = task.comments
      .filter((comment) => comment.status === "pending")
      .sort((a, b) => b.markerStartOffset - a.markerStartOffset)
    for (const comment of pending) {
      if (!op.allPending && op.commentText && !comment.text.includes(op.commentText)) continue
      next = markTodoAgentCommentResolved(next, comment)
    }
    return next
  }

  function addComment(source: string, op: Extract<Operation, { type: "add-comment" }>) {
    const task = findTask(source, { taskID: op.taskID, taskTitle: op.taskTitle })
    const text = op.text.trim()
    if (!text) return source
    const block = source.slice(task.startOffset, task.endOffset)
    const conversationEnd = block.search(/^\s*conversation_end:\s*$/m)
    const insertAt = conversationEnd >= 0 ? task.startOffset + conversationEnd : task.endOffset
    const prefix = conversationEnd >= 0 ? "" : "  conversation:\n"
    const suffix = conversationEnd >= 0 ? "" : "  conversation_end:\n"
    const comment = `  comment>\n${text
      .split(/\r?\n/)
      .map((line) => `  ${line}`)
      .join("\n")}\n  comment_end>\n`
    return `${source.slice(0, insertAt)}${prefix}${comment}${suffix}${source.slice(insertAt)}`
  }

  function setTaskChecked(source: string, op: Extract<Operation, { type: "set-task-checked" }>) {
    const task = findTask(source, { taskID: op.taskID, taskTitle: op.taskTitle })
    const lineEnd = source.indexOf("\n", task.startOffset)
    const end = lineEnd < 0 ? source.length : lineEnd
    const line = source.slice(task.startOffset, end)
    const replacement = op.checked ? "- [x]" : "- [ ]"
    const nextLine = line.replace(/- \[[ xX]\]/, replacement)
    if (nextLine !== line) return source.slice(0, task.startOffset) + nextLine + source.slice(end)

    const block = source.slice(task.startOffset, task.endOffset)
    const open = block.match(/<\s*Agent\b[\s\S]*?>/)
    if (!open || open.index === undefined) return source
    const status = op.checked ? "completed" : "pending"
    const current = open[0]
    const next = /\bstatus\s*=\s*["'][^"']*["']/.test(current)
      ? current.replace(/\bstatus\s*=\s*["'][^"']*["']/, `status="${status}"`)
      : current.replace(/>\s*$/, ` status="${status}">`)
    if (next === current) return source
    const start = task.startOffset + open.index
    return source.slice(0, start) + next + source.slice(start + current.length)
  }

  export function apply(input: ApplyInput): ApplyResult {
    ensureBase(input)
    let source = input.source
    let applied = 0
    for (const op of input.operations) {
      const before = source
      if (op.type === "append-system-fact") source = appendSystemsFact(source, op)
      else if (op.type === "add-task") source = addTask(source, op)
      else if (op.type === "append-agent-response") source = appendResponse(source, op)
      else if (op.type === "resolve-comments") source = resolveComments(source, op)
      else if (op.type === "set-task-checked") source = setTaskChecked(source, op)
      else if (op.type === "add-comment") source = addComment(source, op)
      else if (op.type === "replace-source") source = op.source
      if (source !== before) applied++
    }
    return { source, changed: source !== input.source, hash: hash(source), applied }
  }
}
