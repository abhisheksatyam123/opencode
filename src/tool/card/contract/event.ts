import z from "zod"

export const CardContractEventTypeSchema = z.enum([
  "tool.card.requested",
  "tool.card.completed",
  "tool.card.failed",
])

export type CardContractEventType = z.infer<typeof CardContractEventTypeSchema>

export const CardContractEventSchema = z.object({
  type: CardContractEventTypeSchema,
  timestamp: z.number().int().nonnegative().optional(),
})

export type CardContractEvent = z.infer<typeof CardContractEventSchema>
