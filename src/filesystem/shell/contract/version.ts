import z from "zod"

export const ShellContractVersion = "1.0.0" as const
export const ShellContractVersionSchema = z.literal(ShellContractVersion)
export type ShellContractVersion = z.infer<typeof ShellContractVersionSchema>
