import z from "zod"
export * from "./version"
export * from "./identity"
export * from "./error"
export * from "./event"
export * from "./conformance"
import { SkillContractVersion } from "./version"

export const SkillPortSchema = z.object({
  version: z.literal(SkillContractVersion),
})

export type SkillPortSchema = z.infer<typeof SkillPortSchema>
