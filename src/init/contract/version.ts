import z from "zod"

export const InitContractVersion = "1.0.0" as const
export const InitContractVersionSchema = z.literal(InitContractVersion)
export type InitContractVersion = z.infer<typeof InitContractVersionSchema>
