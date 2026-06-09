import z from "zod"

export const ConfigContractVersion = "1.0.0" as const
export const ConfigContractVersionSchema = z.literal(ConfigContractVersion)
export type ConfigContractVersion = z.infer<typeof ConfigContractVersionSchema>
