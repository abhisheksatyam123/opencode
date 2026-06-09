import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { makeRuntime } from "@/foundation/effect/run-service"
import { SessionID } from "@/process/session/schema"
import { Effect, Layer, ServiceMap } from "effect"
import z from "zod"
import { Database, eq, asc } from "@/storage/db"
import { TodoTable } from "@/process/session/session.sql"

export namespace TaskState {
  export type Info = {
    content: string
    status: string
    priority: string
    num?: string
    type?: string
    phase?: string
    acceptance_signal?: string
    depends_on?: string[]
    blocked_by?: string[]
    parallel_group?: string
    agent?: string
    comments: string[]
    learnings?: string[]
    plans?: string[]
    children?: Info[]
  }

  export type Section = {
    title: string
    body: string
  }

  export type SnapshotStatus = "active" | "deferred" | "done" | "failed" | "missing"
  export type SnapshotSource =
    | "explicit"
    | "session-active"
    | "session-attached"
    | "worktree-active"
    | "branch-active"
    | "default"
    | "archived-result"
    | "legacy"
    | "none"

  export const Section = z.object({
    title: z.string(),
    body: z.string(),
  })

  export const Info: z.ZodType<Info> = z.lazy(() =>
    z
      .object({
        content: z.string().describe("Brief description of the task"),
        status: z.string().describe("Current status of the task: pending, in_progress, completed, cancelled"),
        priority: z.string().describe("Priority level of the task: high, medium, low"),
        num: z.string().optional().describe("Hierarchical task number, when present"),
        type: z.string().optional().describe("Task type tag, when present"),
        phase: z.string().optional().describe("Phase heading this task belongs to"),
        acceptance_signal: z.string().optional().describe("Acceptance/acceptance signal for this task"),
        depends_on: z.array(z.string()).optional().describe("Explicit dependency task refs"),
        blocked_by: z.array(z.string()).optional().describe("Blocking task refs"),
        parallel_group: z.string().optional().describe("Parallel execution group"),
        agent: z.string().optional().describe("Agent assigned to this item"),
        comments: z.array(z.string()).default([]).describe("Comment lines (> prefix) attached to this item"),
        learnings: z.array(z.string()).optional().describe("Learning lines attached to this item"),
        plans: z.array(z.string()).optional().describe("Plan lines attached to this item"),
        children: z
          .array(z.lazy(() => Info))
          .optional()
          .describe("Nested sub-tasks"),
      })
      .meta({ ref: "Todo" }),
  )

  export const Event = {
    Updated: BusEvent.define(
      "task.updated",
      z.object({
        sessionID: SessionID.zod,
        /** Stable todo registry id, when the snapshot is backed by a task path */
        todo_id: z.string().optional(),
        /** Snapshot lifecycle state derived from the task path/registry */
        status: z.enum(["active", "deferred", "done", "failed", "missing"]).optional(),
        /** Resolution source used to choose this snapshot */
        source: z
          .enum(["explicit", "session-active", "session-attached", "worktree-active", "branch-active", "default", "archived-result", "legacy", "none"])
          .optional(),
        /** Optional revision/hash for clients that want stale-update guards */
        revision: z.string().optional(),
        /** Optional source update timestamp */
        updated_at: z.string().optional(),
        todos: z.array(Info),
        progress_tail: z.array(z.string()).optional(),
        /** Full tree with nested children — use this for UI rendering */
        tree: z.array(Info).optional(),
        /** Optional concise context extracted from the task path (typically from ## Systems). */
        context: z.string().optional(),
        /** Learnings grouped by agent name */
        learnings_by_agent: z.record(z.string(), z.array(z.string())).optional(),
        /** Open question or blocker lines extracted from ## Systems subsections. */
        open_questions: z.array(z.string()).optional(),
        /** Verification/evidence summary text */
        verification_results: z.string().optional(),
        /** Recent inter-agent coordination entries from ## Systems / ### Coordination — last N entries across all sub-sections */
        messages_recent: z.array(z.string()).optional(),
        /** Current task path bound to this session */
        task_path: z.string().optional(),
        /** Current task sections, in note order, for one-to-one UI rendering */
        sections: z.array(Section).optional(),
        /** All active workspace todos in scope */
        workspace_todos: z.array(Info).optional(),
        /** Todo IDs attached to this session */
        attached_todo_ids: z.array(z.string()).optional(),
        /** Labels for attached todos */
        attached_todo_labels: z.record(z.string(), z.string()).optional(),
      }),
    ),
  }

