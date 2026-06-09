import z from "zod"

export const SurfaceContractEventTypeSchema = z.enum([
  "surface.cli.start",
  "surface.server.start",
  "surface.ide.start",
  "surface.start.failed",
])

export type SurfaceContractEventType = z.infer<typeof SurfaceContractEventTypeSchema>

export const SurfaceContractEventSchema = z.object({
  type: SurfaceContractEventTypeSchema,
  surface: z.enum(["cli", "server", "ide"]).optional(),
  timestamp: z.number().int().nonnegative().optional(),
})

export type SurfaceContractEvent = z.infer<typeof SurfaceContractEventSchema>
