import z from "zod"

export const ACPContractErrorSchema = z.object({
  _tag: z.literal("ACPContractError"),
  message: z.string(),
})

export type ACPContractError = z.infer<typeof ACPContractErrorSchema>
