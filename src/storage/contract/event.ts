import z from "zod"

const StorageEventKeySchema = z.array(z.string().min(1)).min(1)

export const StorageEventTypeSchema = z.enum([
  "storage.read",
  "storage.write",
  "storage.update",
  "storage.remove",
  "storage.list",
])
export type StorageEventType = z.infer<typeof StorageEventTypeSchema>

export const StorageEventSchema = z.object({
  type: StorageEventTypeSchema,
  key: StorageEventKeySchema,
  timestamp: z.number().int().nonnegative().optional(),
})

export type StorageEvent = z.infer<typeof StorageEventSchema>
