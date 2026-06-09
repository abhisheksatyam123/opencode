import z from "zod"

export const FileContractVersion = "1.0.0" as const
export const FileContractVersionSchema = z.literal(FileContractVersion)
export type FileContractVersion = z.infer<typeof FileContractVersionSchema>
