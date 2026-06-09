import z from "zod"
import { TuiContractVersionSchema } from "@/surface/cli/cmd/tui/contract/version"

export const TuiModuleIdentitySchema = z.object({
  module: z.literal("cli/cmd/tui"),
  layer: z.literal("interface"),
  tier: z.literal("L5"),
  contractVersion: TuiContractVersionSchema,
})

export type TuiModuleIdentity = z.infer<typeof TuiModuleIdentitySchema>

export const TuiModuleIdentity: TuiModuleIdentity = {
  module: "cli/cmd/tui",
  layer: "interface",
  tier: "L5",
  contractVersion: "1.0.0",
}
