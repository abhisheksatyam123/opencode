import z from "zod"
import { TuiContractVersionSchema } from "@/surface/cli/cmd/tui/contract/version"

export const TuiConformanceSchema = z.object({
  module: z.literal("cli/cmd/tui"),
  contractVersion: TuiContractVersionSchema,
  guarantees: z.array(z.string().min(1)).min(1),
})

export type TuiConformance = z.infer<typeof TuiConformanceSchema>

export const TuiConformance: TuiConformance = {
  module: "cli/cmd/tui",
  contractVersion: "1.0.0",
  guarantees: ["tui-event-contract", "bus-publish-integration", "session-navigation-surface"],
}
