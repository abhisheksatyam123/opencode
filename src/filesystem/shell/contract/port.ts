import z from "zod"
export * from "./version"
export * from "./identity"
export * from "./error"
export * from "./event"
export * from "./conformance"
import { ShellContractVersion } from "./version"

export const ShellPortSchema = z.object({
  version: z.literal(ShellContractVersion),
})

export type ShellPortSchema = z.infer<typeof ShellPortSchema>
