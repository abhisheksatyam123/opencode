/**
 * Provider L2 — Concrete adapter
 *
 * Wraps the existing Provider.Service layer from provider.ts as a named
 * export following the Config/Bus/Storage/Filesystem B-phase pattern.
 *
 * Depends on:
 *   - ./provider.ts (Provider — concrete impl, all provider loading logic)
 *   - ./port.ts (ProviderService.Tag, ProviderPort)
 *   - effect (Layer)
 *
 * NOTE: provider.ts has pre-existing deps on auth, plugin, config, etc.
 * These are counted in the 38-violation baseline. This file does NOT
 * introduce new violations — it only re-exports existing code.
 *
 * Layer note: Provider.defaultLayer is the self-contained layer that
 * bundles Config.defaultLayer + Auth.defaultLayer + Plugin.defaultLayer.
 * ProviderAdapterLayer re-exports it so the composition root can use
 * either the raw defaultLayer or compose it with explicit deps.
 */

import { Provider } from "@/provider/provider"
import { ProviderService } from "@/provider/port"

// ── Concrete adapter implementation ───────────────────────────────────────────

/**
 * ProviderAdapterLayer — Effect Layer providing ProviderService.Tag
 * via the concrete Provider implementation from provider.ts.
 *
 * Uses Provider.defaultLayer which is self-contained (bundles all deps).
 * The Provider.Service tag key ("@opencode/Provider") matches
 * ProviderService.Tag key, so both tags resolve to the same service
 * instance in the Effect runtime.
 */

export const ProviderAdapterLayer = Provider.defaultLayer

// Re-export Provider namespace for callers that need direct access
export { Provider } from "@/provider/provider"

// Re-export ProviderService for convenience
export { ProviderService } from "@/provider/port"
