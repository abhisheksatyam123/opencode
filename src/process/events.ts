// src/process/events.ts — Stage 8 (I8.5) bus event definitions for the
// process lifecycle.
// -------------------------------------------------------------------------
// Authoritative contract:
//   project/software/opencode/specification/contract/bus-service.md
//     §Process events (Stage 8)        L456-516  payload schemas
//     §Event definitions               L518-534  BusEvent.define calls
//     §Ordering guarantees             L536-544  per-pid sequence invariant
//     §Idempotency requirement         L560-562  dedup key = pid + event type
//
// Three module-level events register exactly once on import. Subscribers
// can use `pid + event type` as a dedup key (per I3 advisory delivery).
// -------------------------------------------------------------------------

import z from "zod"
import { BusEvent } from "@/bus/bus-event"

// Note: this module deliberately does NOT import ProcessRegistry — that
// would form a circular import (registry.ts imports ProcessEvent for
// publish helpers). The PCB zod schema is duplicated here as a leaf
// schema instead. The two definitions MUST stay structurally identical;
// process-registry.md §Signature is the single source of truth.

export namespace ProcessEvent {
  /** ProcessState — mirror of ProcessRegistry.ProcessState. */
  export const ProcessState = z.enum(["running", "blocked", "zombie", "stopped"])

  /** SignalKind — mirror of ProcessRegistry.SignalKind. */
  export const SignalKind = z.enum(["kill", "pause", "resume", "resurrect"])

  /** PCB schema — mirror of ProcessRegistry.PCB. Kept here so events.ts
   *  has no runtime dep on registry.ts (avoids circular import).        */
  export const PCB = z.object({
    pid: z.string().uuid(),
    parent_pid: z.string().uuid().nullable(),
    session_id: z.string().min(1),
    agent: z.string().min(1),
    model: z.string().min(1),
    task_path: z.string().min(1), // persisted/event wire field; internal code should prefer taskPath naming at boundaries
    state: ProcessState,
    started_at: z.string().min(1),
    last_heartbeat: z.string().min(1),
    exit_code: z.number().int().nullable(),
    exit_reason: z.string().nullable(),
  })

  /** Natural key — see process-registry §Signature. */
  export const ProcessKeySchema = z.object({
    session_id: z.string(),
    agent: z.string(),
    task_path: z.string(),
  })

  /** Closed enum of exit reasons per bus-service.md L502. */
  export const ExitReason = z.enum(["ok", "killed", "crashed", "timeout"])
  export type ExitReason = z.infer<typeof ExitReason>

  // ── process.spawned ──────────────────────────────────────────────────
  //
  // Fires once per pid, after the atomic-swap commit completes in
  // ProcessRegistry.spawn(). Subscribers (TUI status, `proc list`,
  // observers) get the full PCB at spawn time.

  export const SpawnedPayload = z.object({
    pcb: PCB,
  })

  export const Spawned = BusEvent.define("process.spawned", SpawnedPayload)

  // ── process.exited ───────────────────────────────────────────────────
  //
  // Fires once per pid, terminal. Two sources:
  //   • explicit ProcessRegistry.exit() — recovery=false
  //   • crash-recovery scan classifying an orphan — recovery=true
  // Subscribers MUST treat as advisory; ProcessRegistry snapshot is the
  // source of truth.

  export const ExitedPayload = z.object({
    pid: z.string().uuid(),
    key: ProcessKeySchema,
    exit_code: z.number().int(),
    exit_reason: ExitReason,
    /** true ⇒ orphan reaped by boot scan; false ⇒ explicit exit(). */
    recovery: z.boolean(),
  })

  export const Exited = BusEvent.define("process.exited", ExitedPayload)

  // ── process.signalled ────────────────────────────────────────────────
  //
  // Audit event — fires on EVERY signal invocation, granted OR denied.
  // The deny path is load-bearing for after-action review (planner
  // learning S1).

  export const SignalledPayload = z.object({
    pid: z.string().uuid(),
    key: ProcessKeySchema,
    signal: SignalKind,
    /** Permission gate outcome. true = mutation applied; false = denied. */
    granted: z.boolean(),
    /** Free-text caller note OR structured deny code: "permission_denied" |
     *  "invalid_state" | etc. Capped at 280 chars per spec. */
    reason: z.string().max(280),
    /** pid of the agent invoking signal; null when invoked from CLI or
     *  operator console. */
    caller_pid: z.string().uuid().nullable(),
  })

  export const Signalled = BusEvent.define("process.signalled", SignalledPayload)

  /** Discriminated-union convenience type for subscribers. */
  export type Any =
    | { type: typeof Spawned.type; properties: z.infer<typeof SpawnedPayload> }
    | { type: typeof Exited.type; properties: z.infer<typeof ExitedPayload> }
    | { type: typeof Signalled.type; properties: z.infer<typeof SignalledPayload> }
}
