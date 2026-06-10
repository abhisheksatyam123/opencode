import z from "zod"

export const FileContractEventTypeSchema = z.enum(["file.requested", "file.updated", "file.failed"])

export type FileContractEventType = z.infer<typeof FileContractEventTypeSchema>

export const FileContractEventSchema = z.object({
  type: FileContractEventTypeSchema,
  timestamp: z.number().int().nonnegative().optional(),
})

export type FileContractEvent = z.infer<typeof FileContractEventSchema>
