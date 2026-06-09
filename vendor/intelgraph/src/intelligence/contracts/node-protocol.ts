import { z } from "zod"

export const srcLocSchema = z.object({
  file: z.string(),
  line: z.number().int().min(1),
  col: z.number().int().min(1).optional(),
})

export const evidenceSchema = z.object({
  kind: z.enum(["call_expr", "fn_ptr_assign", "dispatch_table_entry", "register_call", "log_site", "field_access", "unknown"]),
  loc: srcLocSchema,
  snippet_hash: z.string().optional(),
})

export const execCtxSchema = z.object({
  thread: z.string().optional(),
  signal_id: z.string().optional(),
  irq_source: z.string().optional(),
  power_state: z.enum(["awake", "sleep", "wow_entered", "wow_exited", "unknown"]).optional(),
  wow_state: z.string().optional(),
})

export const registrationSchema = z.object({
  registration_kind: z.enum(["data", "nondata", "wmi", "htt", "callback", "unknown"]),
  registrar_node_id: z.string().optional(),
  registrar_api: z.string().optional(),
  register_call: z.string().optional(),
  callsite: srcLocSchema.optional(),
  context_owner: z.string().optional(),
})

export const dispatchSchema = z.object({
  dispatch_site: srcLocSchema.optional(),
  chain_node_ids: z.array(z.string()).optional(),
  trigger_event: z.enum(["irq", "timer", "wmi_event", "frame_match", "msg_queue", "unknown"]).optional(),
})

export const edgeRefSchema = z.object({
  edge_id: z.string(),
  src_node_id: z.string(),
  dst_node_id: z.string(),
  edge_kind: z.enum([
    "call_direct",
    "call_runtime",
    "register",
    "dispatch",
    "read",
    "write",
    "init",
    "mutate",
    "owner",
    "use",
    "inherit",
    "implement",
    "emit_log",
    // Language-agnostic structural kinds (introduced to give every
    // common.ts `EdgeKind` value a 1:1 protocol representation —
    // previously unmapped kinds silently fell through to "call_runtime").
    "use_macro",       // ← common.ts EdgeKind "uses_macro"
    "import",          // ← common.ts EdgeKind "imports"
    "contain",         // ← common.ts EdgeKind "contains"
    "reference_type",  // ← common.ts EdgeKind "references_type"
    // Data-structure kinds (Phase 3 of the data-flow story).
    "field_type",      // ← common.ts EdgeKind "field_of_type"
    "aggregate",       // ← common.ts EdgeKind "aggregates"
  ]),
  edge_kind_verbose: z.enum([
    "static_direct_calls",
    "runtime_invokes_api",
    "registers_callback_handler",
    "dispatches_execution_to_api",
    "reads_structure_field",
    "writes_structure_field",
    "initializes_structure_state",
    "mutates_structure_state",
    "owns_structure_entity",
    "uses_dependency_entity",
    "inherits_from_parent_type",
    "implemented_by_concrete_type",
    "emits_runtime_log_event",
    "uses_preprocessor_macro",
    "module_imports_dependency",
    "namespace_contains_symbol",
    "references_type_by_name",
    "field_declares_type",
    "aggregates_type_structurally",
  ]),
  src_name: z.string(),
  dst_name: z.string(),
  confidence: z.number(),
  registration: registrationSchema.optional(),
  dispatch: dispatchSchema.optional(),
  exec_ctx: execCtxSchema.optional(),
  evidence: z.array(evidenceSchema).min(1),
})

export const nodeFacetSchema = z.object({
  api: z.record(z.unknown()).optional(),
  struct: z.record(z.unknown()).optional(),
  union: z.record(z.unknown()).optional(),
  enum: z.record(z.unknown()).optional(),
  typedef: z.record(z.unknown()).optional(),
  class: z.record(z.unknown()).optional(),
  field: z.record(z.unknown()).optional(),
  macro: z.record(z.unknown()).optional(),
  global_var: z.record(z.unknown()).optional(),
  param: z.record(z.unknown()).optional(),
  thread: z.record(z.unknown()).optional(),
  signal: z.record(z.unknown()).optional(),
  interrupt: z.record(z.unknown()).optional(),
  timer: z.record(z.unknown()).optional(),
  ring: z.record(z.unknown()).optional(),
  module: z.record(z.unknown()).optional(),
  hw_block: z.record(z.unknown()).optional(),
  dispatch_table: z.record(z.unknown()).optional(),
  message: z.record(z.unknown()).optional(),
  log_point: z.record(z.unknown()).optional(),
})

export const pageInfoSchema = z.object({
  cursor: z.string().nullable().optional(),
  limit: z.number().int().positive().optional(),
  has_more: z.boolean().optional(),
})

