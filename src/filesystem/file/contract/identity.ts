import z from "zod"
import { FileContractVersionSchema } from "@/filesystem/file/contract/version"

export const FileModuleIdentitySchema = z.object({
  module: z.literal("file"),
  layer: z.literal("runtime"),
  tier: z.literal("L3"),
  contractVersion: FileContractVersionSchema,
})

export type FileModuleIdentity = z.infer<typeof FileModuleIdentitySchema>

export const FileModuleIdentity: FileModuleIdentity = {
  module: "file",
  layer: "runtime",
  tier: "L3",
  contractVersion: "1.0.0",
}
