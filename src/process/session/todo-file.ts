import { mkdir, readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import { Database, eq } from "@/storage/db"
import { TodoAttachmentTable } from "@/process/session/session.sql"
import { SessionID } from "@/process/session/schema"
import { TaskState } from "@/process/session/task-state"
import { TaskNotePath } from "@/foundation/task-note-path"
import { vaultPath } from "@/foundation/notes-root"
import { projectKey, slug as slugify } from "@/tool/notes/paths"
import { parseTodoAgentTasks } from "@/process/session/todo-agent-protocol"
import { Log } from "@/foundation/util/log"
import { Flock } from "@/foundation/util/flock"
import { TodoFilePatch } from "@/process/session/todo-file-patch"

const log = Log.create({ service: "todo-file" })

export namespace TodoFile {
  export type Snapshot = {
    task_path: string
    taskPath: string
    file: string
    label: string
    source: string
    hash: string
    todos: TaskState.Info[]
    tree: TaskState.Info[]
    sections: TaskState.Section[]
    attached_todo_ids: string[]
    attached_todo_labels: Record<string, string>
  }

  export type PatchResult = {
    snapshot: Snapshot
    changed: boolean
    applied: number
    hash: string
  }

  const CHECKBOX_RE = /^(\s*)[-*+]\s+\[([ xX~-])\]\s+(.+?)\s*$/

  function root() {
    return path.resolve(vaultPath.root())
  }

  function absoluteForVaultRelative(rel: string) {
    const absolute = path.resolve(root(), rel)
    const relative = path.relative(root(), absolute)
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Path escapes notes root")
    return absolute
  }

  function looseTaskPath(input: string) {
    const canon = TaskNotePath.canonicalize(input)
    if (TaskNotePath.isValid(canon)) return canon
    const parts = canon.split("/")
    if (parts.length !== 5) return undefined
    const [scratchpad, task, project, state, slug] = parts
    if (scratchpad !== "scratchpad" || task !== "task") return undefined
    if (!TaskNotePath.STATES.includes(state as TaskNotePath.State)) return undefined
    const normalizedProject = slugify(project)
    const normalizedSlug = normalizeSlug(slug)
    if (!normalizedProject || !normalizedSlug) return undefined
    return `scratchpad/task/${normalizedProject}/${state}/${normalizedSlug}`
  }

  function fileCandidatesForAttach(input: string, taskPath: string) {
    const candidates = TaskNotePath.noteFileCandidates(taskPath).map(absoluteForVaultRelative)
    const loose = TaskNotePath.canonicalize(input)
    if (loose !== taskPath && loose.startsWith("scratchpad/task/")) {
      candidates.push(...TaskNotePath.noteFileCandidates(loose).map(absoluteForVaultRelative))
    }
    return [...new Set(candidates)]
  }

  function fileCandidatesForTaskPath(taskPath: string) {
    const candidates = TaskNotePath.noteFileCandidates(taskPath).map(absoluteForVaultRelative)
    const parts = taskPath.split("/")
    const slug = parts.at(-1)
    if (parts.length === 5 && slug?.startsWith("todo-")) {
      const loose = [...parts.slice(0, -1), slug.slice("todo-".length)].join("/")
      candidates.push(...TaskNotePath.noteFileCandidates(loose).map(absoluteForVaultRelative))
    }
    return [...new Set(candidates)]
  }

  function labelFor(taskPath: string) {
    const parsed = TaskNotePath.parse(taskPath)
    return parsed?.slug.replace(/^todo-/, "").replace(/-/g, " ") || taskPath.split("/").at(-1) || taskPath
  }

  function normalizeSlug(input: string) {
    const raw = slugify(input).replace(/^todo-/, "") || "task"
    return `todo-${raw}`
  }

  async function uniqueTaskPath(input: { title: string; slug?: string; project?: string }) {
    const project = slugify(input.project || projectKey())
    const base = normalizeSlug(input.slug || input.title)
    for (let index = 0; index < 1000; index++) {
      const suffix = index === 0 ? "" : `-${index + 1}`
      const taskPath = `scratchpad/task/${project}/active/${base}${suffix}`
      const file = absoluteForVaultRelative(`${taskPath}/todo.md`)
      if (!existsSync(file)) return { taskPath, file }
    }
    throw new Error(`Could not allocate unique todo slug for ${base}`)
  }

  function seedContent(input: { title: string; assignment?: string; body?: string }) {
    const lines = ["## Tasks", "", `- [ ] ${input.title.trim() || "New task"}`]
    if (input.assignment?.trim()) lines.push(`  assign: ${input.assignment.trim()}`)
    if (input.body?.trim())
      lines.push(
        ...input.body
          .trim()
          .split(/\r?\n/)
          .map((line) => `  ${line}`),
      )
    if (input.assignment?.trim()) lines.push("  prompt_end:", "  conversation:", "  conversation_end:")
    lines.push("", "## Systems", "")
    return `${lines.join("\n")}`
  }

  export function suggestedTaskPath(input: string, project?: string) {
    const projectName = project ?? "opencode"
    const canon = TaskNotePath.canonicalize(input)
    if (TaskNotePath.isValid(canon)) return canon
    const leaf = canon.split("/").filter(Boolean).at(-1)?.replace(/\.md$/i, "")
    if (!leaf || leaf.includes("..")) return undefined
    return `scratchpad/task/${slugify(projectName)}/active/${normalizeSlug(leaf)}`
  }

  function invalidPathMessage(input: string) {
    const suggestion = suggestedTaskPath(input)
    return [
      `Invalid todo path: ${input}`,
      "Expected scratchpad/task/<project>/active/todo-<slug> or an absolute .../todo.md path.",
      suggestion ? `For this project, try: ${suggestion}` : undefined,
      "To create and activate a new todo from the TUI, use the Todo tab [a] command.",
    ]
      .filter(Boolean)
      .join(" ")
  }

  export function parseSections(source: string): TaskState.Section[] {
    const matches = [...source.matchAll(/^##\s+(.+?)\s*$/gm)]
    if (matches.length === 0) return []
    return matches.map((match, index) => {
      const bodyStart = (match.index ?? 0) + match[0].length
      const bodyEnd = index + 1 < matches.length ? (matches[index + 1]!.index ?? source.length) : source.length
      return {
        title: match[1]!.trim(),
        body: source
          .slice(bodyStart, bodyEnd)
          .replace(/^\r?\n/, "")
          .trimEnd(),
      }
    })
  }

  function todoStatus(mark: string): TaskState.Info["status"] {
    if (mark === "x" || mark === "X") return "completed"
    if (mark === "~" || mark === "-") return "cancelled"
    return "pending"
  }

  function contentDepth(indent: string) {
    return Math.floor(indent.replace(/\t/g, "  ").length / 2)
  }

  function todoRowsToTree(rows: TaskState.Info[]) {
    const roots: TaskState.Info[] = []
    const stack: TaskState.Info[] = []
    rows.forEach((row) => {
      const depth = contentDepth(row.content.match(/^\s*/)?.[0] ?? "")
      const item: TaskState.Info = { ...row, content: row.content.trim(), children: [] }
      stack.length = depth + 1
      stack[depth] = item
      const parent = depth > 0 ? stack[depth - 1] : undefined
      if (parent) parent.children = [...(parent.children ?? []), item]
      else roots.push(item)
    })
    return roots
  }

  export function parseTodos(source: string): { todos: TaskState.Info[]; tree: TaskState.Info[] } {
    const tasks =
      parseSections(source).find((section) => section.title.trim().toLowerCase() === "tasks")?.body ?? source
    const agentByTitle = new Map<string, string>()
    for (const task of parseTodoAgentTasks(source).tasks) {
      const assignment = task.assignment
      if (!assignment) continue
      agentByTitle.set(
        task.title.trim(),
        assignment.kind === "fork" ? assignment.targetAgentName : assignment.agentName,
      )
    }
    const todos: TaskState.Info[] = []
    for (const line of tasks.split(/\r?\n/)) {
      const match = CHECKBOX_RE.exec(line)
      if (!match) continue
      const content = `${match[1] ?? ""}${match[3]!.trim()}`
      const trimmed = match[3]!.trim()
      todos.push({
        content,
        status: todoStatus(match[2]!),
        priority: "medium",
        agent: agentByTitle.get(trimmed),
        comments: [],
      })
    }
    return { todos, tree: todoRowsToTree(todos) }
  }

  async function snapshot(taskPath: string, file: string): Promise<Snapshot> {
    const source = await readFile(file, "utf8")
    const sections = parseSections(source)
    const { todos, tree } = parseTodos(source)
    const label = labelFor(taskPath)
    return {
      task_path: taskPath,
      taskPath,
      file,
      label,
      source,
      hash: TodoFilePatch.hash(source),
      todos,
      tree,
      sections,
      attached_todo_ids: [taskPath],
      attached_todo_labels: { [taskPath]: label },
    }
  }

  async function publish(sessionID: SessionID, snap: Snapshot) {
    log.info("publish", {
      sessionID,
      taskPath: snap.task_path,
      todos: snap.todos.length,
      sections: snap.sections.length,
    })
    try {
      await TaskState.update({
        sessionID,
        todo_id: snap.task_path,
        status: "active",
        source: "session-attached",
        todos: snap.todos,
        tree: snap.tree,
        sections: snap.sections,
        task_path: snap.task_path,
        attached_todo_ids: snap.attached_todo_ids,
        attached_todo_labels: snap.attached_todo_labels,
        updated_at: new Date().toISOString(),
      })
    } catch (error) {
      if (error instanceof Error && error.message.includes("No context found for instance")) return
      throw error
    }
  }

  function upsertAttachment(input: { sessionID: SessionID; taskPath: string; label: string }) {
    const now = Date.now()
    Database.use((db) =>
      db
        .insert(TodoAttachmentTable)
        .values({
          session_id: input.sessionID,
          task_path: input.taskPath,
          label: input.label,
          time_created: now,
          time_updated: now,
        })
        .onConflictDoUpdate({
          target: TodoAttachmentTable.session_id,
          set: { task_path: input.taskPath, label: input.label, time_updated: now },
        })
        .run(),
    )
  }

  export async function create(input: {
    sessionID: SessionID
    title: string
    slug?: string
    assignment?: string
    body?: string
    project?: string
  }) {
    log.info("create.request", {
      sessionID: input.sessionID,
      title: input.title,
      slug: input.slug,
      project: input.project,
    })
    const title = input.title.trim()
    if (!title) throw new Error("Todo title is required")
    const allocated = await uniqueTaskPath({ title, slug: input.slug, project: input.project })
    await mkdir(path.dirname(allocated.file), { recursive: true })
    await writeFile(allocated.file, seedContent(input), { flag: "wx" })
    const snap = await attach({ sessionID: input.sessionID, path: allocated.taskPath })
    log.info("create.success", { sessionID: input.sessionID, taskPath: snap.task_path, file: snap.file })
    return snap
  }

  export async function attach(input: { sessionID: SessionID; path: string }) {
    log.info("attach.request", { sessionID: input.sessionID, path: input.path })
    const rawTaskPath = TaskNotePath.canonicalize(input.path)
    const taskPath = TaskNotePath.isValid(rawTaskPath) ? rawTaskPath : looseTaskPath(input.path)
    if (!taskPath) throw new Error(invalidPathMessage(input.path))
    const candidates = fileCandidatesForAttach(input.path, taskPath)
    const file = candidates.find((candidate) => existsSync(candidate))
    if (!file) {
      throw new Error(
        `Todo file does not exist: ${taskPath}. Use Todo tab [a] to create it first, or attach an existing path like ${taskPath}/todo.md.`,
      )
    }
    const snap = await snapshot(taskPath, file)
    upsertAttachment({ sessionID: input.sessionID, taskPath: snap.task_path, label: snap.label })
    await publish(input.sessionID, snap)
    log.info("attach.success", { sessionID: input.sessionID, taskPath: snap.task_path, file: snap.file })
    return snap
  }

  function attachedTaskPath(sessionID: SessionID) {
    const row = Database.use((db) =>
      db.select().from(TodoAttachmentTable).where(eq(TodoAttachmentTable.session_id, sessionID)).get(),
    )
    if (!row) throw new Error(`No todo file is attached to session ${sessionID}`)
    return row.task_path
  }

  function existingFileForTaskPath(taskPath: string) {
    const candidates = fileCandidatesForTaskPath(taskPath)
    const file = candidates.find((candidate) => existsSync(candidate))
    if (!file) throw new Error(`Todo file does not exist: ${taskPath}`)
    return file
  }

  export async function patch(input: {
    sessionID: SessionID
    baseHash?: string
    operations: TodoFilePatch.Operation[]
  }): Promise<PatchResult> {
    log.info("patch.request", {
      sessionID: input.sessionID,
      operations: input.operations.map((op) => op.type),
      baseHash: input.baseHash,
    })
    const taskPath = attachedTaskPath(input.sessionID)
    const file = existingFileForTaskPath(taskPath)
    return await Flock.withLock(`todo-file:${file}`, async () => {
      const source = await readFile(file, "utf8")
      const applied = TodoFilePatch.apply({ source, baseHash: input.baseHash, operations: input.operations })
      if (applied.changed) await writeFile(file, applied.source, "utf8")
      const snap = await snapshot(taskPath, file)
      await publish(input.sessionID, snap)
      log.info("patch.success", {
        sessionID: input.sessionID,
        taskPath,
        file,
        changed: applied.changed,
        applied: applied.applied,
        hash: applied.hash,
      })
      return { snapshot: snap, changed: applied.changed, applied: applied.applied, hash: applied.hash }
    })
  }

  export async function get(sessionID: SessionID) {
    log.info("get.request", { sessionID })
    const row = Database.use((db) =>
      db.select().from(TodoAttachmentTable).where(eq(TodoAttachmentTable.session_id, sessionID)).get(),
    )
    if (!row) {
      log.info("get.empty", { sessionID })
      return { todos: [] as TaskState.Info[] }
    }
    const taskPath = row.task_path
    const candidates = fileCandidatesForTaskPath(taskPath)
    const file = candidates.find((candidate) => existsSync(candidate))
    if (!file) {
      log.warn("get.missing", { sessionID, taskPath })
      return { todos: [] as TaskState.Info[], task_path: taskPath, taskPath, status: "missing" as const }
    }
    const snap = await snapshot(taskPath, file)
    // Read-only snapshots must not publish task.updated. The Web UI listens
    // to task.updated and refetches this endpoint; publishing from GET creates
    // an infinite fetch→publish→fetch loop that leaves the Tasks panel loading.
    log.info("get.success", { sessionID, taskPath: snap.task_path, file: snap.file })
    return snap
  }
}
