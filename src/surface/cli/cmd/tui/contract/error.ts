import z from "zod"

export const TuiContractErrorSchema = z.object({
  _tag: z.literal("TuiContractError"),
  message: z.string(),
})

export type TuiContractError = z.infer<typeof TuiContractErrorSchema>
