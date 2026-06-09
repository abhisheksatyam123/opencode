import z from "zod"

export const TaskContractVersion = "1.0.0" as const
export const TaskContractVersionSchema = z.literal(TaskContractVersion)
export type TaskContractVersion = z.infer<typeof TaskContractVersionSchema>
