/**
 * facts.ts — the Fact discriminated union and canonical-key derivation.
 *
 * A Fact is the unit a plugin emits. Each kind wraps an existing row type
 * from `../contracts/common.ts` so the FactBus can pass facts straight
 * through to the storage sink without an intermediate translation.
 *
 * Plugins do NOT construct Fact objects directly. They call the builder
 * methods on `ctx` (`ctx.symbol(...)`, `ctx.edge(...)`, `ctx.evidence(...)`,
 * `ctx.observation(...)`), which build the envelope and apply auto-
 * provenance from the extractor's name. The *FactInput types are the input
 * shape those builders accept.
 *
 * The canonicalKey() function derives a deterministic dedup key for each
 * fact. Two facts with the same canonical key are considered the same fact,
 * and the FactBus merges their provenance instead of writing twice.
 */

import type {
  AggregateFieldRow,
  EdgeRow,
  EvidenceRef,
  SourceLocation,
  SymbolRow,
  TypeRow,
} from "../contracts/common.js"

// ---------------------------------------------------------------------------
// Envelope shared by every fact
// ---------------------------------------------------------------------------

/**
 * Provenance metadata attached to every fact by the FactBus on first emit.
 *
 * `producedBy` is a list because multiple plugins can independently produce
 * the same fact (canonical-key match). The bus appends to this list on dedup
 * rather than overwriting.
 *
 * `confidence` is a numeric score in [0, 1]. Plugins set it when they emit;
 * the bus does not modify it. When two facts merge, the bus keeps the higher
 * confidence (the assumption being that more evidence is better).
 */
export interface FactEnvelope {
  /** Producer chain. Set by FactBus on first emit; appended on dedup. */
  producedBy: readonly string[]
  /** Numeric confidence in [0, 1]. */
  confidence: number
}

// ---------------------------------------------------------------------------
// Fact variants — discriminated union
// ---------------------------------------------------------------------------

export interface SymbolFact extends FactEnvelope {
  kind: "symbol"
  payload: SymbolRow
}

export interface TypeFact extends FactEnvelope {
  kind: "type"
  payload: TypeRow
}

export interface AggregateFieldFact extends FactEnvelope {
  kind: "aggregate-field"
  payload: AggregateFieldRow
}

export interface EdgeFact extends FactEnvelope {
  kind: "edge"
  payload: EdgeRow
}

/**
 * EvidenceFact is a standalone evidence record that can be attached to an
 * already-emitted Symbol or Edge fact later in the same snapshot. Most
 * plugins do not need this — they pass evidence inline when emitting a
 * symbol or edge. EvidenceFact exists for the case where one plugin
 * discovers a fact and a later plugin discovers additional evidence for
 * the same fact.
 */
export interface EvidenceFact extends FactEnvelope {
  kind: "evidence"
  payload: EvidenceRef
  /** Identifies the fact this evidence supports. */
  attachedTo: { factKind: "edge" | "symbol"; canonicalKey: string }
}

/**
 * Observation is a runtime/dynamic fact about a subject (e.g. "this function
 * was called from this stack frame in this trace"). Distinct from Evidence,
 * which is static-source evidence for a structural fact.
 */
export interface ObservationFact extends FactEnvelope {
  kind: "observation"
  payload: {
    /** Human-readable observation kind, e.g. "runtime_callsite_seen". */
    observationKind: string
    /** Subject this observation is about (symbol name, edge id, etc.). */
    subject: string
    /** ISO timestamp string. */
    observedAt: string
    /** Free-form payload — parser/runtime specific. */
    data?: Record<string, unknown>
    /** Optional source location. */
    location?: SourceLocation
  }
}

export type Fact = SymbolFact | TypeFact | AggregateFieldFact | EdgeFact | EvidenceFact | ObservationFact

export type FactKind = Fact["kind"]

