import z from "zod"
import { LspContractVersionSchema } from "@/provider/lsp/contract/version"

export const LspConformanceSchema = z.object({
  module: z.literal("lsp"),
  contractVersion: LspContractVersionSchema,
  guarantees: z.array(z.string().min(1)).min(1),
})

export type LspConformance = z.infer<typeof LspConformanceSchema>

export const LspConformance: LspConformance = {
  module: "lsp",
  contractVersion: "1.0.0",
  guarantees: ["contract-versioned", "diagnostics-surface", "symbols-surface", "call-hierarchy-surface"],
}
