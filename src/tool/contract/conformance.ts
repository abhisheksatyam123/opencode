import z from "zod"
import { ToolContractVersionSchema } from "@/tool/contract/version"

export const ToolConformanceSchema = z.object({
  module: z.literal("tool"),
  contractVersion: ToolContractVersionSchema,
  guarantees: z.array(z.string().min(1)).min(1),
})

export type ToolConformance = z.infer<typeof ToolConformanceSchema>

export const ToolConformance: ToolConformance = {
  module: "tool",
  contractVersion: "1.0.0",
  guarantees: ["registry-surface", "tool-definition-surface", "effect-service-tag"],
}
