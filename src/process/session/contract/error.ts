import z from "zod"

export const SessionContractErrorSchema = z.object({
  _tag: z.literal("SessionContractError"),
  message: z.string(),
})

export type SessionContractError = z.infer<typeof SessionContractErrorSchema>
