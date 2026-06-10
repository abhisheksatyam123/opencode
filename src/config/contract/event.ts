import z from "zod"

export const ConfigContractEventTypeSchema = z.enum(["config.requested", "config.updated", "config.failed"])

export type ConfigContractEventType = z.infer<typeof ConfigContractEventTypeSchema>

export const ConfigContractEventSchema = z.object({
  type: ConfigContractEventTypeSchema,
  timestamp: z.number().int().nonnegative().optional(),
})

export type ConfigContractEvent = z.infer<typeof ConfigContractEventSchema>
