import z from "zod"

export const CommandContractEventTypeSchema = z.enum([
  "command.requested",
  "command.updated",
  "command.failed",
])

export type CommandContractEventType = z.infer<typeof CommandContractEventTypeSchema>

export const CommandContractEventSchema = z.object({
  type: CommandContractEventTypeSchema,
  timestamp: z.number().int().nonnegative().optional(),
})

export type CommandContractEvent = z.infer<typeof CommandContractEventSchema>
