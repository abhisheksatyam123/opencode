import z from "zod"

export const TuiContractVersion = "1.0.0" as const
export const TuiContractVersionSchema = z.literal(TuiContractVersion)
export type TuiContractVersion = z.infer<typeof TuiContractVersionSchema>
