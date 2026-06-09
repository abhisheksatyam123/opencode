import z from "zod"

export const ProviderContractErrorSchema = z.object({
  _tag: z.literal("ProviderContractError"),
  message: z.string(),
})

export type ProviderContractError = z.infer<typeof ProviderContractErrorSchema>
