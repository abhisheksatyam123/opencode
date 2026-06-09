import z from "zod"
import {
  TaskDelegationModeSchema,
  TaskFilesystemPolicySchema,
  TaskOutputFormatSchema,
  TaskSpawnBudgetSchema,
} from "@/tool/task/contract/port"

const optionalString = () => z.string().optional()
const optionalNonEmpty = () => z.string().min(1).optional()

export const TaskSpawnRuntimeParameters = z
  .object({
    op: z.literal("spawn").optional().describe("Spawn a subagent. Omit only for legacy spawn calls."),
    description: z.string().optional().describe("Optional short label. If omitted, derived from task/prompt."),
    task: z.string().optional().describe("Plain-language task for the subagent. Preferred over prompt."),
    prompt: z.string().optional().describe("Legacy alias for task."),
    subagent_type: z.string().describe("The type of specialized agent to use for this task"),
    task_id: z
      .string()
      .describe(
        "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
      )
      .optional(),
    model: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional explicit model override for this subagent in `provider:model` or `provider/model` format. If omitted, runtime selects by capability and health.",
      ),
    models: z
      .array(z.string())
      .optional()
      .describe(
        "Optional provider/model fallback candidates. Runtime ranks these against the subagent capability requirements and local health; first available wins.",
      ),
    command: z.string().describe("The command that triggered this task").optional(),
    mode: TaskDelegationModeSchema.optional().describe(
      "Delegation mode: explore=read-only analysis, implement=bounded edits, verify=tests/audits.",
    ),
    objective: optionalNonEmpty().describe(
      "One-sentence outcome for this subagent. Prefer this over verbose prompt repetition.",
    ),
    scope: z
      .array(z.string().min(1))
      .optional()
      .describe("Files, directories, modules, or commands the subagent may inspect or run."),
    out_of_scope: z.array(z.string().min(1)).optional().describe("Areas the subagent must not inspect or change."),
    filesystem_policy: TaskFilesystemPolicySchema.default("bash-only")
      .optional()
      .describe("Filesystem access policy. Only bash-only is supported."),
    output_format: TaskOutputFormatSchema.default("structured-summary")
      .optional()
      .describe("Required result shape. Only structured-summary is supported."),
    can_edit: z
      .boolean()
      .default(false)
      .optional()
      .describe("Defaults false. Set true only with mode=implement and disjoint ownership scope."),
    allowed_paths: z
      .array(z.string().min(1))
      .optional()
      .describe("Required non-empty path allow-list for implement mode; omit for read-only modes."),
    forbidden_paths: z.array(z.string().min(1)).optional().describe("Optional path deny-list."),
    budget: TaskSpawnBudgetSchema.optional().describe(
      "Optional bounded budget: max_files, max_output_chars, timeout_ms.",
    ),
    background: z
      .boolean()
      .optional()
      .describe(
        "When true, start the subagent in the background and return immediately with a background_task_id. Collect later with task(op='result', background_task_id=...). Enables fan-out/fan-in execution.",
      ),
    run_in_background: z
      .boolean()
      .optional()
      .describe("Legacy alias for background. Internally normalized to background."),
  })
  .strict()

export const TaskResultRuntimeParameters = z
  .object({
    op: z.literal("result"),
    background_task_id: z.string().describe("The background_task_id returned by task(op='spawn', background=true)"),
    timeout_ms: z
      .number()
      .min(0)
      .optional()
      .describe(
        "How long to wait in ms. 0 = nonblocking status check. Blocking waits must follow exponential minute backoff: 300000, 600000, 1200000, 1800000, then 2400000.",
      ),
  })
  .strict()
export type TaskResultRuntimeParameters = z.infer<typeof TaskResultRuntimeParameters>

export const TaskLifecycleRuntimeParameters = z
  .object({
    op: z.enum(["kill", "pause", "resume", "resurrect"]),
    task_id: optionalString(),
    pid: optionalString(),
    reason: z.string().max(280).optional(),
  })
  .strict()

export const TaskModelRuntimeParameters = z
  .object({
    op: z.literal("model"),
    task_id: optionalString(),
    pid: optionalString(),
    model: optionalString(),
  })
  .strict()

const NormalizedTaskSpawnRuntimeParameters = TaskSpawnRuntimeParameters.extend({ op: z.literal("spawn") }).superRefine(
  (value, ctx) => {
    if (!value.prompt || !value.prompt.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["task"], message: "task is required" })
    }
    if (!value.description || !value.description.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["description"], message: "description is required" })
    }
    if (value.mode === "implement" && value.can_edit !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["can_edit"],
        message: "can_edit=true is required for implement-mode subagents",
      })
    }
    if (value.mode !== "implement" && value.can_edit === true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["can_edit"],
        message: "only implement-mode subagents may set can_edit=true",
      })
    }
  },
)

const TaskToolOperationParameters = z.discriminatedUnion("op", [
  NormalizedTaskSpawnRuntimeParameters,
  TaskResultRuntimeParameters,
  TaskLifecycleRuntimeParameters,
  TaskModelRuntimeParameters,
])

type NormalizedTaskToolRuntimeParameters = z.infer<typeof TaskToolOperationParameters>
export type TaskToolRuntimeParameters =
  | z.infer<typeof TaskSpawnRuntimeParameters>
  | z.infer<typeof TaskResultRuntimeParameters>
  | z.infer<typeof TaskLifecycleRuntimeParameters>
  | z.infer<typeof TaskModelRuntimeParameters>

