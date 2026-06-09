import type { SurfaceTodoItem, SurfaceTodoSnapshot } from "./ports"

function list<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

function normalizeTodoItem(value: unknown): SurfaceTodoItem {
  const item = object(value)
  return {
    content: typeof item.content === "string" ? item.content : "",
    status: typeof item.status === "string" ? item.status : "pending",
    priority: typeof item.priority === "string" ? item.priority : "medium",
    num: typeof item.num === "string" ? item.num : undefined,
    type: typeof item.type === "string" ? item.type : undefined,
    phase: typeof item.phase === "string" ? item.phase : undefined,
    acceptance_signal: typeof item.acceptance_signal === "string" ? item.acceptance_signal : undefined,
    depends_on: list<string>(item.depends_on).filter((x) => typeof x === "string"),
    blocked_by: list<string>(item.blocked_by).filter((x) => typeof x === "string"),
    parallel_group: typeof item.parallel_group === "string" ? item.parallel_group : undefined,
    agent: typeof item.agent === "string" ? item.agent : undefined,
    comments: list<string>(item.comments).filter((x) => typeof x === "string"),
    learnings: list<string>(item.learnings).filter((x) => typeof x === "string"),
    plans: list<string>(item.plans).filter((x) => typeof x === "string"),
    children: list<unknown>(item.children).map(normalizeTodoItem),
  }
}

export function normalizeTodoSnapshot(value: unknown): SurfaceTodoSnapshot {
  const input = object(value)
  const rawTodos = Array.isArray(value) ? value : input.todos
  const todos = list<unknown>(rawTodos).map(normalizeTodoItem)
  const tree = list<unknown>(input.tree).map(normalizeTodoItem)
  const taskPath =
    typeof input.taskPath === "string"
      ? input.taskPath
      : typeof input.task_path === "string"
        ? input.task_path
        : undefined
  return {
    todo_id: typeof input.todo_id === "string" ? input.todo_id : undefined,
    status: typeof input.status === "string" ? input.status : undefined,
    source: typeof input.source === "string" ? input.source : undefined,
    revision: typeof input.revision === "string" ? input.revision : undefined,
    updated_at: typeof input.updated_at === "string" ? input.updated_at : undefined,
    todos,
    tree: tree.length > 0 ? tree : todos.filter((todo) => todo.children?.length),
    progress_tail: list<string>(input.progress_tail).filter((x) => typeof x === "string"),
    task_path: taskPath,
    taskPath,
    hash: typeof input.hash === "string" ? input.hash : undefined,
    sections: list<unknown>(input.sections).map((section) => {
      const s = object(section)
      return {
        title: typeof s.title === "string" ? s.title : "Section",
        body: typeof s.body === "string" ? s.body : "",
      }
    }),
    context: typeof input.context === "string" ? input.context : undefined,
    learnings_by_agent: object(input.learnings_by_agent) as Record<string, string[]>,
    open_questions: list<string>(input.open_questions).filter((x) => typeof x === "string"),
    working_memory: object(input.working_memory) as Record<string, string>,
    verification_results: typeof input.verification_results === "string" ? input.verification_results : undefined,
    messages_recent: list<string>(input.messages_recent).filter((x) => typeof x === "string"),
  }
}
