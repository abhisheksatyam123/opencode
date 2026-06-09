import z from "zod"

export const ProviderContractVersion = "1.0.0" as const
export const ProviderContractVersionSchema = z.literal(ProviderContractVersion)
export type ProviderContractVersion = z.infer<typeof ProviderContractVersionSchema>
