import z from "zod"

export const ACPContractVersion = "1.0.0" as const
export const ACPContractVersionSchema = z.literal(ACPContractVersion)
export type ACPContractVersion = z.infer<typeof ACPContractVersionSchema>
