import z from "zod"

export const McpContractVersion = "1.0.0" as const
export const McpContractVersionSchema = z.literal(McpContractVersion)
export type McpContractVersion = z.infer<typeof McpContractVersionSchema>
