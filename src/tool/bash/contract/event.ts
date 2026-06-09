import z from "zod"

export const BashContractEventTypeSchema = z.enum([
  "bash.command.started",
  "bash.command.stdout",
  "bash.command.stderr",
  "bash.command.completed",
  "bash.command.failed",
])

export type BashContractEventType = z.infer<typeof BashContractEventTypeSchema>

export const BashContractEventSchema = z.object({
  type: BashContractEventTypeSchema,
  command: z.string().optional(),
  timestamp: z.number().int().nonnegative().optional(),
})

export type BashContractEvent = z.infer<typeof BashContractEventSchema>
