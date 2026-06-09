import type { QueryIntent } from "../intelligence/contracts/orchestrator"

export type RelationArrayName =
  | "calls_in_direct"
  | "calls_in_runtime"
  | "calls_out"
  | "registrations_in"
  | "registrations_out"
  | "structures"
  | "logs"
  | "owns"
  | "uses"

/**
 * Maps each QueryIntent to its corresponding fixture relation array.
 * Based on the intent-to-array mapping from architecture-exhaustive-relation-capture.
 */
export function mapIntentToArray(intent: QueryIntent): RelationArrayName {
  const mapping: Record<QueryIntent, RelationArrayName> = {
    who_calls_api: "calls_in_direct",
    who_calls_api_at_runtime: "calls_in_runtime",
    why_api_invoked: "calls_in_runtime",
    what_api_calls: "calls_out",
    show_registration_chain: "registrations_in",
    find_callback_registrars: "registrations_in",
    show_dispatch_sites: "calls_out",
    find_struct_writers: "structures",
    find_struct_readers: "structures",
    where_struct_initialized: "structures",
    where_struct_modified: "structures",
    find_struct_owners: "owns",
    find_field_access_path: "structures",
    find_api_struct_writes: "structures",
    find_api_struct_reads: "structures",
    find_api_logs: "logs",
    find_api_logs_by_level: "logs",
    find_api_timer_triggers: "owns",
    show_runtime_flow_for_trace: "calls_in_runtime",
    show_api_runtime_observations: "calls_in_runtime",
    show_hot_call_paths: "calls_in_runtime",
    show_cross_module_path: "calls_out",
    find_api_by_log_pattern: "logs",
    // Language-agnostic structural intents (used by ts-core). These
    // don't map to the C-shaped fixture relation arrays — they're
    // mapped to "uses" as a catch-all so the WLAN fixture validator
    // doesn't crash on them.
    find_module_imports: "uses",
    find_module_dependents: "uses",
    find_module_symbols: "uses",
    find_class_inheritance: "uses",
    find_class_subtypes: "uses",
    find_interface_implementors: "uses",
    // ts-core intents added in D28 / D36–D67 (catch-all → "uses")
    find_type_dependencies: "uses",
    find_type_consumers: "uses",
    find_import_cycles: "uses",
    find_top_imported_modules: "uses",
    find_top_called_functions: "uses",
    find_module_entry_points: "uses",
    find_dead_exports: "uses",
    find_call_chain: "uses",
    find_symbols_by_name: "uses",
    find_symbols_by_kind: "uses",
    find_transitive_dependencies: "uses",
    find_symbol_at_location: "uses",
    find_long_functions: "uses",
    find_external_imports: "uses",
    find_module_summary: "uses",
    find_class_summary: "uses",
    find_type_summary: "structures",
    find_api_summary: "uses",
    find_entity_summary: "uses",
    find_module_apis: "uses",
    find_api_type_dependencies: "uses",
    find_type_defining_module: "uses",
    find_workspace_health: "uses",
    analyze_problematic_modules: "uses",
    analyze_god_classes: "uses",
    analyze_type_health: "uses",
    analyze_dead_code: "uses",
    suggest_refactors: "uses",
    generate_health_report: "uses",
    generate_action_plan: "uses",
    compare_snapshots: "uses",
    compare_snapshots_modules: "uses",
    find_symbols_in_file: "uses",
    find_sibling_symbols: "uses",
    find_module_top_exports: "uses",
    find_import_cycles_deep: "uses",
    find_symbol_degree: "uses",
    find_module_interactions: "uses",
    find_modules_overview: "uses",
    find_type_cycles: "uses",
    find_deepest_call_chain: "uses",
    find_symbols_by_doc: "uses",
    find_tightly_coupled_modules: "uses",
    find_classes_by_method_count: "uses",
    find_widely_referenced_types: "uses",
    find_undocumented_exports: "uses",
    find_top_implemented_interfaces: "uses",
    find_orphan_modules: "uses",
    find_largest_modules: "uses",
    find_modules_by_directory: "uses",
    // Phase 3e: data-structure intents — same catch-all
    find_field_type: "structures",
    find_type_fields: "structures",
    find_type_aggregates: "structures",
    find_type_aggregators: "structures",
    // Phase 3g: language-agnostic field-access intents
    find_api_field_writes: "structures",
    find_api_field_reads: "structures",
    find_field_writers: "structures",
    find_field_readers: "structures",
    // Phase 3h: data-side analog of find_call_chain — walks
    // field_of_type/aggregates edges from src type to dst type
    find_data_path: "structures",
    // Phase 3i: structural cycles via field_of_type / aggregates
    find_struct_cycles: "structures",
    // Phase 3l: transitive data footprint via calls + reads/writes BFS
    find_api_data_footprint: "structures",
    // Phase 3m: top-N types ranked by distinct API touchers
    find_top_touched_types: "structures",
    // Phase 3n: direct mutual recursion (A calls B and B calls A)
    find_call_cycles: "uses",
    // Phase 3o: top APIs ranked by distinct field writes / reads
    find_top_field_writers: "structures",
    find_top_field_readers: "structures",
    // Phase 3p: dead-state detector — fields with no readers/writers
    find_unused_fields: "structures",
    // Phase 3t: field-level hot-spot ranking
    find_top_hot_fields: "structures",
    // Phase 3u: god-class detector by state size
    find_classes_by_field_count: "structures",
    // Phase 3v: data-clump detector — fields touched together
    find_field_co_access: "structures",
    // Phase 3w: methods called by exactly one other method
    find_unique_callers: "uses",
    // Phase 3x: direct self-recursion detector
    find_recursive_methods: "uses",
    // Phase 3y: combined-complexity god-method detector
    find_god_methods: "uses",
  }

  return mapping[intent] || "uses"
}

