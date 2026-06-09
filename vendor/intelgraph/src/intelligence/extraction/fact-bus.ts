/**
 * fact-bus.ts — the FactBus.
 *
 * Receives Facts from plugin extractors, validates them, deduplicates by
 * canonical key, tags provenance, batches the result, and flushes batches
 * to the existing GraphWriteSink. This is the layer that handles every
 * "hard part" of fact ingestion so plugin authors don't have to.
 *
 * Responsibilities (the contract with plugin authors):
 *   1. Validation — every fact runs through validateFact() before being
 *      accepted; bad facts throw FactValidationError with a clear message
 *      naming the offending plugin.
 *   2. Deduplication — facts with the same canonical key are merged. The
 *      first writer's payload is kept (last-writer-wins on conflict is
 *      out of scope for Problem 1) but the provenance list grows.
 *   3. Provenance — every accepted fact carries a producedBy list that
 *      records which extractor(s) emitted it.
 *   4. Confidence — when two facts merge, the higher confidence wins. The
 *      assumption is "more evidence is better."
 *   5. Batching — facts accumulate until the configurable buffer size is
 *      hit, then flush in one GraphWriteBatch. close() flushes whatever
 *      remains.
 *   6. Counters — per-kind counts and per-extractor counts are tracked so
 *      the runner's IngestReport can report them.
 *
 * Position in the pipeline: ExtractorRunner → FactBus → GraphWriteSink.
 *
 * What the bus deliberately does NOT do (deferred to later steps/problems):
 *   - Conflict resolution between disagreeing facts (last-writer-wins;
 *     proper resolution is a query-time concern).
 *   - Storage abstraction — Problem 3 will introduce IGraphStore. For now
 *     the bus writes directly through GraphWriteSink.
 *   - Persistent dedup across snapshots — every snapshot starts with a
 *     fresh bus.
 */

import type {
  GraphEdgeRow,
  GraphEvidenceRow,
  GraphNodeRow,
  GraphObservationRow,
  GraphWriteBatch,
  GraphWriteSink,
} from "../db/graph-rows.js"
import { edgeRow, evidenceRow, symbolNode } from "../db/graph-rows.js"
import type { IFactBus, FactBusReport } from "../contracts/fact-bus.js"
import {
  type Fact,
  type FactKind,
  type SymbolFact,
  type EdgeFact,
  type EvidenceFact,
  type ObservationFact,
  type TypeFact,
  type AggregateFieldFact,
  canonicalKey,
  mergeFacts,
  validateFact,
} from "./facts.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FactBusOptions {
  /** Snapshot id every emitted fact will be associated with. */
  snapshotId: number
  /** Where to flush converted batches. */
  sink: GraphWriteSink
  /**
   * Flush threshold: when total buffered facts (across all kinds) reach
   * this number, the bus flushes automatically. close() flushes the
   * remainder regardless of size. Default: 500.
   */
  flushThreshold?: number
  /** Optional logger for diagnostic events. */
  logger?: FactBusLogger
}

export interface FactBusLogger {
  debug(event: string, context: Record<string, unknown>): void
  warn(event: string, context: Record<string, unknown>): void
}

// ---------------------------------------------------------------------------
// FactBus
// ---------------------------------------------------------------------------

const DEFAULT_FLUSH_THRESHOLD = 500

export class FactBus implements IFactBus {
  private readonly snapshotId: number
  private readonly sink: GraphWriteSink
  private readonly flushThreshold: number
  private readonly logger: FactBusLogger

  // Per-kind dedup maps. Using one map per kind keeps key collisions
  // impossible across kinds (canonical keys already namespace by kind, but
  // splitting the maps makes flush() faster too).
  private readonly symbols = new Map<string, SymbolFact>()
  private readonly types = new Map<string, TypeFact>()
  private readonly aggregateFields = new Map<string, AggregateFieldFact>()
  private readonly edges = new Map<string, EdgeFact>()
  private readonly evidence = new Map<string, EvidenceFact>()
  private readonly observations = new Map<string, ObservationFact>()

  // Counters
  private totalEmits = 0
  private totalAccepted = 0
  private byKind: Record<FactKind, number> = {
    symbol: 0,
    type: 0,
    "aggregate-field": 0,
    edge: 0,
    evidence: 0,
    observation: 0,
  }
  private byExtractor: Record<string, number> = {}
  private flushCount = 0
  private closedFlag = false

