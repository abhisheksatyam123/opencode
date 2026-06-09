import z from "zod"

export const InitContractEventTypeSchema = z.enum([
  "init.boot.started",
  "init.boot.completed",
  "init.install.requested",
  "init.auth.requested",
])

export type InitContractEventType = z.infer<typeof InitContractEventTypeSchema>

export const InitContractEventSchema = z.object({
  type: InitContractEventTypeSchema,
  target: z.string().optional(),
  timestamp: z.number().int().nonnegative().optional(),
})

export type InitContractEvent = z.infer<typeof InitContractEventSchema>
