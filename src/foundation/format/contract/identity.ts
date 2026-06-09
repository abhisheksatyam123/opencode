import z from "zod"
import { FormatContractVersionSchema } from "./version"

export const FormatModuleIdentitySchema = z.object({
  module: z.literal("format"),
  layer: z.literal("runtime"),
  tier: z.literal("L3"),
  contractVersion: FormatContractVersionSchema,
})

export type FormatModuleIdentity = z.infer<typeof FormatModuleIdentitySchema>

export const FormatModuleIdentity: FormatModuleIdentity = {
  module: "format",
  layer: "runtime",
  tier: "L3",
  contractVersion: "1.0.0",
}
