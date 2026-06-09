/**
 * @intelgraph/fakes — in-memory implementations of every intelgraph
 * port for downstream frontend unit testing.
 *
 * Import path: `@opencode-ai/intelgraph/fakes`
 *
 * Every fake ships the same behavior envelope as the contract-test
 * suite asserts. Consumers (tui-relation-window, future web UIs, test
 * harnesses, CI tools) use these instead of hand-rolled mocks so that
 * their tests stay aligned with the canonical backend contract.
 *
 * When a backend impl and a fake diverge, the shared contract-test
 * suite fails — so adopting a fake is how a consumer locks itself to
 * the contract, not to a specific implementation.
 */

// Intelligence-module ports
export {
  FakeDbFoundation,
  FakeSnapshotIngestWriter,
  FakeDbLookup,
  FakeExtractionAdapter,
  FakeFactBus,
  FakeIndirectCallerIngestion,
  FakeQueryNodeAdapter,
} from "./intelligence/contracts/fakes/index.js"

// Daemon-module port
export { FakeDaemonManager } from "./daemon/fakes/index.js"

// Logging-module port
export { FakeLogger } from "./logging/fakes/index.js"

// Config-module port
export { FakeConfigLoader } from "./config/fakes/index.js"

// Plugins-module port
export { FakePluginRegistry } from "./plugins/fakes/index.js"

// Tools-module ports
export {
  FakeToolDispatcher,
  FakeIndirectCallerCache,
  FakeIndirectCallerProvider,
  FakeReasonEngine,
  FakeCallerResolver,
} from "./tools/fakes/index.js"

// Re-export the port interfaces so consumers can type against them
// without a second import line.
export type {
  IDbFoundation,
  ISnapshotIngestWriter,
  SnapshotIngestBatch,
} from "./intelligence/contracts/db-foundation.js"
export type { IFactBus, FactBusReport } from "./intelligence/contracts/fact-bus.js"
export type {
  DbLookupRepository,
  QueryRequest,
  LookupResult,
  NormalizedQueryResponse,
  QueryIntent,
  FallbackPolicy,
  DeterministicEnricherSource,
  EnricherSource,
  EnrichmentAttempt,
  EnrichmentResult,
  OrchestrationAction,
  OrchestrationState,
  PersistenceContracts,
  AuthoritativeSnapshotRepository,
  GraphProjectionRepository,
  ClangdEnricher,
  CParserEnricher,
  LlmEnricher,
  EnricherContext,
} from "./intelligence/contracts/orchestrator.js"
export type {
  IExtractionAdapter,
  ExtractionInput,
  ExtractionBatches,
  SymbolBatch,
  TypeBatch,
  EdgeBatch,
} from "./intelligence/contracts/extraction-adapter.js"
export type {
  IQueryNodeAdapter,
  LegacyFlatResponse,
} from "./intelligence/contracts/query-node-adapter.js"
export type {
  IIndirectCallerIngestion,
  RuntimeCallerInput,
  RuntimeCallerBatch,
  LinkReport,
} from "./intelligence/contracts/indirect-caller-ingestion.js"
export type {
  IngestReport,
  SnapshotRef,
  SnapshotMeta,
  SourceLocation,
  EvidenceRef,
  SymbolRow,
  TypeRow,
  AggregateFieldRow,
  EdgeRow,
  EdgeKind,
  RuntimeCallerRow,
  RuntimeGraphNodeKind,
  RuntimeGraphParticipantRow,
  TimerTriggerRow,
  LogRow,
  LogLevel,
  GraphNode,
  GraphEdge,
  CallerGraph,
  CalleeGraph,
  Provenance,
} from "./intelligence/contracts/common.js"
export type { IDaemonManager } from "./daemon/ports.js"
export type { ILogger } from "./logging/ports.js"
export type {
  IConfigLoader,
  IntelgraphConfig,
  IndexState,
} from "./config/ports.js"
export type { IPluginRegistry } from "./plugins/ports.js"
export type {
  IToolDispatcher,
  IIndirectCallerCache,
  IIndirectCallerProvider,
  ICallerResolver,
  IndirectCallerQuery,
  CallerResolutionQuery,
  IndirectCallerGraph,
  IndirectCallerNode,
  GetCallersResponse,
} from "./tools/ports.js"
export type {
  IReasonEngine,
  ReasonEngineInput,
  ReasonEngineResult,
  ReasonPath,
  LlmReasoningConfig,
} from "./tools/reason-engine/ports.js"
