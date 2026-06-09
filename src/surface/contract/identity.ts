import z from "zod"
import { SurfaceContractVersionSchema } from "@/surface/contract/version"

export const SurfaceModuleIdentitySchema = z.object({
  module: z.literal("surface"),
  layer: z.literal("interface"),
  tier: z.literal("L5"),
  contractVersion: SurfaceContractVersionSchema,
})

export type SurfaceModuleIdentity = z.infer<typeof SurfaceModuleIdentitySchema>

export const SurfaceModuleIdentity: SurfaceModuleIdentity = {
  module: "surface",
  layer: "interface",
  tier: "L5",
  contractVersion: "1.0.0",
}
