import z from "zod"

export const ToolContractEventTypeSchema = z.enum([
  "tool.registry.loaded",
  "tool.definition.resolved",
  "tool.execution.started",
  "tool.execution.completed",
  "tool.execution.failed",
])

export type ToolContractEventType = z.infer<typeof ToolContractEventTypeSchema>

export const ToolContractEventSchema = z.object({
  type: ToolContractEventTypeSchema,
  tool: z.string().optional(),
  timestamp: z.number().int().nonnegative().optional(),
})

export type ToolContractEvent = z.infer<typeof ToolContractEventSchema>
