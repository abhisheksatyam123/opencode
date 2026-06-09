import z from "zod"
export * from "./version"
export * from "./identity"
export * from "./error"
export * from "./event"
export * from "./conformance"
import { FormatContractVersion } from "./version"

export const FormatPortSchema = z.object({
  version: z.literal(FormatContractVersion),
})

export type FormatPortSchema = z.infer<typeof FormatPortSchema>
