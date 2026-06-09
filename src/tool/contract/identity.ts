import z from "zod"
import { ToolContractVersionSchema } from "@/tool/contract/version"

export const ToolModuleIdentitySchema = z.object({
  module: z.literal("tool"),
  layer: z.literal("runtime"),
  tier: z.literal("L3"),
  contractVersion: ToolContractVersionSchema,
})

export type ToolModuleIdentity = z.infer<typeof ToolModuleIdentitySchema>

export const ToolModuleIdentity: ToolModuleIdentity = {
  module: "tool",
  layer: "runtime",
  tier: "L3",
  contractVersion: "1.0.0",
}
