// src/session/preemption-sweep.ts — Stage 10 (I10.2) async preemption loop.
// -------------------------------------------------------------------------
// Authoritative contracts:
//   project/software/opencode/architecture/scheduler-quota.md §Preemption flow
//   project/software/opencode/specification/contract/process-registry.md §Signature
//   project/software/opencode/specification/schema/quota-state.md §Field schema
//
// Why a sweep, not inline:
//   Per `scheduler-quota.md §Preemption flow`, preemption MUST run as
//   a background interval — inline checks in `the scheduler admission path` would
//   block dispatch on Permission.ask + ProcessRegistry.signal disk
//   writes. The sweep is fire-and-forget; failures degrade silently.
//
// Algorithm (per §Preemption flow):
//   for each principal P in quotaState.principals:
//     if P.tokens_used < scheduler.preemption_threshold_tokens: continue
//     pids = ProcessRegistry.list().filter(pcb => pcb.session_id === P.id
//                                              && pcb.state in {running, blocked})
//     if pids.empty(): continue
//     target = pickHighestConsumer(pids)
//       fallback: most-recently-spawned running pid (last-in-first-paused)
//     try ProcessRegistry.signal(target.pid, "pause")
//       success → emit `scheduler.preempted`
//       failure → emit `scheduler.preemption_denied`
//
// Reversibility:
//   • policy.scheduler.preemption_threshold_tokens absent → all checks
//     short-circuit, sweep is a no-op (Stage-2 behaviour preserved).
//   • policy.scheduler.preemption_check_ms absent → uses DEFAULT_INTERVAL_MS;
//     setting to 0 disables (start() refuses to schedule).
//   • Permission.ask is currently a no-op (permission system removed); the
//     contract still requires a single signal() call per target so the
//     gate can be re-introduced in a future stage without changing the
//     surface here.
// -------------------------------------------------------------------------

import { Log } from "@/foundation/util/log"
import { Bus } from "@/bus"
import { Policy } from "@/permission/policy"
import { Quota } from "@/process/session/quota"
import { ProcessRegistry } from "@/process/registry"
import { RegistryEvent } from "@/bus/registry-events"
import { SchedulerEvent } from "@/process/session/scheduler-events"
import type { BusEvent } from "@/bus/bus-event"
import type { z } from "zod"

export namespace PreemptionSweep {
  const log = Log.create({ service: "preemption-sweep" })

  /** Default tick interval when policy.scheduler.preemption_check_ms is absent. */
  export const DEFAULT_INTERVAL_MS = 5_000

  // ── Module state ────────────────────────────────────────────────────

  let timer: ReturnType<typeof setInterval> | null = null
  let inflight = false
  let sweepCount = 0

  // ── Lifecycle ──────────────────────────────────────────────────────

  /**
   * Resolve the configured tick interval (ms). Reads
   * `policy.scheduler.preemption_check_ms`. Returns `null` (=== "disabled")
   * when the key is explicitly null OR absent in a way that should keep
   * the sweep dormant (e.g. negative/zero interval).
   *
   * Stage-10 reversibility: if no policy value is present, fall back to
   * DEFAULT_INTERVAL_MS so an operator who deploys the binary without
   * editing policy still gets the safety net.
   */
  function resolveIntervalMs(): number | null {
    const sched = Policy.get("scheduler")
    const values = sched?.values as Record<string, unknown> | undefined
    const raw = values?.["preemption_check_ms"]
    if (raw === null) return null
    if (typeof raw !== "number") return DEFAULT_INTERVAL_MS
    if (!Number.isFinite(raw) || raw <= 0) return null
    return Math.floor(raw)
  }

  /**
   * Resolve the per-principal preemption threshold (tokens). Returns
   * `null` ("disabled") when the policy key is absent, null, or non-
   * positive. A null threshold short-circuits the sweep — every
   * principal is treated as below threshold.
   */
  function resolveThreshold(): number | null {
    const sched = Policy.get("scheduler")
    const values = sched?.values as Record<string, unknown> | undefined
    const raw = values?.["preemption_threshold_tokens"]
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null
    return Math.floor(raw)
  }

  /**
   * Start the sweep. Idempotent: a second call is a no-op as long as
   * the timer is live. Uses the policy-resolved interval at start time;
   * config changes require stop()+start() to take effect.
   */
  export function start(): void {
    if (timer !== null) return
    const intervalMs = resolveIntervalMs()
    if (intervalMs === null) {
      log.info("preemption-sweep.disabled", {
        reason: "policy.scheduler.preemption_check_ms is null/zero/negative",
      })
      return
    }
    timer = setInterval(() => {
      // Fire-and-forget. Errors caught inside tick(); never reject the timer.
      tick().catch((err) => {
        log.warn("preemption-sweep.tick.unhandled", {
          err: err instanceof Error ? err.message : String(err),
        })
      })
    }, intervalMs)
    // Allow Node to exit if this is the only thing keeping the loop alive.
    if (
      typeof timer === "object" &&
      timer &&
      "unref" in timer &&
      typeof (timer as NodeJS.Timeout).unref === "function"
    ) {
      ;(timer as NodeJS.Timeout).unref()
    }
    log.info("preemption-sweep.started", { intervalMs })
  }

