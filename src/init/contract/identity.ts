import z from "zod"
import { InitContractVersionSchema } from "@/init/contract/version"

export const InitModuleIdentitySchema = z.object({
  module: z.literal("init"),
  layer: z.literal("interface"),
  tier: z.literal("L5"),
  contractVersion: InitContractVersionSchema,
})

export type InitModuleIdentity = z.infer<typeof InitModuleIdentitySchema>

export const InitModuleIdentity: InitModuleIdentity = {
  module: "init",
  layer: "interface",
  tier: "L5",
  contractVersion: "1.0.0",
}