export const nodeSchema = z.object({
  node_id: z.string(),
  kind: z.enum([
    "api",
    "struct",
    "union",
    "enum",
    "typedef",
    "class",
    "field",
    "macro",
    "global_var",
    "param",
    "thread",
    "signal",
    "interrupt",
    "timer",
    "ring",
    "module",
    "hw_block",
    "dispatch_table",
    "message",
    "log_point",
    // Phase 3d: structural data hierarchy
    "enum_variant",
    // Sister kinds the existing schema was missing — these are
    // declared in SymbolRow["kind"] but were silently mapped to
    // "unknown" until phase 3e, breaking the visualization side.
    "interface",
    "method",
    "namespace",
    "unknown",
  ]),
  kind_verbose: z.enum([
    "application_programming_interface",
    "structure_type",
    "union_type",
    "enumeration_type",
    "typedef_alias",
    "class_type",
    "structure_field",
    "preprocessor_macro",
    "global_variable",
    "function_parameter",
    "thread_context",
    "signal_trigger",
    "interrupt_source",
    "timer_trigger",
    "ring_endpoint",
    "module_boundary",
    "hardware_execution_block",
    "dispatch_table",
    "inter_thread_message",
    "log_emission_point",
    // Phase 3d / 3e additions
    "enum_variant_member",
    "interface_type",
    "class_method",
    "namespace_module",
    "unknown_entity",
  ]),
  canonical_name: z.string(),
  aliases: z.array(z.string()),
  display_name: z.string(),
  snapshot_id: z.number().int().positive(),
  workspace_root: z.string(),
  fw_build: z.string().optional(),
  fw_branch: z.string().optional(),
  compile_db_hash: z.string().optional(),
  protocol_version: z.literal("1.1"),
  sources: z.array(z.enum(["db", "clangd", "c_parser", "llm"])),
  loc: srcLocSchema.optional(),
  confidence: z.object({
    static_conf: z.number(),
    runtime_conf: z.number(),
    registration_conf: z.number(),
    overall_conf: z.number(),
  }),
  rel: z.object({
    // canonical short relation buckets
    calls_out: z.array(edgeRefSchema),
    calls_in_direct: z.array(edgeRefSchema),
    calls_in_runtime: z.array(edgeRefSchema),
    registrations_out: z.array(edgeRefSchema),
    registrations_in: z.array(edgeRefSchema),
    structures: z.array(edgeRefSchema),
    logs: z.array(edgeRefSchema),
    owns: z.array(edgeRefSchema),
    uses: z.array(edgeRefSchema),
    inherits_from: z.array(edgeRefSchema),
    implemented_by: z.array(edgeRefSchema),

    // verbose aliases (non-breaking dual-field mode)
    outgoing_call_relationships: z.array(edgeRefSchema),
    incoming_static_call_relationships: z.array(edgeRefSchema),
    incoming_runtime_call_relationships: z.array(edgeRefSchema),
    outgoing_registration_relationships: z.array(edgeRefSchema),
    incoming_registration_relationships: z.array(edgeRefSchema),
    structure_access_relationships: z.array(edgeRefSchema),
    log_emission_relationships: z.array(edgeRefSchema),
    ownership_relationships: z.array(edgeRefSchema),
    usage_relationships: z.array(edgeRefSchema),
    inheritance_parent_relationships: z.array(edgeRefSchema),
    implementation_child_relationships: z.array(edgeRefSchema),
  }),
  facets: nodeFacetSchema,
  rel_page: z.record(pageInfoSchema).optional(),
})

export const observationSchema = z.object({
  id: z.string(),
  node_id: z.string(),
  snapshot_id: z.number().int().positive(),
  kind: z.string(),
  observed_at: z.string(),
  payload: z.record(z.unknown()),
  confidence: z.number(),
  source: z.enum(["runtime", "log", "trace", "manual", "unknown"]),
})

export const protocolErrorSchema = z.object({
  code: z.enum(["VALIDATION_ERROR", "NOT_INITIALIZED", "SNAPSHOT_NOT_READY", "NOT_FOUND", "DB_ERROR", "INTERNAL_ERROR"]),
  message: z.string(),
  field: z.string().optional(),
  retryable: z.boolean().optional(),
})

export const nodeResponseSchema = z.object({
  protocol_version: z.literal("1.1"),
  schema_capabilities: z.array(z.string()),
  trace_id: z.string(),
  intent: z.string(),
  status: z.enum(["hit", "enriched", "llm_fallback", "not_found", "error"]),
  data: z.object({
    items: z.array(nodeSchema),
  }),
  meta: z.object({
    snapshot_id: z.number().int().positive(),
    workspace_root: z.string(),
    total_estimate: z.number().int().nonnegative().optional(),
    cursor: z.string().nullable().optional(),
    limit: z.number().int().positive().optional(),
    sort: z.literal("confidence_desc_name_asc"),
  }),
  errors: z.array(protocolErrorSchema),
})

export type NodeProtocolResponse = z.infer<typeof nodeResponseSchema>
