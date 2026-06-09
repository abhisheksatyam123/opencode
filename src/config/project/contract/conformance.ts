import z from "zod"
import { ProjectContractVersionSchema } from "@/config/project/contract/version"

export const ProjectConformanceSchema = z.object({
  module: z.literal("project"),
  contractVersion: ProjectContractVersionSchema,
  guarantees: z.array(z.string().min(1)).min(1),
})

export type ProjectConformance = z.infer<typeof ProjectConformanceSchema>

export const ProjectConformance: ProjectConformance = {
  module: "project",
  contractVersion: "1.0.0",
  guarantees: ["contract-versioned", "module-identity-declared", "event-envelope-declared"],
}
