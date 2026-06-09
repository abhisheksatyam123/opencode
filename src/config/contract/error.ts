import z from "zod"

export const ConfigContractErrorSchema = z.object({
  _tag: z.literal("ConfigContractError"),
  message: z.string(),
})

export type ConfigContractError = z.infer<typeof ConfigContractErrorSchema>
