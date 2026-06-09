import z from "zod"
export * from "./version"
export * from "./identity"
export * from "./error"
export * from "./event"
export * from "./conformance"
import { CommandContractVersion } from "./version"

export const CommandPortSchema = z.object({
  version: z.literal(CommandContractVersion),
})

export type CommandPortSchema = z.infer<typeof CommandPortSchema>
