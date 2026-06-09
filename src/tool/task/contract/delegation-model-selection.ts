import z from "zod"
import { TaskContractVersionSchema } from "@/tool/task/contract/version"

export const DelegationAllowedProviderSchema = z.string().min(1)
export type DelegationAllowedProvider = z.infer<typeof DelegationAllowedProviderSchema>

export const DelegationSelectionSourceSchema = z.enum([
  "override",
  "override_list",
  "resume",
  "agent_hint",
  "capability_router",
  "auto",
  "caller",
])
export type DelegationSelectionSource = z.infer<typeof DelegationSelectionSourceSchema>

export const DelegationModelPreferenceRuleSchema = z.object({
  providerID: DelegationAllowedProviderSchema.optional(),
  modelContains: z.string().min(1),
  bonus: z.number(),
})
export type DelegationModelPreferenceRule = z.infer<typeof DelegationModelPreferenceRuleSchema>

export const DelegationModelPreferenceRules: DelegationModelPreferenceRule[] = []

export const DelegationModelSelectionContractSchema = z.object({
  module: z.literal("tool/task/delegation-model-selection"),
  orchestration: z.literal("multiagent"),
  contractVersion: TaskContractVersionSchema,
  allowedProviders: z.array(DelegationAllowedProviderSchema),
  sourcePrecedence: z.array(DelegationSelectionSourceSchema).min(1),
  healthKey: z.literal("endpoint|provider|model"),
  rateLimitMemory: z.object({
    enabled: z.literal(true),
    defaultCooldownMs: z.number().int().positive(),
  }),
  capabilityRouting: z.object({
    enabled: z.literal(true),
    requirementsSource: z.literal("agent_capability_requirements"),
  }),
  preferredModels: z.array(DelegationModelPreferenceRuleSchema),
})
export type DelegationModelSelectionContract = z.infer<typeof DelegationModelSelectionContractSchema>

export const DelegationModelSelectionContract: DelegationModelSelectionContract = {
  module: "tool/task/delegation-model-selection",
  orchestration: "multiagent",
  contractVersion: "1.0.0",
  allowedProviders: [],
  sourcePrecedence: ["override", "override_list", "resume", "agent_hint", "capability_router", "auto", "caller"],
  healthKey: "endpoint|provider|model",
  rateLimitMemory: {
    enabled: true,
    defaultCooldownMs: 5 * 60_000,
  },
  capabilityRouting: {
    enabled: true,
    requirementsSource: "agent_capability_requirements",
  },
  preferredModels: DelegationModelPreferenceRules,
}
