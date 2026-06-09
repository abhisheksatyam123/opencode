import z from "zod"

export const InitContractErrorSchema = z.object({
  _tag: z.literal("InitContractError"),
  message: z.string(),
})

export type InitContractError = z.infer<typeof InitContractErrorSchema>
