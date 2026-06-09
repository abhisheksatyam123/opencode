import z from "zod"

export const TaskContractErrorSchema = z.object({
  _tag: z.literal("TaskContractError"),
  message: z.string(),
})

export type TaskContractError = z.infer<typeof TaskContractErrorSchema>