const operationKeys = {
  spawn: new Set([
    "op",
    "description",
    "task",
    "prompt",
    "subagent_type",
    "task_id",
    "model",
    "models",
    "command",
    "mode",
    "objective",
    "scope",
    "out_of_scope",
    "filesystem_policy",
    "output_format",
    "can_edit",
    "allowed_paths",
    "forbidden_paths",
    "budget",
    "background",
    "run_in_background",
  ]),
  result: new Set(["op", "background_task_id", "timeout_ms"]),
  kill: new Set(["op", "task_id", "pid", "reason"]),
  pause: new Set(["op", "task_id", "pid", "reason"]),
  resume: new Set(["op", "task_id", "pid", "reason"]),
  resurrect: new Set(["op", "task_id", "pid", "reason"]),
  model: new Set(["op", "task_id", "pid", "model"]),
} as const satisfies Record<string, ReadonlySet<string>>

const knownRuntimeKeys = new Set(Object.values(operationKeys).flatMap((keys) => [...keys]))
const spawnOptionalKeysThatMayBeGeneratedEmpty = new Set([
  "task_id",
  "model",
  "models",
  "command",
  "mode",
  "objective",
  "scope",
  "out_of_scope",
  "filesystem_policy",
  "output_format",
  "allowed_paths",
  "forbidden_paths",
  "budget",
])

function isGeneratedEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true
  if (value === false || value === 0) return true
  if (Array.isArray(value) && value.length === 0) return true
  if (typeof value === "object" && value !== null && Object.keys(value as Record<string, unknown>).length === 0)
    return true
  return false
}

function deriveDescription(task: string): string {
  const words = task.trim().replace(/\s+/g, " ").split(" ").filter(Boolean)
  return words.slice(0, 5).join(" ") || "delegate task"
}

function normalizeSpawnAliases(out: Record<string, unknown>): void {
  if (typeof out.task === "string" && !out.prompt) out.prompt = out.task
  delete out.task
  if (typeof out.prompt === "string" && !out.description) out.description = deriveDescription(out.prompt)
}

function pruneGeneratedEmptyKeys(value: Record<string, unknown>, op: string): Record<string, unknown> {
  const allowed = operationKeys[op as keyof typeof operationKeys]
  if (!allowed) return value
  const out = { ...value }
  if (op === "spawn") normalizeSpawnAliases(out)
  for (const [key, field] of Object.entries(out)) {
    if (allowed.has(key)) continue
    if (!knownRuntimeKeys.has(key)) continue

    // Result polling is often emitted from generic tool UIs that keep spawn/
    // lifecycle defaults in the payload (description/model/mode/etc.). Once
    // `op=result` is explicit, background_task_id + timeout_ms are the whole
    // contract; discard other known task-operation keys and keep rejecting
    // truly unknown keys below via the strict result schema.
    if (op === "result") {
      delete out[key]
      continue
    }

    if (isGeneratedEmptyValue(field)) delete out[key]
  }

  if (op === "spawn") {
    for (const key of spawnOptionalKeysThatMayBeGeneratedEmpty) {
      if (isGeneratedEmptyValue(out[key])) delete out[key]
    }

    // Tool-call generators sometimes include both the canonical `background`
    // field and legacy alias with the alias' false default. Treat the true
    // affirmative request as authoritative instead of rejecting the call as a
    // shape mismatch. The contract schema remains strict; this is runtime
    // input hygiene for generated no-op defaults.
    if (out.background === true && out.run_in_background === false) delete out.run_in_background
    if (out.run_in_background === true && out.background === false) delete out.background
  }

  return out
}

function normalizeTaskToolInput(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input
  const value = input as Record<string, unknown>
  const op = typeof value.op === "string" ? value.op : "spawn"
  return pruneGeneratedEmptyKeys({ ...value, op }, op)
}

function addIssue(ctx: z.RefinementCtx, path: (string | number)[], message: string) {
  ctx.addIssue({ code: z.ZodIssueCode.custom, path, message })
}

function validateSpawn(value: z.infer<typeof NormalizedTaskSpawnRuntimeParameters>, ctx: z.RefinementCtx) {
  if (
    value.background !== undefined &&
    value.run_in_background !== undefined &&
    value.background !== value.run_in_background
  ) {
    addIssue(ctx, ["run_in_background"], "Must match background when both are supplied")
  }
}

function validateResult(value: z.infer<typeof TaskResultRuntimeParameters>, ctx: z.RefinementCtx) {
  if (!value.background_task_id) {
    addIssue(ctx, ["background_task_id"], "Required for op=result")
  }
}

function validateTaskToolOperation(value: NormalizedTaskToolRuntimeParameters, ctx: z.RefinementCtx) {
  if (value.op === "spawn") validateSpawn(value, ctx)
  if (value.op === "result") validateResult(value, ctx)
}

export const TaskToolRuntimeParameters = z
  .preprocess(normalizeTaskToolInput, TaskToolOperationParameters)
  .superRefine(validateTaskToolOperation) as z.ZodType<TaskToolRuntimeParameters>

export function formatTaskToolValidationError(error: z.ZodError): string {
  const issues = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "<root>"
    return `- ${path}: ${issue.message}`
  })
  return [
    "Invalid task tool arguments. Use exactly one operation shape:",
    '- spawn: { "op": "spawn", "subagent_type": "planner|implementer|adviser|searcher|worker", "task": "plain-language task", "model": "provider:model" }',
    '- result: { "op": "result", "background_task_id": "...", "timeout_ms": 0 }',
    "- lifecycle/model: set op to that exact operation and pass only its fields.",
    "Schema issues:",
    ...issues,
  ].join("\n")
}
