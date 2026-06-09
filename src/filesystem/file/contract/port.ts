import z from "zod"
export * from "@/filesystem/file/contract/version"
export * from "@/filesystem/file/contract/identity"
export * from "@/filesystem/file/contract/error"
export * from "@/filesystem/file/contract/event"
export * from "@/filesystem/file/contract/conformance"
import { FileContractVersion } from "@/filesystem/file/contract/version"

export const FilePortSchema = z.object({
  version: z.literal(FileContractVersion),
})

export type FilePortSchema = z.infer<typeof FilePortSchema>
