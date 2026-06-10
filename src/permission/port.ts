/**
 * Permission L2 — Port contract
 *
 * Exposes:
 *   - PermissionPortSchema                   — Zod schema documenting port shape
 *   - PermissionPort interface               — ask/reply/list surface
 *   - Permission.Service Effect.Tag          — DI tag for Effect Layer
 *
 * Depends only on Foundation L0 + Bus L1 (no peer L2 imports — no config, provider, notes).
 * policy/ folds into Permission L2 (policy-evaluation engine).
 * tool-card/ does NOT fold here — stays in Tool L3 (cycle resolution per dep-graph-v2).
 *
 * After this phase, workflow + tool-card import PermissionPort (interface)
 * instead of importing policy directly.
 */

import z from "zod"
import { Effect, ServiceMap } from "effect"

// ── Port schema ───────────────────────────────────────────────────────────────

/**
 * PermissionPortSchema — documents the shape of the Permission service port.
 * The full Permission.Request / Permission.Rule schemas live in index.ts.
 */
export const PermissionPortSchema = z.object({
  version: z.literal("1.0.0"),
})
export type PermissionPortSchema = z.infer<typeof PermissionPortSchema>

// ── Port interface ────────────────────────────────────────────────────────────

/**
 * PermissionPort — abstract interface for the Permission service.
 *
 * Provides tool-call permission gating and policy evaluation.
 * Every tool execution that touches external resources routes through this port.
 * Concrete adapter lives in adapter.ts; wired via layer.ts.
 *
 * NOTE: Input/output types use `any` here to avoid circular imports.
 * The concrete adapter (adapter.ts) wraps index.ts which has the full types.
 * Callers that need typed inputs should import from index.ts directly.
 */
export interface PermissionPort {
  /**
   * Ask for permission to perform a tool call.
   * Returns void on approval; throws on denial/rejection.
   */

  readonly ask: (input: any) => Effect.Effect<void, any>

  /**
   * Reply to a pending permission request.
   */

  readonly reply: (input: any) => Effect.Effect<void>

  /**
   * List all pending permission requests.
   */

  readonly list: () => Effect.Effect<any[]>
}

// ── Effect.Tag (DI service) ───────────────────────────────────────────────────

export namespace Permission {
  /**
   * Effect.Tag for the Permission service.
   * Concrete impl provided by PermissionLayer in layer.ts.
   * Callers: `yield* Permission.Service` to access PermissionPort.
   *
   * NOTE: The Permission.Service tag in index.ts uses the same key
   * "@opencode/Permission" so both resolve to the same service instance.
   */
  export class Service extends ServiceMap.Service<Service, PermissionPort>()("@opencode/Permission") {}
}
