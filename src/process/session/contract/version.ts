import z from "zod"

export const SessionContractVersion = "1.0.0" as const
export const SessionContractVersionSchema = z.literal(SessionContractVersion)
export type SessionContractVersion = z.infer<typeof SessionContractVersionSchema>
