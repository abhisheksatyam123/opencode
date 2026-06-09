import z from "zod"

export const CardContractErrorSchema = z.object({
  _tag: z.literal("CardContractError"),
  message: z.string(),
})

export type CardContractError = z.infer<typeof CardContractErrorSchema>
