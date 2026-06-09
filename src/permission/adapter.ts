/**
 * Permission L2 — Concrete adapter
 *
 * Wraps the existing Permission.layer from index.ts as a named export
 * following the Config/Provider L2 pattern.
 *
 * Depends on:
 *   - ./index.ts (Permission — concrete impl, all permission logic)
 *   - ./port.ts (Permission.Service tag, PermissionPort)
 *   - effect (Layer)
 *
 * NOTE: index.ts has pre-existing deps on session, storage, etc.
 * These are counted in the 38-violation baseline. This file does NOT
 * introduce new violations — it only re-exports existing code.
 *
 * policy/ folds into Permission L2 here: Policy namespace is re-exported
 * from this adapter so consumers can import Policy from permission/adapter
 * instead of from policy/ directly. This is the DIP seam for policy.
 *
 * tool-card/ does NOT fold here — it stays in Tool L3 (cycle resolution
 * per dep-graph-v2: workflow↔tool-card↔policy cycle resolved by keeping
 * tool-card in Tool L3 and having workflow import PermissionPort interface).
 */

import { Permission } from "@/permission/index"

// ── Concrete adapter implementation ───────────────────────────────────────────

/**
 * PermissionAdapterLayer — Effect Layer providing Permission.Service
 * via the concrete Permission implementation from index.ts.
 *
 * Uses Permission.layer which requires Bus.Service.
 * The Permission.Service tag key ("@opencode/Permission") matches
 * the port's Permission.Service tag, so both resolve to the same
 * service instance in the Effect runtime.
 */
export const PermissionAdapterLayer = Permission.layer

// Re-export Permission namespace for callers that need direct access
export { Permission } from "@/permission/index"

// Re-export Policy namespace so consumers can import from permission/adapter
// instead of from policy/ directly (DIP seam for policy evaluation).
export { Policy } from "@/permission/policy/index"