  /** Stop the sweep. Idempotent. */
  export function stop(): void {
    if (timer === null) return
    clearInterval(timer)
    timer = null
    log.info("preemption-sweep.stopped")
  }

  /**
   * Run one sweep tick. Idempotent under concurrent invocation — second
   * caller short-circuits if a tick is already in flight (prevents
   * cascade when disk I/O is slow).
   *
   * Public for two reasons:
   *   1. Test seam — cells call tick() directly to avoid wall-clock waits.
   *   2. Operator gesture — manual "force preempt now" from a future CLI tool.
   */
  export async function tick(): Promise<void> {
    if (inflight) return
    inflight = true
    sweepCount++
    try {
      const threshold = resolveThreshold()
      if (threshold === null) {
        // Policy says preemption disabled — short-circuit.
        return
      }
      const state = await Quota.read()
      // Snapshot ProcessRegistry once per tick. registry.list() is a
      // frozen snapshot per L3 contract — no race with concurrent
      // registry mutations.
      const allPcbs = ProcessRegistry.list()

      for (const [principal_id, entry] of Object.entries(state.principals)) {
        if (principal_id === Quota.ENGINE_PRINCIPAL_ID) continue
        // Per-principal threshold OR fall back to global policy threshold.
        const perPrincipalCap = entry.preemption_threshold_tokens
        const effectiveCap = perPrincipalCap !== null ? perPrincipalCap : threshold
        if (entry.tokens_used < effectiveCap) continue

        // Find live pids for this principal in pause-eligible states.
        const pausable = allPcbs.filter(
          (pcb) => pcb.session_id === principal_id && (pcb.state === "running" || pcb.state === "blocked"),
        )
        if (pausable.length === 0) continue

        // pickHighestConsumer fallback: most-recently-spawned (last-in-
        // first-paused). Per §Preemption flow, this guarantees forward
        // progress without per-pid attribution at cost of fairness; a
        // future stage may add per-pid token attribution to PCB.
        const target = pausable.reduce((acc, cur) => (cur.started_at > acc.started_at ? cur : acc))

        try {
          await ProcessRegistry.signal(target.pid, "pause")
          await publishSchedulerEvent(SchedulerEvent.Preempted, {
            pid: target.pid,
            principal_id,
            reason: "token-burst",
          })
          log.warn("preemption-sweep.preempted", {
            pid: target.pid,
            principal_id,
            tokens_used: entry.tokens_used,
            cap: effectiveCap,
            agent: target.agent,
          })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          await publishSchedulerEvent(SchedulerEvent.PreemptionDenied, {
            pid: target.pid,
            principal_id,
            reason: message.slice(0, 280),
          })
          log.warn("preemption-sweep.signal.failed", {
            pid: target.pid,
            principal_id,
            err: message,
          })
        }
      }
    } catch (err) {
      log.warn("preemption-sweep.tick.failed", {
        err: err instanceof Error ? err.message : String(err),
      })
    } finally {
      inflight = false
    }
  }

  // ── ServiceLoader (init-registry ring-2 wiring) ───────────────────

  /**
   * ServiceLoader for InitRegistry boot. Depends on `process-registry`
   * (ring-1) — declared via the init card at
   * `<vault>/atomic/init/0070-preemption-sweep.md`.
   *
   * load() starts the timer; idempotent (re-boot is safe).
   */
  export const loader = {
    name: "preemption-sweep" as const,
    async load(): Promise<void> {
      start()
    },
  }

  // ── Test seams ─────────────────────────────────────────────────────

  /** @internal — tests inspect tick count to assert sweep activity. */
  export function _sweepCountForTest(): number {
    return sweepCount
  }

  /** @internal — tests reset module state between cells. */
  export function _resetForTest(): void {
    stop()
    inflight = false
    sweepCount = 0
  }

  // ── Internal helpers ──────────────────────────────────────────────

  async function publishSchedulerEvent<D extends BusEvent.Definition>(
    def: D,
    payload: z.output<D["properties"]>,
  ): Promise<void> {
    try {
      await Bus.publish(def, payload)
    } catch (err) {
      if (RegistryEvent.isBusNotBootstrapped(err)) return
      log.warn("preemption-sweep.bus.publish.failed", {
        type: def.type,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }
}
