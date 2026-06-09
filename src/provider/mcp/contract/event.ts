import z from "zod"

export const McpContractEventTypeSchema = z.enum(["mcp.disabled"])

export type McpContractEventType = z.infer<typeof McpContractEventTypeSchema>

export const McpContractEventSchema = z.object({
  type: McpContractEventTypeSchema,
  timestamp: z.number().int().nonnegative().optional(),
})

export type McpContractEvent = z.infer<typeof McpContractEventSchema>
