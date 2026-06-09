// src/session/scheduler-events.ts — Stage 10 (I10.2) scheduler bus events.
// -------------------------------------------------------------------------
// Authoritative contract:
//   project/software/opencode/architecture/scheduler-quota.md §Bus events
//
// Five module-level events register exactly once on import.
//
// | Event                             | Emitter                |
// | --------------------------------- | ---------------------- |
// | scheduler.principal_capped        | the scheduler admission path      |
// | scheduler.principal_throttled     | the scheduler admission path      |
// | scheduler.preempted               | PreemptionSweep        |
// | scheduler.preemption_denied       | PreemptionSweep        |
// | scheduler.fair_share_starvation   | the scheduler admission path      |
//
// Subscribers MUST treat as advisory; QuotaState/quota.json on disk is
// the source of truth.
// -------------------------------------------------------------------------

import z from "zod"
import { BusEvent } from "@/bus/bus-event"

export namespace SchedulerEvent {
  // ── scheduler.principal_capped ─────────────────────────────────────
  // Fired when a principal's tokens_used >= tokens_quota at dispatch
  // time. Scheduler refuses to admit any new candidates from this
  // principal until tokens_used drops (operator reset of quota.json
  // OR a new window starts in a future stage).
  export const PrincipalCappedPayload = z.object({
    principal_id: z.string().min(1),
    tokens_used: z.number().int().nonnegative(),
    tokens_quota: z.number().int().nonnegative(),
  })
  export const PrincipalCapped = BusEvent.define("scheduler.principal_capped", PrincipalCappedPayload)

  // ── scheduler.principal_throttled ──────────────────────────────────
  // Soft warning — principal crossed soft_throttle_at but is still
  // eligible for dispatch. Subscribers (TUI status bar) surface this
  // as an early signal to the operator.
  export const PrincipalThrottledPayload = z.object({
    principal_id: z.string().min(1),
    tokens_used: z.number().int().nonnegative(),
    soft_at: z.number().int().nonnegative(),
  })
  export const PrincipalThrottled = BusEvent.define("scheduler.principal_throttled", PrincipalThrottledPayload)

  // ── scheduler.preempted ────────────────────────────────────────────
  // Fired by PreemptionSweep AFTER ProcessRegistry.signal(pid, "pause")
  // succeeds. Reason is currently always "token-burst"; future stages
  // may add "manual", "operator-deadline", etc.
  export const PreemptedPayload = z.object({
    pid: z.string().min(1),
    principal_id: z.string().min(1),
    reason: z.literal("token-burst"),
  })
  export const Preempted = BusEvent.define("scheduler.preempted", PreemptedPayload)

  // ── scheduler.preemption_denied ────────────────────────────────────
  // Fired by PreemptionSweep when the signal call FAILS — invalid
  // state transition, missing pid, or future permission-gate denial.
  // Runaway agent continues; soft-only outcome.
  export const PreemptionDeniedPayload = z.object({
    pid: z.string().min(1),
    principal_id: z.string().min(1),
    reason: z.string().max(280),
  })
  export const PreemptionDenied = BusEvent.define("scheduler.preemption_denied", PreemptionDeniedPayload)

  // ── scheduler.fair_share_starvation ────────────────────────────────
  // Fired by the scheduler admission path when a principal has eligible work but
  // its last_serviced_at lag exceeds fair_share_window_ms AND no slot
  // could be granted in this batch. Signals fair-share invariant
  // violation — operator should investigate.
  export const FairShareStarvationPayload = z.object({
    principal_id: z.string().min(1),
    waited_ms: z.number().int().nonnegative(),
  })
  export const FairShareStarvation = BusEvent.define("scheduler.fair_share_starvation", FairShareStarvationPayload)

  /** Discriminated-union convenience type for subscribers. */
  export type Any =
    | { type: typeof PrincipalCapped.type; properties: z.infer<typeof PrincipalCappedPayload> }
    | { type: typeof PrincipalThrottled.type; properties: z.infer<typeof PrincipalThrottledPayload> }
    | { type: typeof Preempted.type; properties: z.infer<typeof PreemptedPayload> }
    | { type: typeof PreemptionDenied.type; properties: z.infer<typeof PreemptionDeniedPayload> }
    | { type: typeof FairShareStarvation.type; properties: z.infer<typeof FairShareStarvationPayload> }
}
