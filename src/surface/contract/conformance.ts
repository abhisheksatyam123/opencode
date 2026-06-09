import z from "zod"
import { SurfaceContractVersionSchema } from "@/surface/contract/version"

export const SurfaceConformanceSchema = z.object({
  module: z.literal("surface"),
  contractVersion: SurfaceContractVersionSchema,
  guarantees: z.array(z.string().min(1)).min(1),
})

export type SurfaceConformance = z.infer<typeof SurfaceConformanceSchema>

export const SurfaceConformance: SurfaceConformance = {
  module: "surface",
  contractVersion: "1.0.0",
  guarantees: ["cli-start-surface", "server-start-surface", "ide-start-surface"],
}
