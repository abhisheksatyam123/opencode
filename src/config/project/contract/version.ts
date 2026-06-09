import z from "zod"

export const ProjectContractVersion = "1.0.0" as const
export const ProjectContractVersionSchema = z.literal(ProjectContractVersion)
export type ProjectContractVersion = z.infer<typeof ProjectContractVersionSchema>
