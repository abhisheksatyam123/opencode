import z from "zod"

export const SkillContractErrorSchema = z.object({
  _tag: z.literal("SkillContractError"),
  message: z.string(),
})

export type SkillContractError = z.infer<typeof SkillContractErrorSchema>
