/**
 * EventBus<M> — typed in-process pub/sub event bus (1:N, fire-and-forget).
 *
 * Contract: project/specification/intelgraph-event-bus-contract.md
 *
 * Usage:
 *   const bus = new InProcessEventBus<AppEventMap>()
 *   bus.on("snapshot.committed", (evt) => logger.info("committed", evt.payload))
 *   bus.emit({ kind: "snapshot.committed", payload: { id: 42, durationMs: 120 } })
 */

import type { BusEvent, Disposable } from "./types.js"

export type { BusEvent, Disposable }

/**
 * Options for the EventBus implementation.
 * Handler errors are forwarded here; they never propagate to emitters.
 */
export interface EventBusOptions {
  onError?: (kind: string, err: unknown) => void
}

/**
 * Typed in-process pub/sub bus.
 *
 * M is the event map — a record from event kind string to a BusEvent type:
 *
 *   type AppEventMap = {
 *     "snapshot.committed": BusEvent<"snapshot.committed", { id: number; durationMs: number }>
 *     "plugin.completed":   BusEvent<"plugin.completed",   { name: string; facts: number }>
 *   }
 */
export interface EventBus<
  M extends Record<string, BusEvent> = Record<string, BusEvent>,
> {
  /**
   * Subscribe to events of kind `K`.
   *
   * Invariants:
   * - Multiple subscribers per kind are allowed (1:N).
   * - Subscribers fire in registration order (FIFO) per emit call.
   * - Handler errors are caught and forwarded to `onError`; they do not
   *   affect other subscribers or the emitter.
   * - Returns a Disposable. `dispose()` removes this subscription.
   */
  on<K extends keyof M & string>(
    kind: K,
    handler: (evt: M[K]) => void | Promise<void>,
  ): Disposable

  /**
   * Emit event — fire-and-forget.
   *
   * Invariants:
   * - `at` is set by the bus at emit time; any value on the input is ignored.
   * - Handlers are scheduled via `queueMicrotask` — they run after the
   *   current synchronous turn, before the next macrotask.
   * - Returns `void` synchronously; does NOT await handlers.
   * - After `dispose()`, `emit()` is a no-op (does not throw).
   */
  emit<K extends keyof M & string>(evt: Omit<M[K], "at">): void

  /**
   * Emit and await all handlers — for tests and graceful shutdown only.
   *
   * Invariants:
   * - Same scheduling as `emit()` but returns a Promise that resolves when
   *   all handlers for this emission have settled.
   * - Handler errors go to `onError`; the returned Promise still resolves.
   * - Must NOT be called on the hot path (tool dispatch, per-fact emit).
   */
  emitAwait<K extends keyof M & string>(evt: Omit<M[K], "at">): Promise<void>

  /**
   * Dispose the bus. All subscriptions are cleared.
   * Subsequent `emit()` calls are no-ops.
   * Already-scheduled microtask handlers may still run after `dispose()`.
   */
  dispose(): void
}
