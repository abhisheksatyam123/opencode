import z from "zod"
import { ConfigContractVersionSchema } from "@/config/contract/version"

export const ConfigConformanceSchema = z.object({
  module: z.literal("config"),
  contractVersion: ConfigContractVersionSchema,
  guarantees: z.array(z.string().min(1)).min(1),
})

export type ConfigConformance = z.infer<typeof ConfigConformanceSchema>

export const ConfigConformance: ConfigConformance = {
  module: "config",
  contractVersion: "1.0.0",
  guarantees: ["contract-versioned", "module-identity-declared", "event-envelope-declared"],
}
