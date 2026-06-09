import z from "zod"
import { ShellContractVersionSchema } from "./version"

export const ShellConformanceSchema = z.object({
  module: z.literal("shell"),
  contractVersion: ShellContractVersionSchema,
  guarantees: z.array(z.string().min(1)).min(1),
})

export type ShellConformance = z.infer<typeof ShellConformanceSchema>

export const ShellConformance: ShellConformance = {
  module: "shell",
  contractVersion: "1.0.0",
  guarantees: ["contract-versioned", "shell-selection-surface", "process-tree-kill-surface"],
}
