import z from "zod"
export * from "@/provider/lsp/contract/version"
export * from "@/provider/lsp/contract/identity"
export * from "@/provider/lsp/contract/error"
export * from "@/provider/lsp/contract/event"
export * from "@/provider/lsp/contract/conformance"
import { LspContractVersion } from "@/provider/lsp/contract/version"

export const LspPortSchema = z.object({
  version: z.literal(LspContractVersion),
})

export type LspPortSchema = z.infer<typeof LspPortSchema>
