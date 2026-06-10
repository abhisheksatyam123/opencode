/**
 * orchestrator.ts — Persistence port interfaces and lookup contracts.
 *
 * The query-intent surface lives in query-request.ts.
 * The enricher ports and orchestration state machine live in enrichment.ts.
 *
 * Re-exports from both are kept here so existing direct importers of
 * `contracts/orchestrator.ts` continue to compile without changes.
 */

import type { QueryRequest, QueryIntent } from "./query-request.js"
import type { EnrichmentResult } from "./enrichment.js"
import type { GraphJson, GraphJsonFilters } from "./graph.js"

// ── Re-exports for backward compatibility ────────────────────────────────────
// query-request.ts

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
  RuntimeFacetCompletenessStatus,
  RuntimeFacetCompletenessStatusMap,
  NormalizedQueryResponse,
} from "./query-request.js"

// enrichment.ts

export { DEFAULT_FALLBACK_POLICY, decideOrchestrationAction, shouldRunLlmFallback } from "./enrichment.js"

export type {
  DeterministicEnricherSource,
  EnricherSource,
  FallbackPolicy,
  EnricherContext,
  ClangdEnricher,
  CParserEnricher,
  LlmEnricher,
  EnrichmentAttempt,
  EnrichmentResult,
  OrchestrationAction,
  OrchestrationState,
} from "./enrichment.js"

export type { OrchestratorRunnerDeps } from "./orchestrator-runner-deps.js"

// ── Persistence port interfaces ───────────────────────────────────────────────

export interface DbLookupRepository {
  lookup(request: QueryRequest): Promise<LookupResult>
  /**
   * Build a node-link GraphJson from the persisted snapshot.
   * Optional: only SqliteDbLookup implements this. Callers check for its
   * presence via `typeof lookup.loadGraphJson === "function"` and return
   * a structured error when absent, rather than duck-typing at runtime.
   */
  loadGraphJson?(snapshotId: number, workspaceRoot: string, filters?: GraphJsonFilters): GraphJson
}

export interface AuthoritativeSnapshotRepository {
  persistEnrichment(request: QueryRequest, result: EnrichmentResult): Promise<number>
}

export interface GraphProjectionRepository {
  syncFromAuthoritative(snapshotId: number): Promise<{ synced: boolean; nodesUpserted: number; edgesUpserted: number }>
}

export interface PersistenceContracts {
  dbLookup: DbLookupRepository
  authoritativeStore: AuthoritativeSnapshotRepository
  graphProjection: GraphProjectionRepository
}

export interface LookupResult {
  hit: boolean
  intent: QueryIntent
  snapshotId: number
  rows: Array<Record<string, unknown>>
}
