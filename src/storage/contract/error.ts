import z from "zod"

export const StorageNotFoundErrorSchema = z.object({
  _tag: z.literal("NotFoundError"),
  message: z.string(),
})

export type StorageNotFoundError = z.infer<typeof StorageNotFoundErrorSchema>
