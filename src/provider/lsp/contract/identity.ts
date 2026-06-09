import z from "zod"
import { LspContractVersionSchema } from "@/provider/lsp/contract/version"

export const LspModuleIdentitySchema = z.object({
  module: z.literal("lsp"),
  layer: z.literal("runtime"),
  tier: z.literal("L3"),
  contractVersion: LspContractVersionSchema,
})

export type LspModuleIdentity = z.infer<typeof LspModuleIdentitySchema>

export const LspModuleIdentity: LspModuleIdentity = {
  module: "lsp",
  layer: "runtime",
  tier: "L3",
  contractVersion: "1.0.0",
}
