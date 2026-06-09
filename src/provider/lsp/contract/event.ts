import z from "zod"

export const LspContractEventTypeSchema = z.enum([
  "lsp.initialized",
  "lsp.status.changed",
  "lsp.diagnostics.updated",
])

export type LspContractEventType = z.infer<typeof LspContractEventTypeSchema>

export const LspContractEventSchema = z.object({
  type: LspContractEventTypeSchema,
  file: z.string().optional(),
  timestamp: z.number().int().nonnegative().optional(),
})

export type LspContractEvent = z.infer<typeof LspContractEventSchema>
