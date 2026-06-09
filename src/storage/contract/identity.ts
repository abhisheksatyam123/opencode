import z from "zod"
import { StorageContractVersionSchema } from "@/storage/contract/version"

export const StorageModuleIdentitySchema = z.object({
  module: z.literal("storage"),
  layer: z.literal("infrastructure"),
  tier: z.literal("L1"),
  contractVersion: StorageContractVersionSchema,
})

export type StorageModuleIdentity = z.infer<typeof StorageModuleIdentitySchema>

export const StorageModuleIdentity: StorageModuleIdentity = {
  module: "storage",
  layer: "infrastructure",
  tier: "L1",
  contractVersion: "1.0.0",
}
