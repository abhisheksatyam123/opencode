import z from "zod"

export const ToolContractErrorSchema = z.object({
  _tag: z.literal("ToolContractError"),
  message: z.string(),
})

export type ToolContractError = z.infer<typeof ToolContractErrorSchema>
