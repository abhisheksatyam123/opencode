import z from "zod"
import { ACPContractVersionSchema } from "@/surface/acp/contract/version"

export const ACPConformanceSchema = z.object({
  module: z.literal("acp"),
  contractVersion: ACPContractVersionSchema,
  guarantees: z.array(z.string().min(1)).min(1),
})

export type ACPConformance = z.infer<typeof ACPConformanceSchema>

export const ACPConformance: ACPConformance = {
  module: "acp",
  contractVersion: "1.0.0",
  guarantees: ["session-state-shape", "agent-config-shape", "protocol-compatibility-surface"],
}
