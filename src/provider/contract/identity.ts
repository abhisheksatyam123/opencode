import z from "zod"
import { ProviderContractVersionSchema } from "@/provider/contract/version"

export const ProviderModuleIdentitySchema = z.object({
  module: z.literal("provider"),
  layer: z.literal("platform"),
  tier: z.literal("L2"),
  contractVersion: ProviderContractVersionSchema,
})

export type ProviderModuleIdentity = z.infer<typeof ProviderModuleIdentitySchema>

export const ProviderModuleIdentity: ProviderModuleIdentity = {
  module: "provider",
  layer: "platform",
  tier: "L2",
  contractVersion: "1.0.0",
}
