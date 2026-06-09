/**
 * Process L3 — Concrete adapter
 *
 * Wraps the existing ProcessRegistry + ProcessRecovery + ProcessEvent
 * implementations as named exports following the Config/Permission L2 pattern.
 *
 * Depends on:
 *   - ./registry.ts  (ProcessRegistry — concrete impl, PCB lifecycle)
 *   - ./recovery.ts  (ProcessRecovery — crash-recovery boot scan)
 *   - ./events.ts    (ProcessEvent — bus event definitions)
 *   - ./port.ts      (Process.Service tag, ProcessPort)
 *   - effect         (Layer)
 *
 * NOTE: registry.ts has pre-existing deps on workflow/registry-events and
 * workflow/watch (counted in 38-violation baseline). This adapter does NOT
 * introduce new violations — it only re-exports existing code.
 *
 * memory/ folds into Process L3 here: memory sub-modules are re-exported
 * so consumers can import from process/adapter instead of from memory/
 * directly. This is the DIP seam for working-memory per agent process.
 *
 * control-plane/ does NOT fold here — workspace.ts imports Database + Project
 * (L4+), making it L4+. It remains deferred to a higher-layer phase.
 */

import { Effect, Layer } from "effect"
import { ProcessRegistry } from "@/process/registry"
import { type ProcessPort } from "@/process/port"
import { Process } from "@/process/port"

// ── Concrete adapter implementation ───────────────────────────────────────────

/**
 * ProcessAdapterLayer — Effect Layer providing Process.Service
 * via the concrete ProcessRegistry implementation from registry.ts.
 *
 * Delegates all operations to ProcessRegistry which manages the PCB
 * snapshot backed by task-note frontmatter on disk.
 */
export const ProcessAdapterLayer: Layer.Layer<Process.Service> = Layer.effect(
  Process.Service,
  Effect.sync(
    (): ProcessPort => ({
      load: () => ProcessRegistry.load(),
      reload: () => ProcessRegistry.reload(),
      spawn: (input) => ProcessRegistry.spawn(input),
      heartbeat: (pid) => ProcessRegistry.heartbeat(pid),
      exit: (pid, code, reason) => ProcessRegistry.exit(pid, code, reason),
      signal: (pid, sig) => ProcessRegistry.signal(pid, sig),
      reap: (ttlMs) => ProcessRegistry.reap(ttlMs),
      get: (pid) => ProcessRegistry.get(pid),
      list: () => ProcessRegistry.list(),
      byKey: (key) => ProcessRegistry.byKey(key),
      ancestors: (pid) => ProcessRegistry.ancestors(pid),
      descendants: (pid) => ProcessRegistry.descendants(pid),
      errors: () => ProcessRegistry.errors(),
      onChange: (fn) => ProcessRegistry.onChange(fn),
    }),
  ),
)

// Re-export concrete namespaces for callers that need direct access
export { ProcessRegistry } from "@/process/registry"
export { ProcessRecovery } from "@/process/recovery"
export { ProcessEvent } from "@/process/events"

// ── Sub-module re-exports ─────────────────────────────────────────────────────

// memory/ folds into Process L3 as a sub-module.
// Re-exported here so consumers can import from process/adapter instead of
// from memory/ directly (DIP seam for working-memory per agent process).
// memory/vault-query.ts and memory/session-boot.ts have no L3+ deps —
// they are pure utility (fs + path only), eligible for L3 fold.
export {
  queryVaultNotes,
  type QueryVaultNotesInput,
  type QueryVaultNotesResult,
  type PriorWorkNote,
  type VaultSemanticSearch,
} from "@/process/memory"

export {
  loadRelatedPriorWork,
  parseTaskBootInput,
  type SessionBootInput,
  type RelatedPriorWorkNote,
} from "@/process/memory"
