import z from "zod"
import { TaskContractVersionSchema } from "@/tool/task/contract/version"

export const TaskConformanceSchema = z.object({
  module: z.literal("tool/task"),
  contractVersion: TaskContractVersionSchema,
  guarantees: z.array(z.string().min(1)).min(1),
})

export type TaskConformance = z.infer<typeof TaskConformanceSchema>

export const TaskConformance: TaskConformance = {
  module: "tool/task",
  contractVersion: "1.0.0",
  guarantees: [
    "plain-language-subagent-spawn",
    "multiagent-delegation-model-selection",
    "async-background-result-polling",
    "parent-visible-running-children",
    "parent-visible-child-failures",
  ],
}
