import z from "zod"

export const ToolContractVersion = "1.0.0" as const
export const ToolContractVersionSchema = z.literal(ToolContractVersion)
export type ToolContractVersion = z.infer<typeof ToolContractVersionSchema>
