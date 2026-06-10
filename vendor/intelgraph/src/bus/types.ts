/**
 * Shared primitive types for the intelgraph bus layer.
 * No logic lives here — only type definitions used by all three bus interfaces.
 *
 * See project/specification/ for full contracts and behavioral semantics.
 */

// ── Disposable ────────────────────────────────────────────────────────────────
// Project targets ES2022. Native `using` / Symbol.dispose is ES2023.
// We define our own until the target is raised.

export interface Disposable {
  dispose(): void
}

// ── Command (RequestBus) ──────────────────────────────────────────────────────

/**
 * Base type for all commands sent via RequestBus.
 *
 * `__response` is a phantom field: it is never present at runtime.
 * TypeScript uses it to infer the return type of `RequestBus.send()`.
 *
 * Modules declare their commands in `commands.ts`:
 *
 *   export interface RunQueryCommand extends Command<"query", QueryRequest, NormalizedQueryResponse> {}
 *
 * The composition root unions all per-module command types into `AppCommandMap`.
 */
export interface Command<Name extends string = string, Payload = unknown, Response = unknown> {
  readonly kind: Name
  readonly payload: Payload
  readonly __response?: Response
}

// ── BusEvent (EventBus) ───────────────────────────────────────────────────────

/**
 * Base type for all events emitted via EventBus.
 *
 * `at` (epoch ms) is stamped by the bus at emit time.
 * Emitters must NOT set `at` — the bus ignores any value passed in.
 *
 * Modules declare their events in `events.ts`:
 *
 *   export interface SnapshotCommittedEvent
 *     extends BusEvent<"snapshot.committed", { id: number; durationMs: number }> {}
 *
 * The composition root unions all per-module event types into `AppEventMap`.
 */
export interface BusEvent<Name extends string = string, Payload = unknown> {
  readonly kind: Name
  readonly payload: Payload
  readonly at: number
}

// ── StreamSink (StreamBus) ────────────────────────────────────────────────────

/**
 * The single consumer of batches flushed by StreamBus<T>.
 * For the extraction pipeline, implemented by GraphWriteSink (SQLite).
 */
export interface StreamSink<T> {
  write(batch: T[]): Promise<void>
}
