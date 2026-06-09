import z from "zod"

export const FormatContractErrorSchema = z.object({
  _tag: z.literal("FormatContractError"),
  message: z.string(),
})

export type FormatContractError = z.infer<typeof FormatContractErrorSchema>