export interface ApiFixture {
  kind: string
  kind_verbose: string
  canonical_name: string
  aliases: string[]
  source: {
    file: string
    line: number
  }
  description: string
  relations: Relations
  contract?: Contract
  enrichment_metadata?: EnrichmentMetadata
}

export interface Relations {
  calls_in_direct: Relation[]
  calls_in_runtime: Relation[]
  calls_out: Relation[]
  registrations_in: Relation[]
  registrations_out: Relation[]
  structures: Relation[]
  logs: Relation[]
  owns: Relation[]
  uses: Relation[]
}

export interface Relation {
  caller?: string
  callee?: string
  api?: string
  struct?: string
  field?: string
  registrar?: string
  callback?: string
  api_name?: string
  level?: string
  template?: string
  subsystem?: string
  edge_kind: string
  edge_kind_verbose: string
  derivation: "clangd" | "c_parser" | "runtime"
  confidence: number
  evidence?: Record<string, unknown>
  dispatch_chain?: string[]
  runtime_trigger?: string
  registration_kind?: string
  source_intent?: QueryIntent
  bucket?: RelationArrayName
  [key: string]: unknown
}

export interface Contract {
  required_relation_kinds: string[]
  required_directions: string[]
  minimum_counts: Record<string, number>
  required_path_patterns: Array<{
    name: string
    nodes: string[]
    description: string
  }>
}

export interface EnrichmentMetadata {
  timestamp: string
  intents_queried: QueryIntent[]
  intents_hit: QueryIntent[]
  total_relations: number
}

/**
 * Select applicable intents for a given API based on its fixture metadata.
 * Default: all Phase 1-3 intents unless role-based filtering suggests otherwise.
 */
export function selectIntentsForApi(
  _apiName: string,
  _fixture: ApiFixture,
): QueryIntent[] {
  // Default: query all core intents
  return [
    "who_calls_api",
    "who_calls_api_at_runtime",
    "what_api_calls",
    "show_registration_chain",
    "find_callback_registrars",
    "find_api_logs",
    "find_api_logs_by_level",
    "find_api_struct_writes",
    "find_api_struct_reads",
    "find_struct_owners",
  ]
}

/**
 * Generate contract from populated relation arrays.
 * Dynamic: only includes kinds that are actually present in the relations.
 */
export function generateContractFromRelations(relations: Relations): Contract {
  const requiredKinds: Set<string> = new Set()
  const requiredDirs: Set<string> = new Set()
  const minimumCounts: Record<string, number> = {}

  if ((relations.calls_in_direct?.length ?? 0) > 0) {
    requiredKinds.add("call_direct")
    requiredDirs.add("incoming")
    minimumCounts.calls_in_direct = 1
  }

  if ((relations.calls_in_runtime?.length ?? 0) > 0) {
    requiredKinds.add("call_runtime")
    requiredDirs.add("incoming")
    minimumCounts.calls_in_runtime = 1
  }

  if ((relations.calls_out?.length ?? 0) > 0) {
    requiredKinds.add("call_direct")
    requiredDirs.add("outgoing")
    minimumCounts.calls_out = 1
  }

  if ((relations.registrations_in?.length ?? 0) > 0) {
    requiredKinds.add("register")
    requiredDirs.add("incoming")
    minimumCounts.registrations_in = 1
  }

  if ((relations.structures?.length ?? 0) > 0) {
    const hasReads = relations.structures.some((r) => r.edge_kind === "read")
    const hasWrites = relations.structures.some((r) => r.edge_kind === "write")
    if (hasReads) requiredKinds.add("read")
    if (hasWrites) requiredKinds.add("write")
    minimumCounts.structures = 1
  }

  if ((relations.logs?.length ?? 0) > 0) {
    requiredKinds.add("emit_log")
    minimumCounts.logs = 1
  }

  if ((relations.owns?.length ?? 0) > 0) {
    minimumCounts.owns = 1
  }

  return {
    required_relation_kinds: Array.from(requiredKinds),
    required_directions: Array.from(requiredDirs),
    minimum_counts: minimumCounts,
    required_path_patterns: [],
  }
}

/**
 * Normalize an edge returned from backend query.
 * Applies source_intent tracking and ensures bucket assignment.
 */
export function normalizeEdge(edge: Record<string, unknown>, bucket: RelationArrayName, intent: QueryIntent): Relation {
  const normalized: Relation = {
    ...edge,
    edge_kind: String(edge.edge_kind || "unknown"),
    edge_kind_verbose: String(edge.edge_kind_verbose || "unknown"),
    derivation: (edge.derivation || "clangd") as "clangd" | "c_parser" | "runtime",
    confidence: Number(edge.confidence || 0.5),
    source_intent: intent,
    bucket,
  }

  return normalized
}

/**
 * Deduplicate relations by (caller||api, callee||struct, edge_kind) tuple.
 * Prefer higher confidence, then clangd over c_parser.
 */
export function deduplicateRelations(relations: Relation[]): Map<string, Relation> {
  const tracker = new Map<string, Relation>()

  for (const relation of relations) {
    const dedupKey = `${relation.caller || relation.api}|${relation.callee || relation.struct}|${relation.edge_kind}`

    if (!tracker.has(dedupKey)) {
      tracker.set(dedupKey, relation)
    } else {
      const existing = tracker.get(dedupKey)!
      // Prefer higher confidence, then clangd over c_parser
      const shouldReplace =
        relation.confidence > existing.confidence ||
        (relation.confidence === existing.confidence && relation.derivation === "clangd")

      if (shouldReplace) {
        tracker.set(dedupKey, relation)
      }
    }
  }

  return tracker
}
