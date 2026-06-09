import z from "zod"

export const LspContractErrorSchema = z.object({
  _tag: z.literal("LspContractError"),
  message: z.string(),
})

export type LspContractError = z.infer<typeof LspContractErrorSchema>