// ---------------------------------------------------------------------------
// FactInput types — what plugins pass to ctx builders
// ---------------------------------------------------------------------------
//
// These are slimmer than the full Fact types: the envelope (producedBy,
// confidence) is filled in by the builder, not the caller. confidence
// defaults to 1.0 if omitted.

export interface SymbolFactInput {
  payload: SymbolRow
  confidence?: number
}

export interface TypeFactInput {
  payload: TypeRow
  confidence?: number
}

export interface AggregateFieldFactInput {
  payload: AggregateFieldRow
  confidence?: number
}

export interface EdgeFactInput {
  payload: EdgeRow
  confidence?: number
}

export interface EvidenceFactInput {
  payload: EvidenceRef
  attachedTo: { factKind: "edge" | "symbol"; canonicalKey: string }
  confidence?: number
}

export interface ObservationFactInput {
  payload: ObservationFact["payload"]
  confidence?: number
}

// ---------------------------------------------------------------------------
// canonicalKey — deterministic dedup key per fact
// ---------------------------------------------------------------------------

/**
 * Derive a deterministic dedup key for a fact. Two facts with the same key
 * are considered the same fact; the FactBus merges their provenance and
 * keeps the higher-confidence payload.
 *
 * Key shape conventions:
 *  - Symbols are keyed by (kind, qualified-or-unqualified name, location).
 *    A function declared in two files is two distinct facts, intentionally.
 *  - Types are keyed by (kind, spelling, attaching symbol).
 *  - Aggregate fields are keyed by (parent symbol, field name, ordinal).
 *  - Edges are keyed by (edge kind, src→dst, source location). The source
 *    location is critical: the same caller may invoke the same callee from
 *    multiple sites and each is a distinct fact.
 *  - Evidence is keyed by what it attaches to plus its own kind+location.
 *  - Observations are keyed by (kind, subject, timestamp). Two observations
 *    with the same timestamp on the same subject are considered the same
 *    event (e.g. multiple parsers reporting the same trace line).
 *
 * Anything missing from the row falls through to an empty string segment;
 * this is fine because the segments are joined with separators that
 * disambiguate.
 */
export function canonicalKey(fact: Fact): string {
  switch (fact.kind) {
    case "symbol": {
      const p = fact.payload
      const loc = p.location ? `${p.location.filePath}:${p.location.line}` : ""
      const name = p.qualifiedName ?? p.name
      return `symbol|${p.kind}|${name}|${loc}`
    }
    case "type": {
      const p = fact.payload
      return `type|${p.kind}|${p.spelling}|${p.symbolName ?? ""}`
    }
    case "aggregate-field": {
      const p = fact.payload
      return `field|${p.aggregateSymbolName}|${p.name}|${p.ordinal}`
    }
    case "edge": {
      const p = fact.payload
      const loc = p.sourceLocation ? `${p.sourceLocation.sourceFilePath}:${p.sourceLocation.sourceLineNumber}` : ""
      return `edge|${p.edgeKind}|${p.srcSymbolName ?? ""}->${p.dstSymbolName ?? ""}|${loc}`
    }
    case "evidence": {
      const a = fact.attachedTo
      const loc = fact.payload.location ? `${fact.payload.location.filePath}:${fact.payload.location.line}` : ""
      return `evidence|${a.factKind}|${a.canonicalKey}|${fact.payload.sourceKind}|${loc}`
    }
    case "observation": {
      const p = fact.payload
      return `obs|${p.observationKind}|${p.subject}|${p.observedAt}`
    }
  }
}

// ---------------------------------------------------------------------------
// mergeFacts — combine two facts that share a canonical key
// ---------------------------------------------------------------------------

/**
 * Merge two facts with the same canonical key. Unions `producedBy` and
 * keeps the higher `confidence`; payload follows the higher-confidence
 * record (ties → existing wins).
 *
 * Exported so FactBus and FakeFactBus share one definition — if this
 * logic drifts, dedup semantics drift, and the port contract breaks.
 */
