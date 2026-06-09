import z from "zod"
import { FileContractVersionSchema } from "@/filesystem/file/contract/version"

export const FileConformanceSchema = z.object({
  module: z.literal("file"),
  contractVersion: FileContractVersionSchema,
  guarantees: z.array(z.string().min(1)).min(1),
})

export type FileConformance = z.infer<typeof FileConformanceSchema>

export const FileConformance: FileConformance = {
  module: "file",
  contractVersion: "1.0.0",
  guarantees: ["contract-versioned", "module-identity-declared", "event-envelope-declared"],
}
