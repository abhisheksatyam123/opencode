import z from "zod"
import { ServiceMap } from "effect"
export * from "@/tool/task/contract/version"
export * from "@/tool/task/contract/identity"
export * from "@/tool/task/contract/error"
export * from "@/tool/task/contract/event"
export * from "@/tool/task/contract/conformance"
import { TaskContractVersion } from "@/tool/task/contract/version"

import {
  ensureBudget,
  incrementBudget,
  readBudget,
  type BudgetEntry,
} from "@/tool/task/budget"

export const TaskPortSchema = z.object({
  version: z.literal(TaskContractVersion),
})
export type TaskPortSchema = z.infer<typeof TaskPortSchema>

export interface TaskPort {}

export namespace Task {
  export class Service extends ServiceMap.Service<Service, TaskPort>()("@opencode/ToolTask") {}
}

export {
  readBudget,
  ensureBudget,
  incrementBudget,
}

export type { BudgetEntry }
