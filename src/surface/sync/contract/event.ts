import z from "zod"

export const SyncContractEventSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  aggregate: z.string().min(1),
  aggregateID: z.string().min(1),
  seq: z.number().int().nonnegative(),
  version: z.number().int().nonnegative(),
  data: z.record(z.string(), z.unknown()),
})

export type SyncContractEvent = z.infer<typeof SyncContractEventSchema>
