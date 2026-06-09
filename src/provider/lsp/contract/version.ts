import z from "zod"

export const LspContractVersion = "1.0.0" as const
export const LspContractVersionSchema = z.literal(LspContractVersion)
export type LspContractVersion = z.infer<typeof LspContractVersionSchema>
