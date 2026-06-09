import z from "zod"

export const SkillContractEventTypeSchema = z.enum([
  "skill.loaded",
  "skill.duplicate.detected",
  "skill.discovery.failed",
])

export type SkillContractEventType = z.infer<typeof SkillContractEventTypeSchema>

export const SkillContractEventSchema = z.object({
  type: SkillContractEventTypeSchema,
  skill: z.string().optional(),
  path: z.string().optional(),
  timestamp: z.number().int().nonnegative().optional(),
})

export type SkillContractEvent = z.infer<typeof SkillContractEventSchema>
