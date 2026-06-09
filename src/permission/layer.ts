/**
 * Permission L2 — Effect Layer
 *
 * PermissionLayer is the single entry point for wiring the Permission module.
 * Import this at the composition root (src/index.ts or src/node.ts).
 *
 * Provides: Permission.Service (via PermissionAdapterLayer)
 * Requires: Bus.Service (Permission.layer depends on Bus)
 *
 * Mirrors the Config/Provider L2 pattern from config/layer.ts etc.
 *
 * policy/ folds into Permission L2:
 *   Policy namespace is re-exported here so consumers can import
 *   Policy from @permission/port instead of from policy/ directly.
 *   This is the DIP seam that resolves the workflow↔policy cycle:
 *   workflow imports PermissionPort (interface), not policy directly.
 *
 * tool-card/ does NOT fold here — stays in Tool L3 (cycle resolution
 * per dep-graph-v2). tool-card will be handled in Phase B4.
 */

export { PermissionAdapterLayer as PermissionLayer } from "@/permission/adapter"
export { Permission } from "@/permission/port"
export { Permission as PermissionImpl } from "@/permission/index"
export { Policy } from "@/permission/policy/index"
