import z from "zod"

export const BashContractVersion = "1.0.0" as const
export const BashContractVersionSchema = z.literal(BashContractVersion)
export type BashContractVersion = z.infer<typeof BashContractVersionSchema>
