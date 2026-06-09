import z from "zod"

export const TaskContractEventTypeSchema = z.enum([
  "task.todo.attached",
  "task.todo.read",
  "task.scope.read",
  "task.scope.write",
  "task.budget.increment",
  "task.spawned",
  "task.running",
  "task.completed",
  "task.failed",
  "task.rate_limited",
  "task.aborted",
  "task.message.sent",
  "task.message.acked",
  "task.note.written",
  "task.lifecycle.signalled",
])

export type TaskContractEventType = z.infer<typeof TaskContractEventTypeSchema>

export const TaskContractEventStatusSchema = z.enum([
  "pending",
  "timeout",
  "done",
  "error",
  "rate_limited",
  "aborted",
  "not_found",
  "invalid_input",
  "permission_denied",
])

export const TaskContractEventErrorKindSchema = z.enum(["rate_limit", "abort", "subagent_error"])

export const TaskContractEventSchema = z.object({
  type: TaskContractEventTypeSchema,
  taskNote: z.string().optional(),
  taskID: z.string().optional(),
  backgroundTaskID: z.string().optional(),
  parentTaskID: z.string().optional(),
  agent: z.string().optional(),
  todoPath: z.string().optional(),
  status: TaskContractEventStatusSchema.optional(),
  errorKind: TaskContractEventErrorKindSchema.optional(),
  timestamp: z.number().int().nonnegative().optional(),
})

export type TaskContractEvent = z.infer<typeof TaskContractEventSchema>
