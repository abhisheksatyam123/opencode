import z from "zod"

export const StorageContractVersion = "1.0.0" as const
export const StorageContractVersionSchema = z.literal(StorageContractVersion)
export type StorageContractVersion = z.infer<typeof StorageContractVersionSchema>
