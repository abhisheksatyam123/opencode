import z from "zod"
import { CardContractVersionSchema } from "@/tool/card/contract/version"

export const CardModuleIdentitySchema = z.object({
  module: z.literal("tool/card"),
  layer: z.literal("runtime"),
  tier: z.literal("L3"),
  contractVersion: CardContractVersionSchema,
})

export type CardModuleIdentity = z.infer<typeof CardModuleIdentitySchema>

export const CardModuleIdentity: CardModuleIdentity = {
  module: "tool/card",
  layer: "runtime",
  tier: "L3",
  contractVersion: "1.0.0",
}
