import z from "zod"
export * from "@/tool/task/contract/version"
export * from "@/tool/task/contract/identity"
export * from "@/tool/task/contract/error"
export * from "@/tool/task/contract/event"
export * from "@/tool/task/contract/conformance"
export * from "@/tool/task/contract/delegation-model-selection"
import { TaskContractVersion } from "@/tool/task/contract/version"

const nonEmpty = () => z.string().min(1)
const optionalNonEmpty = () => nonEmpty().optional()

export const TaskOperationSchema = z.enum(["spawn", "result", "kill", "pause", "resume", "resurrect", "model"])
export type TaskOperation = z.infer<typeof TaskOperationSchema>

export const TaskLifecycleOperationSchema = z.enum(["kill", "pause", "resume", "resurrect"])
export type TaskLifecycleOperation = z.infer<typeof TaskLifecycleOperationSchema>

export const TaskResultStatusSchema = z.enum([
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
export type TaskResultStatus = z.infer<typeof TaskResultStatusSchema>

export const TaskErrorKindSchema = z.enum(["rate_limit", "abort", "subagent_error"])
export type TaskErrorKind = z.infer<typeof TaskErrorKindSchema>

export const TaskDelegationModeSchema = z.enum(["explore", "implement", "verify"])
export type TaskDelegationMode = z.infer<typeof TaskDelegationModeSchema>

export const TaskFilesystemPolicySchema = z.enum(["bash-only"])
export type TaskFilesystemPolicy = z.infer<typeof TaskFilesystemPolicySchema>

export const TaskOutputFormatSchema = z.enum(["structured-summary"])
export type TaskOutputFormat = z.infer<typeof TaskOutputFormatSchema>

export const TaskSpawnBudgetSchema = z.object({
  max_files: z.number().int().positive().optional(),
  max_output_chars: z.number().int().positive().optional(),
  timeout_ms: z.number().int().positive().optional(),
})
export type TaskSpawnBudget = z.infer<typeof TaskSpawnBudgetSchema>

export const TaskSpawnDelegationSchema = z
  .object({
    mode: TaskDelegationModeSchema.optional(),
    objective: optionalNonEmpty(),
    scope: z.array(nonEmpty()).optional(),
    out_of_scope: z.array(nonEmpty()).optional(),
    filesystem_policy: TaskFilesystemPolicySchema.default("bash-only").optional(),
    output_format: TaskOutputFormatSchema.default("structured-summary").optional(),
    can_edit: z.boolean().default(false).optional(),
    allowed_paths: z.array(nonEmpty()).optional(),
    forbidden_paths: z.array(nonEmpty()).optional(),
    budget: TaskSpawnBudgetSchema.optional(),
  })
  .strict()
export type TaskSpawnDelegation = z.infer<typeof TaskSpawnDelegationSchema>

export const TaskReferenceSchema = z
  .object({
    task_id: optionalNonEmpty(),
    pid: optionalNonEmpty(),
  })
  .strict()
export type TaskReference = z.infer<typeof TaskReferenceSchema>

type TaskReferenceInput = { task_id?: string; pid?: string }

const taskReferenceRequired = <T extends z.ZodType>(schema: T) =>
  schema.refine(
    (value) => {
      const ref = value as TaskReferenceInput
      return Boolean(ref.task_id || ref.pid)
    },
    { message: "task_id or pid is required" },
  )

export const TaskSpawnOperationSchema = z
  .object({
    op: z.literal("spawn").optional(),
    description: nonEmpty(),
    prompt: nonEmpty(),
    subagent_type: nonEmpty(),
    task_id: optionalNonEmpty(),
    model: optionalNonEmpty(),
    models: z.array(nonEmpty()).optional(),
    ...TaskSpawnDelegationSchema.shape,
    background: z.boolean().optional(),
    run_in_background: z.boolean().optional(),
  })
  .strict()
  .refine((value) => value.mode !== "implement" || value.can_edit === true, {
    path: ["can_edit"],
    message: "can_edit=true is required for implement-mode subagents",
  })
  .refine(
    (value) => value.mode !== "implement" || (Array.isArray(value.allowed_paths) && value.allowed_paths.length > 0),
    {
      path: ["allowed_paths"],
      message: "non-empty allowed_paths is required for implement-mode subagents",
    },
  )
  .refine((value) => value.mode === "implement" || value.can_edit !== true, {
    path: ["can_edit"],
    message: "only implement-mode subagents may set can_edit=true",
  })
  .refine(
    (value) =>
      value.background === undefined ||
      value.run_in_background === undefined ||
      value.background === value.run_in_background,
    {
      path: ["run_in_background"],
      message: "run_in_background must match background when both are supplied",
    },
  )
export type TaskSpawnOperation = z.infer<typeof TaskSpawnOperationSchema>

export const TaskResultOperationSchema = z
  .object({
    op: z.literal("result"),
    background_task_id: nonEmpty(),
    timeout_ms: z.number().min(0).optional(),
  })
  .strict()
export type TaskResultOperation = z.infer<typeof TaskResultOperationSchema>

export const TaskLifecycleParametersSchema = taskReferenceRequired(
  z
    .object({
      op: TaskLifecycleOperationSchema,
      ...TaskReferenceSchema.shape,
      reason: z.string().max(280).optional(),
    })
    .strict(),
)
export type TaskLifecycleParameters = z.infer<typeof TaskLifecycleParametersSchema>

export const TaskModelOperationSchema = taskReferenceRequired(
  z
    .object({
      op: z.literal("model"),
      ...TaskReferenceSchema.shape,
      model: nonEmpty(),
    })
    .strict(),
)
export type TaskModelOperation = z.infer<typeof TaskModelOperationSchema>

export const TaskToolParametersSchema = z.union([
  TaskSpawnOperationSchema,
  TaskResultOperationSchema,
  TaskLifecycleParametersSchema,
  TaskModelOperationSchema,
])
export type TaskToolParameters = z.infer<typeof TaskToolParametersSchema>

export const TaskToolContractSchema = z.object({
  version: z.literal(TaskContractVersion),
  operations: z.array(TaskOperationSchema),
  resultStatuses: z.array(TaskResultStatusSchema),
  errorKinds: z.array(TaskErrorKindSchema),
  guarantees: z.array(nonEmpty()),
})
export type TaskToolContract = z.infer<typeof TaskToolContractSchema>

export const TaskToolContract: TaskToolContract = {
  version: TaskContractVersion,
  operations: TaskOperationSchema.options,
  resultStatuses: TaskResultStatusSchema.options,
  errorKinds: TaskErrorKindSchema.options,
  guarantees: [
    "plain-language-subagent-spawn",
    "structured-delegation-contract",
    "bash-only-subagent-filesystem-policy",
    "async-background-result-polling",
    "parent-visible-child-failures",
    "typed-inter-agent-messages",
    "tiered-delegation-gate",
    "orchestrator-delegates-tier1-only",
  ],
}

export const TaskToolPortSchema = z.object({
  version: z.literal(TaskContractVersion),
  operations: z.array(TaskOperationSchema).optional(),
})
export type TaskToolPortSchema = z.infer<typeof TaskToolPortSchema>
