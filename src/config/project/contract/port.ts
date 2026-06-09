import z from "zod"
export * from "@/config/project/contract/version"
export * from "@/config/project/contract/identity"
export * from "@/config/project/contract/error"
export * from "@/config/project/contract/event"
export * from "@/config/project/contract/conformance"
import { ProjectContractVersion } from "@/config/project/contract/version"

export const ProjectPortSchema = z.object({
  version: z.literal(ProjectContractVersion),
})

export type ProjectPortSchema = z.infer<typeof ProjectPortSchema>
