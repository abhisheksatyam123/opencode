import z from "zod"
import { BusContractVersionSchema } from "@/bus/contract/version"

export const BusModuleIdentitySchema = z.object({
  module: z.literal("bus"),
  layer: z.literal("infrastructure"),
  tier: z.literal("L1"),
  contractVersion: BusContractVersionSchema,
})

export type BusModuleIdentity = z.infer<typeof BusModuleIdentitySchema>

export const BusModuleIdentity: BusModuleIdentity = {
  module: "bus",
  layer: "infrastructure",
  tier: "L1",
  contractVersion: "1.0.0",
}
