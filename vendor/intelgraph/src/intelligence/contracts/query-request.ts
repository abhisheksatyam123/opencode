/**
 * query-request.ts — Query intent surface and request/response contracts.
 *
 * Contains the canonical list of query intents, the QueryRequest and
 * NormalizedQueryResponse types, and the two validation functions.
 * Extracted from orchestrator.ts to give this concern its own file.
 */

// ── Runtime type enums (used by the visualization layer) ────────────────────

export const enum RuntimeInvocationType {
  RUNTIME_DIRECT_CALL = "runtime_direct_call",
  RUNTIME_CALLBACK_REGISTRATION_CALL = "runtime_callback_registration_call",
  RUNTIME_FUNCTION_POINTER_CALL = "runtime_function_pointer_call",
  RUNTIME_DISPATCH_TABLE_CALL = "runtime_dispatch_table_call",
  RUNTIME_UNKNOWN_CALL_PATH = "runtime_unknown_call_path",
}

export const enum RuntimeStructureOperationType {
  RUNTIME_READ_FIELD_ACCESS = "runtime_read_field_access",
  RUNTIME_WRITE_FIELD_ASSIGNMENT = "runtime_write_field_assignment",
  RUNTIME_STRUCT_INITIALIZATION = "runtime_struct_initialization",
  RUNTIME_STRUCT_MUTATION = "runtime_struct_mutation",
  RUNTIME_STRUCT_OPERATION_UNKNOWN = "runtime_struct_operation_unknown",
}

export const RUNTIME_CONFIDENCE_DETERMINISTIC = 1.0
export const RUNTIME_CONFIDENCE_INFERRED = 0.7
export const RUNTIME_CONFIDENCE_FALLBACK = 0.4

// ── Query intents ────────────────────────────────────────────────────────────

export const QUERY_INTENTS = [
  "who_calls_api",
  "who_calls_api_at_runtime",
  "why_api_invoked",
  "what_api_calls",
  "show_registration_chain",
  "show_dispatch_sites",
  "find_callback_registrars",
  "where_struct_initialized",
  "where_struct_modified",
  "find_struct_owners",
  "find_struct_readers",
  "find_struct_writers",
  "find_field_access_path",
  "find_api_by_log_pattern",
  "show_runtime_flow_for_trace",
  "show_api_runtime_observations",
  "show_cross_module_path",
  "show_hot_call_paths",
  "find_api_logs",
  "find_api_logs_by_level",
  "find_api_timer_triggers",
  "find_api_struct_writes",
  "find_api_struct_reads",
  "find_module_imports",
  "find_module_dependents",
  "find_module_symbols",
  "find_class_inheritance",
  "find_class_subtypes",
  "find_interface_implementors",
  "find_type_dependencies",
  "find_type_consumers",
  "find_import_cycles",
  "find_top_imported_modules",
  "find_top_called_functions",
  "find_module_entry_points",
  "find_dead_exports",
  "find_call_chain",
  "find_symbols_by_name",
  "find_symbols_by_kind",
  "find_transitive_dependencies",
  "find_symbol_at_location",
  "find_long_functions",
  "find_external_imports",
  "find_module_summary",
  "find_class_summary",
  "find_type_summary",
  "find_api_summary",
  "find_entity_summary",
  "find_module_apis",
  "find_api_type_dependencies",
  "find_type_defining_module",
  "find_workspace_health",
  "analyze_problematic_modules",
  "analyze_god_classes",
  "analyze_type_health",
  "analyze_dead_code",
  "suggest_refactors",
  "generate_health_report",
  "generate_action_plan",
  "compare_snapshots",
  "compare_snapshots_modules",
  "find_symbols_in_file",
  "find_sibling_symbols",
  "find_module_top_exports",
  "find_import_cycles_deep",
  "find_symbol_degree",
  "find_module_interactions",
  "find_modules_overview",
  "find_type_cycles",
  "find_deepest_call_chain",
  "find_symbols_by_doc",
  "find_tightly_coupled_modules",
  "find_classes_by_method_count",
  "find_widely_referenced_types",
  "find_undocumented_exports",
  "find_top_implemented_interfaces",
  "find_orphan_modules",
  "find_largest_modules",
  "find_modules_by_directory",
  "find_field_type",
  "find_type_fields",
  "find_type_aggregates",
  "find_type_aggregators",
  "find_api_field_writes",
  "find_api_field_reads",
  "find_field_writers",
  "find_field_readers",
  "find_data_path",
  "find_struct_cycles",
  "find_api_data_footprint",
  "find_top_touched_types",
  "find_call_cycles",
  "find_top_field_writers",
  "find_top_field_readers",
  "find_unused_fields",
  "find_top_hot_fields",
  "find_classes_by_field_count",
  "find_field_co_access",
  "find_unique_callers",
  "find_recursive_methods",
  "find_god_methods",
] as const

