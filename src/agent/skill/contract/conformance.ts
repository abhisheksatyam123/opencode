import z from "zod"
import { SkillContractVersionSchema } from "./version"

export const SkillConformanceSchema = z.object({
  module: z.literal("skill"),
  contractVersion: SkillContractVersionSchema,
  guarantees: z.array(z.string().min(1)).min(1),
})

export type SkillConformance = z.infer<typeof SkillConformanceSchema>

export const SkillConformance: SkillConformance = {
  module: "skill",
  contractVersion: "1.0.0",
  guarantees: ["contract-versioned", "skill-discovery-surface", "permission-filtered-availability-surface"],
}
