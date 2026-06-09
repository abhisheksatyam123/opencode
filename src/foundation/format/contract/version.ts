import z from "zod"

export const FormatContractVersion = "1.0.0" as const
export const FormatContractVersionSchema = z.literal(FormatContractVersion)
export type FormatContractVersion = z.infer<typeof FormatContractVersionSchema>