export type QueryIntent = (typeof QUERY_INTENTS)[number]

export interface QueryRequest {
  intent: QueryIntent
  snapshotId: number
  apiName?: string
  /**
   * All alias variants of apiName to match in DB queries.
   * When set, the DB uses `= ANY(ARRAY[...])` instead of `= $n`.
   * Populated automatically by the orchestrator from canonicalizeSymbol().
   */
  apiNameAliases?: string[]
  structName?: string
  fieldName?: string
  traceId?: string
  pattern?: string
  logLevel?: "ERROR" | "WARN" | "INFO" | "DEBUG" | "VERBOSE" | "TRACE" | "UNKNOWN"
  srcApi?: string
  dstApi?: string
  depth?: number
  limit?: number
  /** File path (used by find_symbol_at_location for click-to-symbol). */
  filePath?: string
  /** 1-based line number (used by find_symbol_at_location). */
  lineNumber?: number
  timeRange?: { from?: string; to?: string }
}

export type RuntimeFacetCompletenessStatus =
  | "runtime_facet_data_fully_available"
  | "runtime_facet_data_partially_available"
  | "runtime_facet_data_not_yet_ingested"

export interface RuntimeFacetCompletenessStatusMap {
  runtime_callers_facet_completeness_status: RuntimeFacetCompletenessStatus
  runtime_callees_facet_completeness_status: RuntimeFacetCompletenessStatus
  runtime_structure_access_facet_completeness_status: RuntimeFacetCompletenessStatus
  runtime_logs_facet_completeness_status: RuntimeFacetCompletenessStatus
  runtime_timers_facet_completeness_status: RuntimeFacetCompletenessStatus
}

export interface NormalizedQueryResponse {
  snapshotId: number
  intent: QueryIntent
  status: "hit" | "enriched" | "llm_fallback" | "not_found" | "error"
  data: {
    nodes: Array<Record<string, unknown>>
    edges: Array<Record<string, unknown>>
    observations?: Array<Record<string, unknown>>
    summary?: Record<string, unknown>
  }
  provenance: {
    path: "db_hit" | "db_miss_deterministic" | "db_miss_llm_last_resort"
    deterministicAttempts: string[]
    llmUsed: boolean
  }
  runtime_facet_completeness_status_map?: RuntimeFacetCompletenessStatusMap
  errors?: string[]
}

// ── Intent-specific required-field sets (internal to validation) ─────────────

const INTENTS_REQUIRING_API = new Set<QueryIntent>([
  "who_calls_api",
  "who_calls_api_at_runtime",
  "why_api_invoked",
  "what_api_calls",
  "show_registration_chain",
  "show_dispatch_sites",
  "find_callback_registrars",
  "show_api_runtime_observations",
  "show_hot_call_paths",
  "find_api_timer_triggers",
  "find_api_logs",
  "find_api_logs_by_level",
  "find_api_struct_writes",
  "find_api_struct_reads",
])

const INTENTS_REQUIRING_STRUCT = new Set<QueryIntent>([
  "where_struct_initialized",
  "where_struct_modified",
  "find_struct_owners",
  "find_struct_readers",
  "find_struct_writers",
  "find_field_access_path",
])

// ── Validation functions ─────────────────────────────────────────────────────

