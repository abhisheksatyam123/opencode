import z from "zod"

export const SyncContractErrorSchema = z.object({
  _tag: z.literal("SyncContractError"),
  message: z.string(),
})

export type SyncContractError = z.infer<typeof SyncContractErrorSchema>
