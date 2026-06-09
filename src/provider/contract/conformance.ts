import z from "zod"
import { ProviderContractVersionSchema } from "@/provider/contract/version"

export const ProviderConformanceSchema = z.object({
  module: z.literal("provider"),
  contractVersion: ProviderContractVersionSchema,
  guarantees: z.array(z.string().min(1)).min(1),
})

export type ProviderConformance = z.infer<typeof ProviderConformanceSchema>

export const ProviderConformance: ProviderConformance = {
  module: "provider",
  contractVersion: "1.0.0",
  guarantees: ["contract-versioned", "module-identity-declared", "event-envelope-declared"],
}
