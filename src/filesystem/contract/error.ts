import z from "zod"

export const FilesystemPortErrorSchema = z.object({
  _tag: z.literal("FilesystemPortError"),
  method: z.string().optional(),
  message: z.string(),
})

export type FilesystemPortError = z.infer<typeof FilesystemPortErrorSchema>
