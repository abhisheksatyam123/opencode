import z from "zod"
import { BusContractVersionSchema } from "@/bus/contract/version"

export const BusConformanceSchema = z.object({
  module: z.literal("bus"),
  contractVersion: BusContractVersionSchema,
  guarantees: z.array(z.string().min(1)).min(1),
})

export type BusConformance = z.infer<typeof BusConformanceSchema>

export const BusConformance: BusConformance = {
  module: "bus",
  contractVersion: "1.0.0",
  guarantees: ["typed-event-definition", "publish-subscribe-surface", "wildcard-subscribe-surface"],
}