  constructor(opts: FactBusOptions) {
    this.snapshotId = opts.snapshotId
    this.sink = opts.sink
    this.flushThreshold = opts.flushThreshold ?? DEFAULT_FLUSH_THRESHOLD
    this.logger = opts.logger ?? { debug: () => {}, warn: () => {} }
  }

  /**
   * Emit a fact into the bus. Plugin code does not call this directly —
   * the ctx.symbol/edge/evidence/observation builders call it on their
   * behalf with provenance auto-tagged.
   *
   * Throws FactValidationError if the fact fails validation. Returns the
   * fact that ended up in the buffer (which may be the same fact, or an
   * existing fact whose provenance was merged with this one).
   */
  async emit(fact: Fact): Promise<Fact> {
    if (this.closedFlag) {
      throw new Error("[fact-bus] cannot emit on a closed bus")
    }

    validateFact(fact)
    this.totalEmits++

    const key = canonicalKey(fact)
    const existing = this.lookupExisting(fact.kind, key)

    let stored: Fact
    if (existing) {
      stored = this.merge(existing, fact)
      this.replaceExisting(stored.kind, key, stored)
      this.logger.debug("fact-bus:dedup", {
        kind: fact.kind,
        canonicalKey: key,
        producedBy: stored.producedBy,
      })
    } else {
      this.storeNew(fact.kind, key, fact)
      this.totalAccepted++
      this.byKind[fact.kind]++
      for (const producer of fact.producedBy) {
        this.byExtractor[producer] = (this.byExtractor[producer] ?? 0) + 1
      }
      stored = fact
    }

    if (this.bufferSize() >= this.flushThreshold) {
      await this.flush()
    }

    return stored
  }

  /**
   * Force a flush. The buffered facts are converted to a GraphWriteBatch
   * and handed to the sink. The dedup maps are cleared, so subsequent
   * emits start fresh — but counters persist for the report.
   *
   * Idempotent: calling flush() on an empty buffer is a no-op.
   */
  async flush(): Promise<void> {
    if (this.bufferSize() === 0) return
    const batch = this.buildBatch()
    this.logger.debug("fact-bus:flush:start", {
      nodes: batch.nodes.length,
      edges: batch.edges.length,
      evidence: batch.evidence.length,
      observations: batch.observations.length,
    })
    await this.sink.write(batch)
    this.flushCount++
    this.symbols.clear()
    this.types.clear()
    this.aggregateFields.clear()
    this.edges.clear()
    this.evidence.clear()
    this.observations.clear()
    this.logger.debug("fact-bus:flush:done", { flushCount: this.flushCount })
  }

  /**
   * Flush remaining facts and mark the bus closed. Subsequent emit() calls
   * throw. Use this from the runner after every plugin completes.
   */
  async close(): Promise<void> {
    if (this.closedFlag) return
    await this.flush()
    this.closedFlag = true
  }

  /**
   * Per-snapshot accounting for the runner's IngestReport.
   */
  report(): FactBusReport {
    return {
      totalAccepted: this.totalAccepted,
      totalEmits: this.totalEmits,
      byKind: { ...this.byKind },
      byExtractor: { ...this.byExtractor },
      flushCount: this.flushCount,
      closed: this.closedFlag,
    }
  }

  /** Total facts currently buffered (across all kinds). */
  private bufferSize(): number {
    return (
      this.symbols.size +
      this.types.size +
      this.aggregateFields.size +
      this.edges.size +
      this.evidence.size +
      this.observations.size
    )
  }

  // -------------------------------------------------------------------------
  // Per-kind storage helpers
  // -------------------------------------------------------------------------

  private lookupExisting(kind: FactKind, key: string): Fact | undefined {
    switch (kind) {
      case "symbol":
        return this.symbols.get(key)
      case "type":
        return this.types.get(key)
      case "aggregate-field":
        return this.aggregateFields.get(key)
      case "edge":
        return this.edges.get(key)
      case "evidence":
        return this.evidence.get(key)
      case "observation":
        return this.observations.get(key)
    }
  }

