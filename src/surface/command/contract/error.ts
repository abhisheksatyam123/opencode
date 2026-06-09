import z from "zod"

export const CommandContractErrorSchema = z.object({
  _tag: z.literal("CommandContractError"),
  message: z.string(),
})

export type CommandContractError = z.infer<typeof CommandContractErrorSchema>