export function mergeFacts(existing: Fact, incoming: Fact): Fact {
  const producers = new Set<string>(existing.producedBy)
  for (const p of incoming.producedBy) producers.add(p)
  const winner = incoming.confidence > existing.confidence ? incoming : existing
  return {
    ...winner,
    producedBy: Array.from(producers),
    confidence: Math.max(existing.confidence, incoming.confidence),
  } as Fact
}

// ---------------------------------------------------------------------------
// Validation — used by FactBus before accepting a fact
// ---------------------------------------------------------------------------

export class FactValidationError extends Error {
  constructor(
    public readonly factKind: FactKind,
    public readonly reason: string,
    public readonly producedBy: readonly string[],
  ) {
    super(`[fact-validation] ${factKind} from ${producedBy.join(",") || "<unknown>"}: ${reason}`)
  }
}

/**
 * Validate that a fact is well-formed enough to accept into the bus. Returns
 * undefined on success; throws FactValidationError on failure with a clear
 * description of which producer emitted what offending fact.
 *
 * The validation rules are intentionally minimal: only fields that are
 * required for canonical-key derivation, dedup, and downstream SQLite writes
 * are checked. Schema-level richness checks (e.g. is this confidence value
 * sensible) are out of scope here — they belong to the query layer.
 */
export function validateFact(fact: Fact): void {
  if (typeof fact.confidence !== "number" || Number.isNaN(fact.confidence)) {
    throw new FactValidationError(
      fact.kind,
      `confidence must be a number, got ${typeof fact.confidence}`,
      fact.producedBy,
    )
  }
  if (fact.confidence < 0 || fact.confidence > 1) {
    throw new FactValidationError(fact.kind, `confidence must be in [0,1], got ${fact.confidence}`, fact.producedBy)
  }
  if (!Array.isArray(fact.producedBy) || fact.producedBy.length === 0) {
    throw new FactValidationError(fact.kind, "producedBy must be a non-empty array", fact.producedBy)
  }

  switch (fact.kind) {
    case "symbol": {
      if (!fact.payload.name) {
        throw new FactValidationError(fact.kind, "symbol.name is required", fact.producedBy)
      }
      if (!fact.payload.kind) {
        throw new FactValidationError(fact.kind, "symbol.kind is required", fact.producedBy)
      }
      return
    }
    case "type": {
      if (!fact.payload.spelling) {
        throw new FactValidationError(fact.kind, "type.spelling is required", fact.producedBy)
      }
      if (!fact.payload.kind) {
        throw new FactValidationError(fact.kind, "type.kind is required", fact.producedBy)
      }
      return
    }
    case "aggregate-field": {
      if (!fact.payload.aggregateSymbolName || !fact.payload.name) {
        throw new FactValidationError(
          fact.kind,
          "aggregate-field requires aggregateSymbolName and name",
          fact.producedBy,
        )
      }
      return
    }
    case "edge": {
      if (!fact.payload.edgeKind) {
        throw new FactValidationError(fact.kind, "edge.edgeKind is required", fact.producedBy)
      }
      if (!fact.payload.srcSymbolName && !fact.payload.dstSymbolName) {
        throw new FactValidationError(
          fact.kind,
          "edge requires at least one of srcSymbolName or dstSymbolName",
          fact.producedBy,
        )
      }
      if (!fact.payload.derivation) {
        throw new FactValidationError(fact.kind, "edge.derivation is required", fact.producedBy)
      }
      return
    }
    case "evidence": {
      if (!fact.attachedTo?.canonicalKey) {
        throw new FactValidationError(fact.kind, "evidence requires attachedTo.canonicalKey", fact.producedBy)
      }
      if (!fact.payload.sourceKind) {
        throw new FactValidationError(fact.kind, "evidence.payload.sourceKind is required", fact.producedBy)
      }
      return
    }
    case "observation": {
      if (!fact.payload.observationKind || !fact.payload.subject) {
        throw new FactValidationError(fact.kind, "observation requires observationKind and subject", fact.producedBy)
      }
      return
    }
  }
}
