/**
 * Config L2 — Concrete adapter
 *
 * Wraps the existing Config namespace from config.ts as a named export
 * following the Bus/Storage/Filesystem L1 pattern.
 *
 * Depends on:
 *   - ./config.ts (Config — concrete impl, all config loading logic)
 *   - ./port.ts (ConfigService.Tag, ConfigPort)
 *   - effect (Layer)
 *
 * NOTE: config.ts has pre-existing deps on L3+ modules (auth, lsp, session,
 * account, etc.). These are counted in the 38-violation baseline. This file
 * does NOT introduce new violations — it only re-exports existing code.
 */

import { Effect, Layer } from "effect"
import { Config } from "@/config/config"
import { ConfigService, type ConfigPort } from "@/config/port"

// ── Concrete adapter implementation ───────────────────────────────────────────

/**
 * ConfigAdapterLayer — Effect Layer providing ConfigService.Tag
 * via the concrete Config implementation from config.ts.
 *
 * Delegates to Config.get() / Config.getGlobal() / Config.getSync()
 * which perform the full multi-source merge (managed plist, global,
 * project sources).
 */
export const ConfigAdapterLayer: Layer.Layer<ConfigService.Tag> = Layer.effect(
  ConfigService.Tag,
  Effect.sync(
    (): ConfigPort => ({
      get: () =>
        Effect.tryPromise({
          try: () => Config.get(),
          catch: (err) => err,
        }),
      getGlobal: () =>
        Effect.tryPromise({
          try: () => Config.getGlobal(),
          catch: (err) => err,
        }),
      getSync: () => Config.getSync(),
    }),
  ),
)

// Re-export Config namespace for callers that need direct access
export { Config } from "@/config/config"
