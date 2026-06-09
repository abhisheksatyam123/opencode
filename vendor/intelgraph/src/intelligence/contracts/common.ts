export interface SourceLocation {
  filePath: string
  line: number
  column?: number
}

export interface EvidenceRef {
  sourceKind: "file_line" | "clangd_response" | "log_line" | "runtime_parser"
  location?: SourceLocation
  raw?: Record<string, unknown>
}

export interface SnapshotMeta {
  workspaceRoot: string
  sourceRevision?: string
  compileDbHash: string
  parserVersion: string
  metadata?: Record<string, unknown>
}

export interface SnapshotRef {
  snapshotId: number
  createdAt: string
  status: "building" | "ready" | "failed"
}

export type EdgeKind =
  | "calls"
  | "runtime_calls"
  | "registers_callback"
  | "dispatches_to"
  | "reads_field"
  | "writes_field"
  | "uses_macro"
  | "logs_event"
  | "operates_on_struct"
  // ── language-agnostic structural edges (used by ts-core and future plugins)
  | "imports" // module A imports module B (file-to-file)
  | "contains" // module/namespace contains a symbol
  | "extends" // class extends class, interface extends interface
  | "implements" // class implements interface
  | "references_type" // symbol uses a type by name
  // ── data-structure edges (Phase 3 of the data-flow story)
  /** field → type the field declares (field-level, with containment metadata) */
  | "field_of_type"
  /** type → other type it aggregates structurally (rollup of field_of_type edges) */
  | "aggregates"

export type LogLevel = "ERROR" | "WARN" | "INFO" | "DEBUG" | "VERBOSE" | "TRACE" | "UNKNOWN"

export interface LogRow {
  /** API/function that emits this log. */
  apiName: string
  /** Log level extracted from the log macro (AR_DEBUG_PRINTF, WLAN_LOGD, etc.). */
  level: LogLevel
  /** Raw log format string (may contain %s, %d, etc.). */
  template: string
  /** Subsystem tag extracted from the log call (e.g. "BPF", "WMI", "HIF"). */
  subsystem?: string
  /** Source location of the log call. */
  location?: SourceLocation
  /** Confidence that this log is associated with the API. */
  confidence: number
  /** Evidence reference. */
  evidence?: EvidenceRef
}

export interface SymbolRow {
  kind:
    | "function"
    | "struct"
    | "union"
    | "enum"
    | "typedef"
    | "macro"
    | "global_var"
    | "field"
    | "param"
    // ── language-agnostic kinds for non-C plugins
    | "class"
    | "interface"
    | "namespace"
    | "module"
    | "method"
    // Phase 3d: structural data hierarchy
    /** Member of an enum (TS literal, Rust variant with optional payload). */
    | "enum_variant"
  name: string
  qualifiedName?: string
  signature?: string
  linkage?: "static" | "extern" | "none"
  location?: SourceLocation
  metadata?: Record<string, unknown>
}

export interface TypeRow {
  kind: "builtin" | "pointer" | "array" | "function_proto" | "struct" | "union" | "enum" | "typedef"
  spelling: string
  sizeBits?: number
  alignBits?: number
  symbolName?: string
}

export interface AggregateFieldRow {
  aggregateSymbolName: string
  name: string
  ordinal: number
  typeSpelling: string
  bitOffset?: number
  bitWidth?: number
  isBitfield?: boolean
}

export interface EdgeRow {
  edgeKind: EdgeKind
  srcSymbolName?: string
  dstSymbolName?: string
  confidence: number
  derivation: "clangd" | "llm" | "runtime" | "hybrid"
  evidence?: EvidenceRef
  metadata?: Record<string, unknown>
  /** Struct field access path expression, e.g. "bpf_vdev_t.state.filter_enabled". Stored in metadata JSONB as access_path. */
  accessPath?: string
  /** Source location of the struct access/operation. Stored in metadata JSONB as source_location. */
  sourceLocation?: { sourceFilePath: string; sourceLineNumber: number }
}

export type RuntimeGraphNodeKind =
  | SymbolRow["kind"]
  | "api"
  | "thread"
  | "signal"
  | "interrupt"
  | "timer"
  | "ring"
  | "module"
  | "hw_block"
  | "dispatch_table"
  | "message"
  | "log_point"
  | "unknown"

export interface RuntimeGraphParticipantRow {
  /** Stable display/canonical name for the runtime graph node. */
  name: string
  /** Graph node kind when the parser can infer it. */
  kind: RuntimeGraphNodeKind
  /** Optional source location of the participant declaration/registration site. */
  location?: SourceLocation
  /** Optional role label such as target, invoker, trigger, or context. */
  role?: string
  /** Free-form metadata captured by the parser. */
  metadata?: Record<string, unknown>
}

export interface RuntimeCallerRow {
  targetApi: string
  runtimeTrigger: string
  /** Ordered runtime path; entries may be APIs, signals, timers, interrupts, rings, or threads. */
  dispatchChain: string[]
  immediateInvoker: string
  dispatchSite: SourceLocation
  confidence: number
  evidence?: EvidenceRef
  /** Optional explicit kind/location hints for runtime graph node materialization. */
  participants?: RuntimeGraphParticipantRow[]
  /** Optional kind hint for the target node when it differs from plain C symbol extraction. */
  targetKind?: RuntimeGraphNodeKind
}

export interface TimerTriggerRow {
  /** API/function that is triggered by the timer. */
  apiName: string
  /** Identifier name of the timer (e.g. qdf_timer, os_timer, wlan_scan_timer). */
  timerIdentifierName: string
  /** Human-readable description of the condition that fires the timer. */
  timerTriggerConditionDescription?: string
  /** Confidence score that this timer triggers the API. */
  timerTriggerConfidenceScore: number
  /** How this relation was derived. */
  derivation: "clangd" | "llm" | "runtime" | "hybrid"
  /** Optional evidence reference. */
  evidence?: EvidenceRef
}

export interface IngestReport {
  snapshotId: number
  inserted: {
    symbols: number
    types: number
    fields: number
    edges: number
    runtimeCallers: number
    /** Number of RuntimeGraphParticipantRow entries materialized into graph nodes. 0 when runtimeCallers carry no participants. */
    participantsMaterialized: number
    logs: number
    timerTriggers: number
  }
  warnings: string[]
}

export interface GraphNode {
  id: string
  symbol: string
  kind: string
}

export interface GraphEdge {
  id: string
  kind: EdgeKind
  src: string
  dst: string
  confidence: number
  derivation: string
}

export interface CallerGraph {
  snapshotId: number
  apiName: string
  depth: number
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface CalleeGraph {
  snapshotId: number
  apiName: string
  depth: number
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface Provenance {
  edgeId: string
  evidence: EvidenceRef[]
}
