import z from "zod"
export * from "@/tool/bash/contract/version"
export * from "@/tool/bash/contract/identity"
export * from "@/tool/bash/contract/error"
export * from "@/tool/bash/contract/event"
export * from "@/tool/bash/contract/conformance"
import { BashContractVersion } from "@/tool/bash/contract/version"

export const BashModeSchema = z.enum(["run", "background", "list", "status", "kill", "cleanup", "remove"])
export type BashMode = z.infer<typeof BashModeSchema>

export const BashToolPortSchema = z.object({
  version: z.literal(BashContractVersion),
})
export type BashToolPortSchema = z.infer<typeof BashToolPortSchema>
