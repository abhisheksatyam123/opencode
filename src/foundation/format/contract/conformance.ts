import z from "zod"
import { FormatContractVersionSchema } from "./version"

export const FormatConformanceSchema = z.object({
  module: z.literal("format"),
  contractVersion: FormatContractVersionSchema,
  guarantees: z.array(z.string().min(1)).min(1),
})

export type FormatConformance = z.infer<typeof FormatConformanceSchema>

export const FormatConformance: FormatConformance = {
  module: "format",
  contractVersion: "1.0.0",
  guarantees: ["contract-versioned", "module-identity-declared", "event-envelope-declared"],
}
