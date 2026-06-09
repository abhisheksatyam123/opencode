import z from "zod"

export const ProjectContractErrorSchema = z.object({
  _tag: z.literal("ProjectContractError"),
  message: z.string(),
})

export type ProjectContractError = z.infer<typeof ProjectContractErrorSchema>
