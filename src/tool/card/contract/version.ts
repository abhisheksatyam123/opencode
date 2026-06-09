import z from "zod"

export const CardContractVersion = "1.0.0" as const
export const CardContractVersionSchema = z.literal(CardContractVersion)
export type CardContractVersion = z.infer<typeof CardContractVersionSchema>
