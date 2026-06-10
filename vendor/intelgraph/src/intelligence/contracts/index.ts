export type {
  AggregateFieldRow,
  CalleeGraph,
  CallerGraph,
  EdgeKind,
  EdgeRow,
  EvidenceRef,
  GraphEdge,
  GraphNode,
  IngestReport,
  Provenance,
  RuntimeCallerRow,
  RuntimeGraphNodeKind,
  RuntimeGraphParticipantRow,
  SnapshotMeta,
  SnapshotRef,
  SourceLocation,
  SymbolRow,
  TypeRow,
} from "./common.js"

export type { IDbFoundation, ISnapshotIngestWriter, SnapshotIngestBatch } from "./db-foundation.js"

export type { Fact, FactBusReport, FactKind, IFactBus } from "./fact-bus.js"

export type {
  EdgeBatch,
  ExtractionBatches,
  ExtractionInput,
  IExtractionAdapter,
  SymbolBatch,
  TypeBatch,
} from "./extraction-adapter.js"

export type {
  IIndirectCallerIngestion,
  LinkReport,
  RuntimeCallerBatch,
  RuntimeCallerInput,
} from "./indirect-caller-ingestion.js"

// ── query-request.ts — intents, request/response types, validation ────────────

export {
  RuntimeInvocationType,
  RuntimeStructureOperationType,
  RUNTIME_CONFIDENCE_DETERMINISTIC,
  RUNTIME_CONFIDENCE_INFERRED,
  RUNTIME_CONFIDENCE_FALLBACK,
  QUERY_INTENTS,
  parseQueryIntent,
  validateQueryRequest,
  validateResponseShape,
} from "./query-request.js"

export type {
  QueryIntent,
  QueryRequest,
  NormalizedQueryResponse,
  RuntimeFacetCompletenessStatus,
  RuntimeFacetCompletenessStatusMap,
} from "./query-request.js"

// ── enrichment.ts — enricher ports, fallback policy, orchestration SM ─────────

export { DEFAULT_FALLBACK_POLICY, decideOrchestrationAction, shouldRunLlmFallback } from "./enrichment.js"

export type {
  DeterministicEnricherSource,
  EnricherSource,
  FallbackPolicy,
  EnricherContext,
  EnrichmentAttempt,
  EnrichmentResult,
  ClangdEnricher,
  CParserEnricher,
  LlmEnricher,
  OrchestrationAction,
  OrchestrationState,
} from "./enrichment.js"

// ── orchestrator.ts — persistence repos, lookup contracts ─────────────────────

export type {
  AuthoritativeSnapshotRepository,
  DbLookupRepository,
  GraphProjectionRepository,
  LookupResult,
  PersistenceContracts,
} from "./orchestrator.js"

export type { OrchestratorRunnerDeps } from "./orchestrator-runner-deps.js"

// ── node-protocol.ts, query-node-adapter.ts ───────────────────────────────────

export { nodeResponseSchema } from "./node-protocol.js"
export type { NodeProtocolResponse } from "./node-protocol.js"

export type { IQueryNodeAdapter, LegacyFlatResponse } from "./query-node-adapter.js"

// ── graph.ts ──────────────────────────────────────────────────────────────────

export type { GraphJson, GraphJsonFilters, GraphDiff } from "./graph.js"
