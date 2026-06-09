import z from "zod"

export const BusPortErrorSchema = z.object({
  _tag: z.literal("BusPortError"),
  message: z.string(),
})

export type BusPortError = z.infer<typeof BusPortErrorSchema>
