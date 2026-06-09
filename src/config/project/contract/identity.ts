import z from "zod"
import { ProjectContractVersionSchema } from "@/config/project/contract/version"

export const ProjectModuleIdentitySchema = z.object({
  module: z.literal("project"),
  layer: z.literal("domain"),
  tier: z.literal("L4"),
  contractVersion: ProjectContractVersionSchema,
})

export type ProjectModuleIdentity = z.infer<typeof ProjectModuleIdentitySchema>

export const ProjectModuleIdentity: ProjectModuleIdentity = {
  module: "project",
  layer: "domain",
  tier: "L4",
  contractVersion: "1.0.0",
}
