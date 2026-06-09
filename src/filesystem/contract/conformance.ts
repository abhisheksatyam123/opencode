import z from "zod"
import { FilesystemContractVersionSchema } from "@/filesystem/contract/version"

export const FilesystemConformanceSchema = z.object({
  module: z.literal("filesystem"),
  contractVersion: FilesystemContractVersionSchema,
  guarantees: z.array(z.string().min(1)).min(1),
})

export type FilesystemConformance = z.infer<typeof FilesystemConformanceSchema>

export const FilesystemConformance: FilesystemConformance = {
  module: "filesystem",
  contractVersion: "1.0.0",
  guarantees: ["typed-dir-entry-schema", "glob-and-findup-surface", "effect-tag-stability"],
}
