import z from "zod"

export const ACPContractEventTypeSchema = z.enum(["acp.session.created", "acp.session.updated", "acp.session.deleted"])
export type ACPContractEventType = z.infer<typeof ACPContractEventTypeSchema>

export const ACPContractEventSchema = z.object({
  type: ACPContractEventTypeSchema,
  sessionID: z.string().min(1),
  timestamp: z.number().int().nonnegative().optional(),
})

export type ACPContractEvent = z.infer<typeof ACPContractEventSchema>
