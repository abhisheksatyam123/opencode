import z from "zod"

export const SyncContractVersion = "1.0.0" as const
export const SyncContractVersionSchema = z.literal(SyncContractVersion)
export type SyncContractVersion = z.infer<typeof SyncContractVersionSchema>