  private storeNew(kind: FactKind, key: string, fact: Fact): void {
    switch (kind) {
      case "symbol":
        this.symbols.set(key, fact as SymbolFact)
        return
      case "type":
        this.types.set(key, fact as TypeFact)
        return
      case "aggregate-field":
        this.aggregateFields.set(key, fact as AggregateFieldFact)
        return
      case "edge":
        this.edges.set(key, fact as EdgeFact)
        return
      case "evidence":
        this.evidence.set(key, fact as EvidenceFact)
        return
      case "observation":
        this.observations.set(key, fact as ObservationFact)
        return
    }
  }

  private replaceExisting(kind: FactKind, key: string, fact: Fact): void {
    this.storeNew(kind, key, fact)
  }

  // -------------------------------------------------------------------------
  // Merge — combine an incoming fact with an existing one
  // -------------------------------------------------------------------------

  private merge(existing: Fact, incoming: Fact): Fact {
    return mergeFacts(existing, incoming)
  }

  // -------------------------------------------------------------------------
  // Convert buffered facts to a GraphWriteBatch
  // -------------------------------------------------------------------------

  private buildBatch(): GraphWriteBatch {
    const nodes: GraphNodeRow[] = []
    const edges: GraphEdgeRow[] = []
    const evidence: GraphEvidenceRow[] = []
    const observations: GraphObservationRow[] = []

    // Symbols → graph nodes
    for (const fact of this.symbols.values()) {
      nodes.push(this.injectProvenance(symbolNode(this.snapshotId, fact.payload), fact))
    }

    // Edges → graph edges (and inline evidence if present)
    for (const fact of this.edges.values()) {
      const er = edgeRow(this.snapshotId, fact.payload)
      edges.push(this.injectProvenance(er, fact))
      if (fact.payload.evidence) {
        const ev = evidenceRow(this.snapshotId, er.edge_id, fact.payload.evidence)
        if (ev) evidence.push(this.injectProvenance(ev, fact))
      }
    }

    // Standalone evidence → graph evidence rows
    for (const fact of this.evidence.values()) {
      // Standalone evidence references an existing fact by canonical key.
      // The storage layer keys evidence by edge_id, so we synthesize one
      // from the attached fact's canonical key. The query layer can
      // re-resolve by canonical key when needed.
      const synthesizedId = `synth-evidence:${fact.attachedTo.canonicalKey}`
      evidence.push(
        this.injectProvenance(
          {
            snapshot_id: this.snapshotId,
            evidence_id: synthesizedId,
            edge_id: fact.attachedTo.factKind === "edge" ? synthesizedId : undefined,
            node_id: fact.attachedTo.factKind === "symbol" ? synthesizedId : undefined,
            source_kind: fact.payload.sourceKind,
            location: fact.payload.location,
            payload: fact.payload.raw ?? {},
          },
          fact,
        ),
      )
    }

    // Observations → graph observation rows
    for (const fact of this.observations.values()) {
      observations.push(
        this.injectProvenance(
          {
            snapshot_id: this.snapshotId,
            observation_id: `obs:${fact.payload.observationKind}:${fact.payload.subject}:${fact.payload.observedAt}`,
            node_id: fact.payload.subject,
            kind: fact.payload.observationKind,
            observed_at: fact.payload.observedAt,
            confidence: fact.confidence,
            payload: { ...(fact.payload.data ?? {}), location: fact.payload.location },
          },
          fact,
        ),
      )
    }

    // TypeFact and AggregateFieldFact are not written to SQLite yet —
    // matches the existing materializeSnapshot() behavior which only
    // counts them in the report. Once Problem 3 lands and IGraphStore
    // adds proper type/field tables, these get serialized too.

    return { nodes, edges, evidence, observations }
  }

  /**
   * Embed provenance into the row's payload/metadata so it survives the
   * storage round-trip. Plugins downstream of the bus can read producedBy
   * from the row metadata to do their own attribution.
   */
  private injectProvenance<
    T extends { payload?: Record<string, unknown>; metadata?: Record<string, unknown> },
  >(row: T, fact: Fact): T {
    const provenance = {
      producedBy: fact.producedBy,
      busConfidence: fact.confidence,
    }
    if ("metadata" in row && row.metadata) {
      return { ...row, metadata: { ...row.metadata, _provenance: provenance } }
    }
    if ("payload" in row && row.payload) {
      return { ...row, payload: { ...row.payload, _provenance: provenance } }
    }
    return row
  }
}
