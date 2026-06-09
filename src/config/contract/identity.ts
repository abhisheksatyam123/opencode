import z from "zod"
import { ConfigContractVersionSchema } from "@/config/contract/version"

export const ConfigModuleIdentitySchema = z.object({
  module: z.literal("config"),
  layer: z.literal("platform"),
  tier: z.literal("L2"),
  contractVersion: ConfigContractVersionSchema,
})

export type ConfigModuleIdentity = z.infer<typeof ConfigModuleIdentitySchema>

export const ConfigModuleIdentity: ConfigModuleIdentity = {
  module: "config",
  layer: "platform",
  tier: "L2",
  contractVersion: "1.0.0",
}
