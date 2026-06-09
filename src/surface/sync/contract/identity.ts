import z from "zod"
import { SyncContractVersionSchema } from "@/surface/sync/contract/version"

export const SyncModuleIdentitySchema = z.object({
  module: z.literal("sync"),
  layer: z.literal("domain"),
  tier: z.literal("L4"),
  contractVersion: SyncContractVersionSchema,
})

export type SyncModuleIdentity = z.infer<typeof SyncModuleIdentitySchema>

export const SyncModuleIdentity: SyncModuleIdentity = {
  module: "sync",
  layer: "domain",
  tier: "L4",
  contractVersion: "1.0.0",
}
