import z from "zod"
export * from "@/process/session/contract/version"
export * from "@/process/session/contract/identity"
export * from "@/process/session/contract/error"
export * from "@/process/session/contract/event"
export * from "@/process/session/contract/conformance"
import { SessionContractVersion } from "@/process/session/contract/version"

export const SessionPortSchema = z.object({
  version: z.literal(SessionContractVersion),
})

export type SessionPortSchema = z.infer<typeof SessionPortSchema>
