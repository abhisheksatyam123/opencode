import z from "zod"
import { TaskContractVersionSchema } from "@/tool/task/contract/version"

export const TaskModuleIdentitySchema = z.object({
  module: z.literal("tool/task"),
  layer: z.literal("runtime"),
  tier: z.literal("L3"),
  contractVersion: TaskContractVersionSchema,
})

export type TaskModuleIdentity = z.infer<typeof TaskModuleIdentitySchema>

export const TaskModuleIdentity: TaskModuleIdentity = {
  module: "tool/task",
  layer: "runtime",
  tier: "L3",
  contractVersion: "1.0.0",
}
