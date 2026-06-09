import z from "zod"
import { CommandContractVersionSchema } from "./version"

export const CommandConformanceSchema = z.object({
  module: z.literal("command"),
  contractVersion: CommandContractVersionSchema,
  guarantees: z.array(z.string().min(1)).min(1),
})

export type CommandConformance = z.infer<typeof CommandConformanceSchema>

export const CommandConformance: CommandConformance = {
  module: "command",
  contractVersion: "1.0.0",
  guarantees: ["contract-versioned", "module-identity-declared", "event-envelope-declared"],
}
