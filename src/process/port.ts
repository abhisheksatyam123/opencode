/**
 * Process L3 — Port contract
 *
 * Exposes:
 *   - ProcessPortSchema                      — Zod schema documenting port shape
 *   - PCBSchema / PCB                        — Process Control Block (full Zod)
 *   - ProcessStateSchema / ProcessState      — 4-state enum
 *   - SignalKindSchema / SignalKind           — 4-signal enum
 *   - SpawnInputSchema / SpawnInput          — spawn() input
 *   - ProcessKeySchema / ProcessKey          — natural key (session_id|agent|task_path)
 *   - LoadErrorSchema / LoadError            — registry load error
 *   - ProcessPort interface                  — spawn/heartbeat/exit/signal/reap/load surface
 *   - Process.Service Effect.Tag             — DI tag for Effect Layer
 *
 * Depends only on Foundation L0 (zod, effect). No peer L3 imports.
 * NO imports from workflow, agent, tool, surface, init.
 *
 * Process L3 folds in:
 *   - process/registry.ts  — PCB registry (source of truth: task-note frontmatter)
 *   - process/recovery.ts  — crash-recovery boot scan
 *   - process/events.ts    — bus event definitions (process.spawned/exited/signalled)
 *  *
 * NOTE: registry.ts has pre-existing deps on workflow/registry-events and
 * workflow/watch (counted in 38-violation baseline). This port file does NOT
 * import those — it only defines the abstract interface + Zod schemas.
 * The concrete adapter in adapter.ts wraps registry.ts.
 */

import z from "zod"
import { ServiceMap } from "effect"

// ── Port schema ───────────────────────────────────────────────────────────────

/**
 * ProcessPortSchema — documents the shape of the Process service port.
 * Full PCB + state-machine schemas live below.
 */
export const ProcessPortSchema = z.object({
  version: z.literal("1.0.0"),
})
export type ProcessPortSchema = z.infer<typeof ProcessPortSchema>

// ── State machine schemas ─────────────────────────────────────────────────────

/**
 * ProcessStateSchema — 4-state enum per process-registry.md §State machine.
 * running → blocked → stopped → zombie (terminal).
 */
export const ProcessStateSchema = z.enum(["running", "blocked", "zombie", "stopped"])
export type ProcessState = z.infer<typeof ProcessStateSchema>

/**
 * SignalKindSchema — 4-signal enum per process-registry.md §State machine.
 * kill | pause | resume | resurrect
 */
export const SignalKindSchema = z.enum(["kill", "pause", "resume", "resurrect"])
export type SignalKind = z.infer<typeof SignalKindSchema>

// ── Process Control Block ─────────────────────────────────────────────────────

/**
 * PCBSchema — full Zod schema for the Process Control Block.
 * Source of truth: task-note frontmatter `pcb` block.
 * One PCB per (session_id, agent, task_path) natural key.
 */
export const PCBSchema = z.object({
  pid: z.string().uuid(),
  parent_pid: z.string().uuid().nullable(),
  session_id: z.string().min(1),
  agent: z.string().min(1),
  model: z.string().min(1),
  task_path: z.string().min(1), // persisted/event wire field; internal code should prefer taskPath naming at boundaries
  state: ProcessStateSchema,
  started_at: z.string().min(1),
  last_heartbeat: z.string().min(1),
  exit_code: z.number().int().nullable(),
  exit_reason: z.string().nullable(),
})
export type PCB = z.infer<typeof PCBSchema>

// ── Natural key schema ────────────────────────────────────────────────────────

/**
 * ProcessKeySchema — natural key for a process (session_id|agent|task_path).
 * Used for byKey() lookup and dedup guard in spawn().
 */
export const ProcessKeySchema = z.object({
  session_id: z.string().min(1),
  agent: z.string().min(1),
  task_path: z.string().min(1),
})
export type ProcessKey = z.infer<typeof ProcessKeySchema>

// ── Spawn input schema ────────────────────────────────────────────────────────

/**
 * SpawnInputSchema — input to spawn(). parent_pid is null for root processes.
 */
export const SpawnInputSchema = z.object({
  parent_pid: z.string().uuid().nullable(),
  session_id: z.string().min(1),
  agent: z.string().min(1),
  model: z.string().min(1),
  task_path: z.string().min(1),
})
export type SpawnInput = z.infer<typeof SpawnInputSchema>

