import z from "zod"
import { SkillContractVersionSchema } from "./version"

export const SkillModuleIdentitySchema = z.object({
  module: z.literal("skill"),
  layer: z.literal("runtime"),
  tier: z.literal("L3"),
  contractVersion: SkillContractVersionSchema,
})

export type SkillModuleIdentity = z.infer<typeof SkillModuleIdentitySchema>

export const SkillModuleIdentity: SkillModuleIdentity = {
  module: "skill",
  layer: "runtime",
  tier: "L3",
  contractVersion: "1.0.0",
}
