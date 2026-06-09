/**
 * Config L2 — Effect Layer
 *
 * ConfigLayer is the single entry point for wiring the Config module.
 * Import this at the composition root (src/index.ts or src/node.ts).
 *
 * Provides: ConfigService.Tag (via ConfigAdapterLayer)
 * Requires: nothing (Config.get() uses Instance ALS internally)
 *
 * Mirrors the Bus/Storage/Filesystem L1 pattern from bus/layer.ts etc.
 *
 * InstanceContext binding (ADR Option C):
 *   Config L2 provides the concrete InstanceContext impl (src/project/instance.ts).
 *   The composition root composes: FoundationLayer + ConfigLayer.
 *   See src/config/instance.ts for the InstanceContext re-export.
 */

export { ConfigAdapterLayer as ConfigLayer } from "@/config/adapter"
export { ConfigService } from "@/config/port"
export { Config } from "@/config/config"
