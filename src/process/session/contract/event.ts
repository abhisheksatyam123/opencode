import z from "zod"

export const SessionContractEventTypeSchema = z.enum(["session.requested", "session.updated", "session.failed"])

export type SessionContractEventType = z.infer<typeof SessionContractEventTypeSchema>

export const SessionContractEventSchema = z.object({
  type: SessionContractEventTypeSchema,
  timestamp: z.number().int().nonnegative().optional(),
})

export type SessionContractEvent = z.infer<typeof SessionContractEventSchema>
