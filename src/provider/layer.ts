/**
 * Provider L2 — Effect Layer
 *
 * ProviderLayer is the single entry point for wiring the Provider module.
 * Import this at the composition root (src/index.ts or src/node.ts).
 *
 * Provides: ProviderService.Tag (via ProviderAdapterLayer)
 * Requires: Config.Service + Auth.Service + Plugin.Service
 *
 * Mirrors the Config/Bus/Storage/Filesystem L1/L2 pattern.
 *
 * LSP/MCP runtime integrations are intentionally decoupled from this
 * provider layer. Provider wiring stays focused on model providers and
 * plugin/auth/config composition only.
 */

export { ProviderAdapterLayer as ProviderLayer } from "@/provider/adapter"
export { ProviderService } from "@/provider/port"
export { Provider } from "@/provider/provider"
