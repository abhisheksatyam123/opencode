/**
 * Process L3 — Effect Layer
 *
 * ProcessLayer is the single entry point for wiring the Process module.
 * Import this at the composition root (src/index.ts or src/node.ts).
 *
 * Provides: Process.Service (via ProcessAdapterLayer)
 * Requires: Bus.Service (ProcessRegistry uses Bus.publish for lifecycle events)
 *           Filesystem L1 (ProcessRegistry reads/writes task-note frontmatter)
 *
 * Mirrors the Config/Provider/Permission L2 pattern from config/layer.ts etc.
 *
 * Sub-modules folded into Process L3:
 *   - process/registry.ts  — PCB registry (source of truth: task-note frontmatter)
 *   - process/recovery.ts  — crash-recovery boot scan
 *   - process/events.ts    — bus event definitions (process.spawned/exited/signalled)
 *  *
 * control-plane/ is NOT folded here — workspace.ts imports Database + Project
 * (L4+), making it L4+. Deferred to a higher-layer phase.
 */

export { ProcessAdapterLayer as ProcessLayer } from "@/process/adapter"
export { Process } from "@/process/port"
export { ProcessRegistry } from "@/process/registry"
export { ProcessRecovery } from "@/process/recovery"
export { ProcessEvent } from "@/process/events"
