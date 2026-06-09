/**
 * Config L2 — Port contract
 *
 * Exposes:
 *   - ConfigPortSchema                       — Zod schema documenting port shape
 *   - ConfigPort interface                   — get/getSync/getGlobal surface
 *   - ConfigService Effect.Tag               — DI tag for Effect Layer
 *
 * Depends only on Foundation L0 (zod, effect). No peer L2 imports.
 *
 * NOTE: The full Config.Info Zod schema lives in config.ts (Config.Info).
 * This port defines the abstract service interface + Effect.Tag only.
 * The concrete adapter in adapter.ts wraps config.ts.
 */

import z from "zod"
import { Effect, ServiceMap } from "effect"
import type { Config } from "@/config/config"
export * from "@/config/contract/version"
export * from "@/config/contract/identity"
export * from "@/config/contract/error"
export * from "@/config/contract/event"
export * from "@/config/contract/conformance"
import { ConfigContractVersion } from "@/config/contract/version"

// ── Port schema ───────────────────────────────────────────────────────────────

/**
 * ConfigPortSchema — documents the shape of the Config service port.
 * The actual Config.Info schema is in config.ts (Config.Info).
 */
export const ConfigPortSchema = z.object({
  version: z.literal(ConfigContractVersion),
})
export type ConfigPortSchema = z.infer<typeof ConfigPortSchema>

// ── Port interface ────────────────────────────────────────────────────────────

/**
 * ConfigPort — abstract interface for the Config service.
 *
 * Provides typed access to the merged opencode.json configuration.
 * Concrete adapter lives in adapter.ts; wired via layer.ts.
 *
 * Config.get() uses Instance.directory from ALS (no directory arg).
 * Config.getGlobal() reads only the global ~/.config/opencode/opencode.json.
 */
export interface ConfigPort {
  /**
   * Get the current merged configuration (uses Instance.directory from ALS).
   */
  readonly get: () => Effect.Effect<Config.Info, any>

  /**
   * Get the global configuration only (no project-level merge).
   */
  readonly getGlobal: () => Effect.Effect<Config.Info, any>

  /**
   * Synchronous read of the most recently resolved config.
   * Returns undefined if get() has not completed at least once.
   */
  readonly getSync: () => Config.Info | undefined
}

// ── Effect.Tag (DI service) ───────────────────────────────────────────────────

export namespace ConfigService {
  /**
   * Effect.Tag for the Config service.
   * Concrete impl provided by ConfigLayer in layer.ts.
   * Callers: `yield* ConfigService.Tag` to access ConfigPort.
   */
  export class Tag extends ServiceMap.Service<Tag, ConfigPort>()("@opencode/Config") {}
}
