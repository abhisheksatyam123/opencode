/**
 * StreamBus<T> — typed streaming/batching bus with validate/dedup/flush.
 *
 * Generalizes FactBus (src/intelligence/extraction/fact-bus.ts) to any item type.
 * For the extraction pipeline, T = Fact and the sink is GraphWriteSink.
 *
 * Contract: project/specification/intelgraph-stream-bus-contract.md
 *
 * Usage:
 *   const bus = createStreamBus<Fact>({
 *     validate: validateFact,
 *     canonicalKey: canonicalFactKey,
 *     merge: mergeByConfidence,
 *     flushThreshold: 500,
 *     sink: graphWriteSink,
 *   })
 *   await bus.emit(fact)
 *   await bus.close()
 */

import type { StreamSink } from "./types.js"

export type { StreamSink }

/**
 * Configuration for a StreamBus instance.
 * All functions (`validate`, `canonicalKey`, `merge`) are called synchronously
 * inside `emit()` and must not throw asynchronously.
 */
export interface StreamBusOptions<T> {
  /**
   * Validate an item before acceptance.
   * Must throw a descriptive error if the item is invalid.
   * Invalid items are rejected; `emit()` rejects with `StreamBusValidationError`.
   */
  validate: (item: T) => void

  /**
   * Compute a string deduplication key for an item.
   * Items with the same key within one batch are merged rather than appended.
   * Must be pure (same item → same key, always).
   */
  canonicalKey: (item: T) => string

  /**
   * Resolve a collision between two items with the same canonical key.
   * `existing` = first accepted item with this key in the current batch.
   * `incoming` = the new item with the same key.
   *
   * Default: first-writer wins (existing is returned unchanged).
   * Must be pure with no side effects.
   */
  merge?: (existing: T, incoming: T) => T

  /**
   * Flush when the buffer (post-dedup) reaches this many items.
   * Default: 500. Must be a positive integer.
   */
  flushThreshold?: number

  /** The single sink that receives each flush batch. */
  sink: StreamSink<T>
}

export interface StreamBusReport {
  /** Total `emit()` calls, including those that failed validation. */
  totalEmits: number
  /** Items accepted into the buffer (post-validation, first occurrence of each key). */
  totalAccepted: number
  /** Items merged (deduplicated) — same key appeared more than once in a batch. */
  totalMerged: number
  /** Number of `sink.write()` calls made. */
  flushCount: number
}

export interface StreamBus<T> {
  /**
   * Emit an item into the bus.
   *
   * Processing pipeline per item:
   *   1. `validate(item)` — rejects with `StreamBusValidationError` on failure.
   *   2. `canonicalKey(item)` — compute dedup key.
   *   3a. Key already in batch: `merge(existing, incoming)` → replace entry.
   *   3b. Key new: append item to batch; `totalAccepted++`.
   *   4. If `bufferSize() >= flushThreshold`: auto-flush (await `sink.write(batch)`).
   *
   * Invariants:
   * - `emit()` is async; awaiting it applies natural backpressure during flushes.
   * - After `close()`, throws `StreamBusClosedError`.
   * - On sink write error: `emit()` rejects; buffer is NOT cleared (no retry).
   */
  emit(item: T): Promise<void>

  /**
   * Flush remaining buffered items and permanently close the bus.
   *
   * Invariants:
   * - Flushes remaining buffer to sink if `bufferSize() > 0`.
   * - Does NOT call `sink.write([])` for an empty buffer.
   * - Idempotent: calling `close()` more than once is a no-op.
   * - After `close()`, `emit()` throws `StreamBusClosedError`.
   */
  close(): Promise<void>

  /** Count of items currently in the buffer (post-dedup within current batch). */
  bufferSize(): number

  /** Cumulative report since construction. Never reset between flushes. */
  report(): StreamBusReport
}
