import z from "zod"

export const FormatContractEventTypeSchema = z.enum([
  "format.requested",
  "format.updated",
  "format.failed",
])

export type FormatContractEventType = z.infer<typeof FormatContractEventTypeSchema>

export const FormatContractEventSchema = z.object({
  type: FormatContractEventTypeSchema,
  timestamp: z.number().int().nonnegative().optional(),
})

export type FormatContractEvent = z.infer<typeof FormatContractEventSchema>
