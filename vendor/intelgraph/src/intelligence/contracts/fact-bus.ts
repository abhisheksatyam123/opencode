/**
 * IFactBus — port for the fact-ingestion bus sitting between plugin
 * extractors and the graph-write sink.
 *
 * Real impl: `FactBus` in `../extraction/fact-bus.ts`. It validates,
 * dedupes, provenance-tags, batches, and flushes Facts to a
 * `GraphWriteSink`.
 *
 * Fake impl: `FakeFactBus` in `./fakes/fact-bus.fake.ts`. Keeps an
 * in-memory log of accepted and flushed facts; does not touch a real
 * sink. Used by consumer unit tests and the port-contract suite.
 *
 * The port intentionally excludes the constructor shape (`FactBusOptions`
 * on the real impl is impl-specific: it names a `GraphWriteSink`, a
 * `snapshotId`, and a flush threshold, none of which the consumer sees).
 * Callers depend on the four instance methods below only.
 */

import type { Fact, FactKind } from "../extraction/facts.js"

/**
 * Live counters snapshot. Returned by `IFactBus.report()`. The real impl
 * owns this shape originally; it lives on the port so the fake doesn't
 * import from extraction/.
 */
export interface FactBusReport {
  /** Total facts accepted (post-dedup). */
  totalAccepted: number
  /** Total emit attempts (pre-dedup). dedup count = totalEmits - totalAccepted. */
  totalEmits: number
  /** Per-kind accepted counts. */
  byKind: Record<FactKind, number>
  /** Per-extractor accepted counts. */
  byExtractor: Record<string, number>
  /** Number of times the sink was written. */
  flushCount: number
  /** Whether the bus has been closed. */
  closed: boolean
}

export interface IFactBus {
  /**
   * Emit a fact into the bus. Validates, then dedupes by the fact's
   * canonical key. On dup, merges `producedBy` into a set-union and
   * keeps `max(confidence)`; returns the merged fact. On first write,
   * returns the fact as-is.
   *
   * Throws if the bus is closed, or if the fact fails validation.
   */
  emit(fact: Fact): Promise<Fact>

  /**
   * Flush buffered facts to the sink. Idempotent on an empty buffer
   * (does NOT increment flushCount in that case).
   */
  flush(): Promise<void>

  /**
   * Flush the remainder and mark the bus closed. Subsequent `emit()`
   * calls throw. Idempotent — calling twice is safe.
   */
  close(): Promise<void>

  /**
   * Snapshot of the bus's counters. Reflects state at the call site;
   * later emits do not mutate the returned object.
   */
  report(): FactBusReport
}

// Re-export the Fact types consumers need so downstream packages can
// import everything from the contracts barrel.
export type { Fact, FactKind } from "../extraction/facts.js"
