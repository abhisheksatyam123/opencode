import z from "zod"

export const BusContractVersion = "1.0.0" as const
export const BusContractVersionSchema = z.literal(BusContractVersion)
export type BusContractVersion = z.infer<typeof BusContractVersionSchema>
