import z from "zod"

export const McpContractErrorSchema = z.object({
  _tag: z.literal("McpContractError"),
  message: z.string(),
})

export type McpContractError = z.infer<typeof McpContractErrorSchema>
