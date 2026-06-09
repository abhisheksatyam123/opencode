/**
 * Provider L2 — Port contract
 *
 * Exposes:
 *   - ProviderPortSchema                     — Zod schema documenting port shape
 *   - ProviderPort interface                  — list/getProvider/getModel/getLanguage/closest/getSmallModel/defaultModel
 *   - ProviderService Effect.Tag              — DI tag for Effect Layer
 *
 * Depends only on Foundation L0 + Bus L1 + Storage L1 (no peer L2 imports).
 * This is the PRIMARY DIP seam — 9 consumers route through this port.
 *
 * NOTE: The full Provider.Model + Provider.Info Zod schemas live in provider.ts.
 * This port defines the abstract service interface + Effect.Tag only.
 * The concrete adapter in adapter.ts wraps provider.ts.
 */

import z from "zod"
import { Effect, ServiceMap } from "effect"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import type { Provider } from "@/provider/provider"
import type { ProviderID, ModelID } from "@/provider/schema"
export * from "@/provider/contract/version"
export * from "@/provider/contract/identity"
export * from "@/provider/contract/error"
export * from "@/provider/contract/event"
export * from "@/provider/contract/conformance"
import { ProviderContractVersion } from "@/provider/contract/version"

// ── Port schema ───────────────────────────────────────────────────────────────

/**
 * ProviderPortSchema — documents the shape of the Provider service port.
 * The actual Provider.Model + Provider.Info schemas are in provider.ts.
 */
export const ProviderPortSchema = z.object({
  version: z.literal(ProviderContractVersion),
})
export type ProviderPortSchema = z.infer<typeof ProviderPortSchema>

// ── Port interface ────────────────────────────────────────────────────────────

/**
 * ProviderPort — abstract interface for the Provider service.
 *
 * Provides typed access to LLM provider enumeration, model resolution,
 * and language model instantiation. Concrete adapter lives in adapter.ts;
 * wired via layer.ts.
 *
 * This is the PRIMARY DIP seam (9 consumers per Phase A DA3 analysis).
 * All AI model calls route through this port.
 */
export interface ProviderPort {
  /**
   * List all available providers keyed by ProviderID.
   */
  readonly list: () => Effect.Effect<Record<ProviderID, Provider.Info>>

  /**
   * Get a specific provider by ID.
   */
  readonly getProvider: (providerID: ProviderID) => Effect.Effect<Provider.Info>

  /**
   * Get a specific model by provider + model ID.
   */
  readonly getModel: (providerID: ProviderID, modelID: ModelID) => Effect.Effect<Provider.Model>

  /**
   * Instantiate a LanguageModelV3 for the given model.
   */
  readonly getLanguage: (model: Provider.Model) => Effect.Effect<LanguageModelV3>

  /**
   * Find the closest model to a query string within a provider.
   */
  readonly closest: (
    providerID: ProviderID,
    query: string[],
  ) => Effect.Effect<{ providerID: ProviderID; modelID: string } | undefined>

  /**
   * Get the smallest/cheapest model for a provider (used for compaction).
   */
  readonly getSmallModel: (providerID: ProviderID) => Effect.Effect<Provider.Model | undefined>

  /**
   * Get the default model from config.
   */
  readonly defaultModel: () => Effect.Effect<{ providerID: ProviderID; modelID: ModelID }>
}

// ── Effect.Tag (DI service) ───────────────────────────────────────────────────

export namespace ProviderService {
  /**
   * Effect.Tag for the Provider service.
   * Concrete impl provided by ProviderLayer in layer.ts.
   * Callers: `yield* ProviderService.Tag` to access ProviderPort.
   *
   * NOTE: Provider.Service (in provider.ts) is the canonical tag used by
   * existing code. ProviderService.Tag is an alias that points to the same
   * ServiceMap key so both can be used interchangeably during migration.
   */
  export class Tag extends ServiceMap.Service<Tag, ProviderPort>()("@opencode/Provider") {}
}
