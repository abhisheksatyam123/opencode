import z from "zod"

export const BashContractErrorSchema = z.object({
  _tag: z.literal("BashContractError"),
  message: z.string(),
})

export type BashContractError = z.infer<typeof BashContractErrorSchema>
