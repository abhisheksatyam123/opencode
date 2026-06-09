import z from "zod"

export const CommandContractVersion = "1.0.0" as const
export const CommandContractVersionSchema = z.literal(CommandContractVersion)
export type CommandContractVersion = z.infer<typeof CommandContractVersionSchema>
