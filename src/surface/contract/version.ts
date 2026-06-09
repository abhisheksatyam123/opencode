import z from "zod"

export const SurfaceContractVersion = "1.0.0" as const
export const SurfaceContractVersionSchema = z.literal(SurfaceContractVersion)
export type SurfaceContractVersion = z.infer<typeof SurfaceContractVersionSchema>
