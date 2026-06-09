import z from "zod"

export const BusContractEventTypeSchema = z.enum([
  "subagent.pause",
  "subagent.paused",
  "subagent.resume",
  "subagent.resumed",
  "subagent.model.change",
  "subagent.model.changed",
  "server.instance.disposed",
])

export type BusContractEventType = z.infer<typeof BusContractEventTypeSchema>

export const BusContractEventSchema = z.object({
  type: BusContractEventTypeSchema,
  properties: z.record(z.string(), z.unknown()),
})

export type BusContractEvent = z.infer<typeof BusContractEventSchema>
