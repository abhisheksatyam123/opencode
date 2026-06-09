import z from "zod"

export const FileContractErrorSchema = z.object({
  _tag: z.literal("FileContractError"),
  message: z.string(),
})

export type FileContractError = z.infer<typeof FileContractErrorSchema>
