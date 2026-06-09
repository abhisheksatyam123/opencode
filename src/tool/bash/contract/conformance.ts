import z from "zod"
import { BashContractVersionSchema } from "@/tool/bash/contract/version"

export const BashConformanceSchema = z.object({
  module: z.literal("tool/bash"),
  contractVersion: BashContractVersionSchema,
  guarantees: z.array(z.string().min(1)).min(1),
})

export type BashConformance = z.infer<typeof BashConformanceSchema>

export const BashConformance: BashConformance = {
  module: "tool/bash",
  contractVersion: "1.0.0",
  guarantees: ["command-exec-surface", "background-registry-surface", "cwd-tracking-surface"],
}