// ── Load error schema ─────────────────────────────────────────────────────────

/**
 * LoadErrorSchema — registry load error (schema.invalid | frontmatter.parse |
 * io.read | duplicate-pid). Surfaced via ProcessRegistry.errors().
 */
export const LoadErrorSchema = z.object({
  source: z.string(),
  path: z.string().optional(),
  name: z.string().optional(),
  reason: z.enum(["schema.invalid", "frontmatter.parse", "io.read", "duplicate-pid"]),
  detail: z.string(),
})
export type LoadError = z.infer<typeof LoadErrorSchema>

// ── Exit reason schema ────────────────────────────────────────────────────────

/**
 * ExitReasonSchema — closed enum of exit reasons per bus-service.md L502.
 * ok | killed | crashed | timeout
 */
export const ExitReasonSchema = z.enum(["ok", "killed", "crashed", "timeout"])
export type ExitReason = z.infer<typeof ExitReasonSchema>

// ── Port interface ────────────────────────────────────────────────────────────

/**
 * ProcessPort — abstract interface for the Process service.
 *
 * Provides agent process lifecycle management: spawn, inspect, kill,
 * suspend, resume, and crash-recovery. All process registry operations
 * route through this port.
 *
 * Concrete adapter lives in adapter.ts; wired via layer.ts.
 *
 * NOTE: Methods use concrete types from PCBSchema / SpawnInputSchema
 * (defined above in this file) to avoid circular imports.
 */
export interface ProcessPort {
  /**
   * Boot scan — walks active task notes, populates registry from PCB
   * frontmatter blocks. Idempotent (P9).
   */
  readonly load: () => Promise<void>

  /**
   * Reload the registry (alias for load). Used by hot-reload watcher.
   */
  readonly reload: () => Promise<void>

  /**
   * Spawn a new process. Throws ProcessExistsError if natural key already
   * has an active PCB. State transition: ∅ → running.
   */
  readonly spawn: (input: SpawnInput) => Promise<PCB>

  /**
   * Update last_heartbeat for a running/blocked process. Idempotent.
   * Returns false if pid is unknown or terminal.
   */
  readonly heartbeat: (pid: string) => Promise<boolean>

  /**
   * Mark a process as zombie (terminal). State: running|blocked|stopped → zombie.
   */
  readonly exit: (pid: string, code: number, reason: string) => Promise<void>

  /**
   * Apply a signal to a process (kill|pause|resume|resurrect).
   * Caller is responsible for the permission gate.
   */
  readonly signal: (pid: string, sig: SignalKind) => Promise<PCB>

  /**
   * Reap zombies older than ttlMs. Returns reaped pids.
   */
  readonly reap: (ttlMs: number) => Promise<string[]>

  /**
   * Lookup by pid (primary key).
   */
  readonly get: (pid: string) => PCB | undefined

  /**
   * All active PCBs, sorted by started_at.
   */
  readonly list: () => ReadonlyArray<PCB>

  /**
   * Natural-key lookup (session_id|agent|task_path).
   */
  readonly byKey: (key: ProcessKey) => PCB | undefined

  /**
   * Walk parent_pid chain. Returns root → … → parent (excluding self).
   */
  readonly ancestors: (pid: string) => ReadonlyArray<PCB>

  /**
   * All transitive descendants (BFS).
   */
  readonly descendants: (pid: string) => ReadonlyArray<PCB>

  /**
   * Registry load errors (schema.invalid, frontmatter.parse, etc.).
   */
  readonly errors: () => ReadonlyArray<LoadError>

  /**
   * Subscribe to registry changes. Returns a disposer.
   */
  readonly onChange: (fn: () => void) => { dispose(): void }
}

// ── Effect.Tag (DI service) ───────────────────────────────────────────────────

export namespace Process {
  /**
   * Effect.Tag for the Process service.
   * Concrete impl provided by ProcessLayer in layer.ts.
   * Callers: `yield* Process.Service` to access ProcessPort.
   */
  export class Service extends ServiceMap.Service<Service, ProcessPort>()("@opencode/Process") {}
}
