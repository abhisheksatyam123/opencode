import z from "zod"

export const ProviderContractEventTypeSchema = z.enum([
  "provider.requested",
  "provider.updated",
  "provider.failed",
])

export type ProviderContractEventType = z.infer<typeof ProviderContractEventTypeSchema>

export const ProviderContractEventSchema = z.object({
  type: ProviderContractEventTypeSchema,
  timestamp: z.number().int().nonnegative().optional(),
})

export type ProviderContractEvent = z.infer<typeof ProviderContractEventSchema>
