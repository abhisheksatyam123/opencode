import z from "zod"
import { ACPContractVersionSchema } from "@/surface/acp/contract/version"

export const ACPModuleIdentitySchema = z.object({
  module: z.literal("acp"),
  layer: z.literal("interface"),
  tier: z.literal("L5"),
  contractVersion: ACPContractVersionSchema,
})

export type ACPModuleIdentity = z.infer<typeof ACPModuleIdentitySchema>

export const ACPModuleIdentity: ACPModuleIdentity = {
  module: "acp",
  layer: "interface",
  tier: "L5",
  contractVersion: "1.0.0",
}
