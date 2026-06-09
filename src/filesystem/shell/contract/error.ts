import z from "zod"

export const ShellContractErrorSchema = z.object({
  _tag: z.literal("ShellContractError"),
  message: z.string(),
})

export type ShellContractError = z.infer<typeof ShellContractErrorSchema>
