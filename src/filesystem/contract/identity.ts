import z from "zod"
import { FilesystemContractVersionSchema } from "@/filesystem/contract/version"

export const FilesystemModuleIdentitySchema = z.object({
  module: z.literal("filesystem"),
  layer: z.literal("infrastructure"),
  tier: z.literal("L1"),
  contractVersion: FilesystemContractVersionSchema,
})

export type FilesystemModuleIdentity = z.infer<typeof FilesystemModuleIdentitySchema>

export const FilesystemModuleIdentity: FilesystemModuleIdentity = {
  module: "filesystem",
  layer: "infrastructure",
  tier: "L1",
  contractVersion: "1.0.0",
}
