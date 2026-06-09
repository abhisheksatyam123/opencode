import z from "zod"

export const FilesystemContractVersion = "1.0.0" as const
export const FilesystemContractVersionSchema = z.literal(FilesystemContractVersion)
export type FilesystemContractVersion = z.infer<typeof FilesystemContractVersionSchema>
