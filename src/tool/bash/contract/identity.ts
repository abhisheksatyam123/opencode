import z from "zod"
import { BashContractVersionSchema } from "@/tool/bash/contract/version"

export const BashModuleIdentitySchema = z.object({
  module: z.literal("tool/bash"),
  layer: z.literal("runtime"),
  tier: z.literal("L3"),
  contractVersion: BashContractVersionSchema,
})

export type BashModuleIdentity = z.infer<typeof BashModuleIdentitySchema>

export const BashModuleIdentity: BashModuleIdentity = {
  module: "tool/bash",
  layer: "runtime",
  tier: "L3",
  contractVersion: "1.0.0",
}