export function parseQueryIntent(input: string): QueryIntent | null {
  const normalized = input.trim().toLowerCase().replace(/[\s-]+/g, "_")
  const alias: Record<string, QueryIntent> = {
    who_calls_api: "who_calls_api",
    who_calls: "who_calls_api",
    where_struct_init: "where_struct_initialized",
    where_struct_initialized: "where_struct_initialized",
    where_struct_modified: "where_struct_modified",
  }
  const candidate = (alias[normalized] ?? normalized) as QueryIntent
  return (QUERY_INTENTS as readonly string[]).includes(candidate) ? candidate : null
}

export function validateQueryRequest(input: unknown):
  | { ok: true; value: QueryRequest }
  | { ok: false; errors: string[] } {
  const errors: string[] = []
  if (!input || typeof input !== "object") return { ok: false, errors: ["request must be an object"] }

  const req = input as Partial<QueryRequest>
  if (!req.intent || !(QUERY_INTENTS as readonly string[]).includes(req.intent)) {
    errors.push("intent is required and must be valid")
  }
  if (typeof req.snapshotId !== "number" || !Number.isInteger(req.snapshotId) || req.snapshotId <= 0) {
    errors.push("snapshotId must be a positive integer")
  }

  const intent = req.intent
  if (intent && INTENTS_REQUIRING_API.has(intent) && !req.apiName) {
    errors.push(`apiName is required for intent '${intent}'`)
  }
  if (intent && INTENTS_REQUIRING_STRUCT.has(intent) && !req.structName) {
    errors.push(`structName is required for intent '${intent}'`)
  }
  if (intent === "find_field_access_path" && !req.fieldName) {
    errors.push("fieldName is required for intent 'find_field_access_path'")
  }
  if (intent === "show_runtime_flow_for_trace" && !req.traceId) {
    errors.push("traceId is required for intent 'show_runtime_flow_for_trace'")
  }
  if (intent === "find_api_by_log_pattern" && !req.pattern) {
    errors.push("pattern is required for intent 'find_api_by_log_pattern'")
  }
  if (intent === "find_api_logs_by_level" && !req.logLevel) {
    errors.push("logLevel is required for intent 'find_api_logs_by_level' (one of ERROR, WARN, INFO, DEBUG, VERBOSE, TRACE, UNKNOWN)")
  }
  if (intent === "show_cross_module_path" && (!req.srcApi || !req.dstApi)) {
    errors.push("srcApi and dstApi are required for intent 'show_cross_module_path'")
  }
  if (intent === "find_data_path" && (!req.srcApi || !req.dstApi)) {
    errors.push("srcApi and dstApi are required for intent 'find_data_path'")
  }

  if (req.depth !== undefined && (!Number.isInteger(req.depth) || req.depth <= 0)) {
    errors.push("depth must be a positive integer when provided")
  }
  if (req.limit !== undefined && (!Number.isInteger(req.limit) || req.limit <= 0)) {
    errors.push("limit must be a positive integer when provided")
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value: req as QueryRequest }
}

export function validateResponseShape(input: unknown): string[] {
  const errors: string[] = []
  if (!input || typeof input !== "object") return ["response must be an object"]
  const res = input as Partial<NormalizedQueryResponse>

  if (typeof res.snapshotId !== "number") errors.push("snapshotId must be a number")
  if (!res.intent || !(QUERY_INTENTS as readonly string[]).includes(res.intent)) {
    errors.push("intent must be valid")
  }
  if (!res.status) errors.push("status is required")
  if (!res.data || !Array.isArray(res.data.nodes) || !Array.isArray(res.data.edges)) {
    errors.push("data.nodes and data.edges arrays are required")
  }
  if (!res.provenance) {
    errors.push("provenance is required")
  } else {
    if (!Array.isArray(res.provenance.deterministicAttempts)) {
      errors.push("provenance.deterministicAttempts must be an array")
    }
    if (typeof res.provenance.llmUsed !== "boolean") {
      errors.push("provenance.llmUsed must be boolean")
    }
  }

  return errors
}
