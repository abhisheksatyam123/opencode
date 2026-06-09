import z from "zod"

export const SkillContractVersion = "1.0.0" as const
export const SkillContractVersionSchema = z.literal(SkillContractVersion)
export type SkillContractVersion = z.infer<typeof SkillContractVersionSchema>