  export interface Interface {
    readonly update: (input: {
      sessionID: SessionID
      todo_id?: string
      status?: SnapshotStatus
      source?: SnapshotSource
      revision?: string
      updated_at?: string
      todos: Info[]
      progress_tail?: string[]
      tree?: Info[]
      context?: string
      learnings_by_agent?: Record<string, string[]>
      open_questions?: string[]
      verification_results?: string
      messages_recent?: string[]
      task_path?: string
      sections?: Section[]
      workspace_todos?: Info[]
      attached_todo_ids?: string[]
      attached_todo_labels?: Record<string, string>
    }) => Effect.Effect<void>
    readonly get: (sessionID: SessionID) => Effect.Effect<Info[]>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/SessionTaskState") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service

      const update = Effect.fn("TaskState.update")(function* (input: {
        sessionID: SessionID
        todo_id?: string
        status?: SnapshotStatus
        source?: SnapshotSource
        revision?: string
        updated_at?: string
        todos: Info[]
        progress_tail?: string[]
        tree?: Info[]
        context?: string
        learnings_by_agent?: Record<string, string[]>
        open_questions?: string[]
        verification_results?: string
        messages_recent?: string[]
        task_path?: string
        sections?: Section[]
        workspace_todos?: Info[]
        attached_todo_ids?: string[]
        attached_todo_labels?: Record<string, string>
      }) {
        yield* Effect.sync(() =>
          Database.transaction((db) => {
            db.delete(TodoTable).where(eq(TodoTable.session_id, input.sessionID)).run()
            if (input.todos.length === 0) return
            db.insert(TodoTable)
              .values(
                input.todos.map((todo, position) => ({
                  session_id: input.sessionID,
                  content: todo.content,
                  status: todo.status,
                  priority: todo.priority,
                  agent: todo.agent ?? null,
                  comments: todo.comments ?? [],
                  position,
                })),
              )
              .run()
          }),
        )
        yield* bus.publish(Event.Updated, {
          sessionID: input.sessionID,
          todo_id: input.todo_id,
          status: input.status,
          source: input.source,
          revision: input.revision,
          updated_at: input.updated_at,
          todos: input.todos,
          progress_tail: input.progress_tail,
          tree: input.tree,
          context: input.context,
          learnings_by_agent: input.learnings_by_agent,
          open_questions: input.open_questions,
          verification_results: input.verification_results,
          messages_recent: input.messages_recent,
          task_path: input.task_path,
          sections: input.sections,
          workspace_todos: input.workspace_todos,
          attached_todo_ids: input.attached_todo_ids,
          attached_todo_labels: input.attached_todo_labels,
        })
      })

      const get = Effect.fn("TaskState.get")(function* (sessionID: SessionID) {
        const rows = yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .select()
              .from(TodoTable)
              .where(eq(TodoTable.session_id, sessionID))
              .orderBy(asc(TodoTable.position))
              .all(),
          ),
        )
        return rows.map((row) => ({
          content: row.content,
          status: row.status,
          priority: row.priority,
          agent: row.agent ?? undefined,
          comments: row.comments ?? [],
        }))
      })

      return Service.of({ update, get })
    }),
  )

  export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))
  const { runPromise } = makeRuntime(Service, defaultLayer)

  export async function update(input: {
    sessionID: SessionID
    todo_id?: string
    status?: SnapshotStatus
    source?: SnapshotSource
    revision?: string
    updated_at?: string
    todos: Info[]
    progress_tail?: string[]
    tree?: Info[]
    context?: string
    learnings_by_agent?: Record<string, string[]>
    open_questions?: string[]
    verification_results?: string
    messages_recent?: string[]
    task_path?: string
    sections?: Section[]
    workspace_todos?: Info[]
    attached_todo_ids?: string[]
    attached_todo_labels?: Record<string, string>
  }) {
    return runPromise((svc) => svc.update(input))
  }

  export async function get(sessionID: SessionID) {
    return runPromise((svc) => svc.get(sessionID))
  }
}
