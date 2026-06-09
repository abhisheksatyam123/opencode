import z from "zod"

export const FilesystemContractEventTypeSchema = z.enum([
  "filesystem.read",
  "filesystem.write",
  "filesystem.remove",
  "filesystem.mkdir",
  "filesystem.glob",
])

export type FilesystemContractEventType = z.infer<typeof FilesystemContractEventTypeSchema>

export const FilesystemContractEventSchema = z.object({
  type: FilesystemContractEventTypeSchema,
  path: z.string().min(1),
  timestamp: z.number().int().nonnegative().optional(),
})

export type FilesystemContractEvent = z.infer<typeof FilesystemContractEventSchema>
