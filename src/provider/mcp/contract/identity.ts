import z from "zod"
import { McpContractVersionSchema } from "./version"

export const McpModuleIdentitySchema = z.object({
  module: z.literal("mcp"),
  layer: z.literal("runtime"),
  tier: z.literal("L3"),
  contractVersion: McpContractVersionSchema,
})

export type McpModuleIdentity = z.infer<typeof McpModuleIdentitySchema>

export const McpModuleIdentity: McpModuleIdentity = {
  module: "mcp",
  layer: "runtime",
  tier: "L3",
  contractVersion: "1.0.0",
}
