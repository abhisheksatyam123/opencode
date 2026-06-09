import z from "zod"

export const ProjectContractEventTypeSchema = z.enum([
  "project.requested",
  "project.updated",
  "project.failed",
])

export type ProjectContractEventType = z.infer<typeof ProjectContractEventTypeSchema>

export const ProjectContractEventSchema = z.object({
  type: ProjectContractEventTypeSchema,
  timestamp: z.number().int().nonnegative().optional(),
})

export type ProjectContractEvent = z.infer<typeof ProjectContractEventSchema>
