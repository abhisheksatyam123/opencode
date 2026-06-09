/**
 * Process L3 — Module barrel
 *
 * Re-exports all public surfaces of the Process module.
 * Old callers that imported from process/registry, process/recovery,
 * or process/events directly continue to work via these re-exports.
 *
 * Preferred import paths for new code:
 *   - process/port.ts    — abstract interface + Zod schemas
 *   - process/adapter.ts — concrete adapter + sub-module re-exports
 *   - process/layer.ts   — Effect Layer for composition root
 *
 * memory/ sub-module is accessible via process/adapter.ts re-exports.
 */

// Port (abstract interface + Zod schemas + Effect.Tag)
export {
  ProcessPortSchema,
  PCBSchema,
  ProcessStateSchema,
  SignalKindSchema,
  ProcessKeySchema,
  SpawnInputSchema,
  LoadErrorSchema,
  ExitReasonSchema,
  Process,
  type ProcessPortSchema as ProcessPortSchemaType,
  type PCB,
  type ProcessState,
  type SignalKind,
  type ProcessKey,
  type SpawnInput,
  type LoadError,
  type ExitReason,
  type ProcessPort,
} from "@/process/port"

// Concrete implementations (preserved barrels for existing callers)
export { ProcessRegistry } from "@/process/registry"
export { ProcessRecovery } from "@/process/recovery"
export { ProcessEvent } from "@/process/events"
export {
  BackgroundTaskSlots,
  type BackgroundTaskResult,
  type BackgroundTaskParsedResult,
} from "@/process/background-slots"

// Layer (Effect Layer for composition root)
export { ProcessAdapterLayer } from "@/process/adapter"
export { ProcessLayer } from "@/process/layer"
