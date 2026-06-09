import z from "zod"

export const SurfaceContractErrorSchema = z.object({
  _tag: z.literal("SurfaceContractError"),
  message: z.string(),
})

export type SurfaceContractError = z.infer<typeof SurfaceContractErrorSchema>
