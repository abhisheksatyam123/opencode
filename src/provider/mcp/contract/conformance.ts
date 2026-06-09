import z from "zod"
import { McpContractVersionSchema } from "./version"

export const McpConformanceSchema = z.object({
  module: z.literal("mcp"),
  contractVersion: McpContractVersionSchema,
  guarantees: z.array(z.string().min(1)).min(1),
})

export type McpConformance = z.infer<typeof McpConformanceSchema>

export const McpConformance: McpConformance = {
  module: "mcp",
  contractVersion: "1.0.0",
  guarantees: ["contract-versioned", "disabled-status-surface"],
}
