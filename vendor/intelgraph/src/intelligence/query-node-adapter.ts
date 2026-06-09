import { nodeResponseSchema, type NodeProtocolResponse } from "./contracts/node-protocol.js"
import type { NormalizedQueryResponse, QueryRequest } from "./contracts/orchestrator.js"
import type { IQueryNodeAdapter } from "./contracts/query-node-adapter.js"

type NodeItem = NodeProtocolResponse["data"]["items"][number]
type EdgeRef = NodeItem["rel"]["calls_in_runtime"][number]
type RelBucket = keyof NodeItem["rel"]

function num(v: unknown, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback
}

function nonEmpty(v: unknown): string | undefined {
  const value = str(v).trim()
  return value.length > 0 ? value : undefined
}

function mapStatus(status: NormalizedQueryResponse["status"]): NodeProtocolResponse["status"] {
  if (status === "hit") return "hit"
  if (status === "enriched") return "enriched"
  if (status === "llm_fallback") return "llm_fallback"
  if (status === "not_found") return "not_found"
  return "error"
}

function mapErrors(errors?: string[]): NodeProtocolResponse["errors"] {
  if (!errors || errors.length === 0) return []
  const code = (message: string): NodeProtocolResponse["errors"][number]["code"] => {
    const m = message.toLowerCase()
    if (m.includes("validation_error") || m.includes("validation")) return "VALIDATION_ERROR"
    if (m.includes("not_found") || m.includes("not found")) return "NOT_FOUND"
    if (m.includes("snapshot_not_ready") || m.includes("snapshot not ready")) return "SNAPSHOT_NOT_READY"
    if (m.includes("db_error") || m.includes("database") || m.includes("sql")) return "DB_ERROR"
    if (m.includes("not_initialized") || m.includes("not initialized")) return "NOT_INITIALIZED"
    return "INTERNAL_ERROR"
  }
  return errors.map((message) => ({
    code: code(message),
    message,
    retryable: true,
  }))
}

function mapKind(row: Record<string, unknown>): NodeItem["kind"] {
  const raw = str(row.kind ?? row.node_kind ?? row.nodeKind ?? "unknown")
    .toLowerCase()
    .replace(/[\s-]+/g, "_")

  if (raw === "api" || raw === "function") return "api"
  if (raw === "struct") return "struct"
  if (raw === "union") return "union"
  if (raw === "enum") return "enum"
  if (raw === "typedef") return "typedef"
  if (raw === "class") return "class"
  if (raw === "field") return "field"
  if (raw === "macro") return "macro"
  if (raw === "global_var" || raw === "global" || raw === "globalvar") return "global_var"
  if (raw === "param" || raw === "parameter") return "param"
  if (raw === "thread") return "thread"
  if (raw === "signal") return "signal"
  if (raw === "interrupt" || raw === "irq" || raw === "isr") return "interrupt"
  if (raw === "timer") return "timer"
  if (raw === "ring") return "ring"
  if (raw === "module") return "module"
  if (raw === "hw_block" || raw === "hardware_block" || raw === "hwblock") return "hw_block"
  if (raw === "dispatch_table") return "dispatch_table"
  if (raw === "message" || raw === "message_queue" || raw === "thread_message" || raw === "message_function") return "message"
  if (raw === "log_point" || raw === "log") return "log_point"
  // Phase 3d / 3e: structural data + previously-missing language-agnostic kinds
  if (raw === "enum_variant" || raw === "variant") return "enum_variant"
  if (raw === "interface") return "interface"
  if (raw === "method") return "method"
  if (raw === "namespace") return "namespace"
  return "unknown"
}

function mapKindVerbose(kind: NodeItem["kind"]): NodeItem["kind_verbose"] {
  switch (kind) {
    case "api": return "application_programming_interface"
    case "struct": return "structure_type"
    case "union": return "union_type"
    case "enum": return "enumeration_type"
    case "typedef": return "typedef_alias"
    case "class": return "class_type"
    case "field": return "structure_field"
    case "macro": return "preprocessor_macro"
    case "global_var": return "global_variable"
    case "param": return "function_parameter"
    case "thread": return "thread_context"
    case "signal": return "signal_trigger"
    case "interrupt": return "interrupt_source"
    case "timer": return "timer_trigger"
    case "ring": return "ring_endpoint"
    case "module": return "module_boundary"
    case "hw_block": return "hardware_execution_block"
    case "dispatch_table": return "dispatch_table"
    case "message": return "inter_thread_message"
    case "log_point": return "log_emission_point"
    // Phase 3d / 3e additions
    case "enum_variant": return "enum_variant_member"
    case "interface": return "interface_type"
    case "method": return "class_method"
    case "namespace": return "namespace_module"
    default: return "unknown_entity"
  }
}

export function mapEdgeKindVerbose(edgeKind: EdgeRef["edge_kind"]): EdgeRef["edge_kind_verbose"] {
  switch (edgeKind) {
    case "call_direct": return "static_direct_calls"
    case "call_runtime": return "runtime_invokes_api"
    case "register": return "registers_callback_handler"
    case "dispatch": return "dispatches_execution_to_api"
    case "read": return "reads_structure_field"
    case "write": return "writes_structure_field"
    case "init": return "initializes_structure_state"
    case "mutate": return "mutates_structure_state"
    case "owner": return "owns_structure_entity"
    case "use": return "uses_dependency_entity"
    case "inherit": return "inherits_from_parent_type"
    case "implement": return "implemented_by_concrete_type"
    case "emit_log": return "emits_runtime_log_event"
    case "use_macro": return "uses_preprocessor_macro"
    case "import": return "module_imports_dependency"
    case "contain": return "namespace_contains_symbol"
    case "reference_type": return "references_type_by_name"
    case "field_type": return "field_declares_type"
    case "aggregate": return "aggregates_type_structurally"
  }
}

/**
 * Map the EdgeRow.derivation vocabulary ("clangd" | "llm" | "runtime" | "hybrid")
 * to the narrower node-protocol `sources` vocabulary ("db" | "clangd" | "c_parser" | "llm").
 *
 * Rules:
 *  - "db" is always present (the row was read from the DB).
 *  - "clangd" / "c_parser" / "llm" add themselves when derivation matches.
 *  - "runtime" maps to ["db"] only — runtime extraction writes through to
 *    the DB, there's no distinct "runtime" source kind in the protocol.
 *  - "hybrid" adds "clangd" (hybrid today blends clangd + llm; we surface
 *    the stronger deterministic source).
 */
export function mapRowDerivationToSources(row: Record<string, unknown>): Array<"db" | "clangd" | "c_parser" | "llm"> {
  const sources: Array<"db" | "clangd" | "c_parser" | "llm"> = ["db"]
  const derivation = str(row.derivation).toLowerCase()
  if (derivation === "clangd") sources.push("clangd")
  else if (derivation === "c_parser") sources.push("c_parser")
  else if (derivation === "llm") sources.push("llm")
  else if (derivation === "hybrid") sources.push("clangd")
  return sources
}

export function mapRowEdgeKindToProtocolEdgeKind(row: Record<string, unknown>): EdgeRef["edge_kind"] {
  const raw = str(row.edge_kind).toLowerCase()
  const derivation = str(row.derivation).toLowerCase()

  if (raw === "registers_callback") return "register"
  if (raw === "dispatches_to") return "dispatch"
  if (raw === "reads_field") return "read"
  if (raw === "writes_field") return "write"
  if (raw === "logs_event") return "emit_log"
  if (raw === "operates_on_struct") return "use"

  // Structural (language-agnostic) edge kinds — previously silently
  // fell through to "call_runtime", producing wrong categories in the
  // frontend.
  if (raw === "uses_macro") return "use_macro"
  if (raw === "imports") return "import"
  if (raw === "contains") return "contain"
  if (raw === "extends") return "inherit"
  if (raw === "implements") return "implement"
  if (raw === "references_type") return "reference_type"
  if (raw === "field_of_type") return "field_type"
  if (raw === "aggregates") return "aggregate"

  // Unified runtime relationship kind (direct + indirect)
  if (raw === "runtime_calls" || raw === "indirect_calls") return "call_runtime"

  // "calls" can be static direct or runtime depending on derivation.
  if (raw === "calls" || raw === "api_call" || raw === "direct_call") {
    return derivation === "runtime" ? "call_runtime" : "call_direct"
  }

  // Fallback to runtime call for unknown runtime-like rows.
  return "call_runtime"
}

function rowName(row: Record<string, unknown>): string {
  return str(
    row.canonical_name
      ?? row.runtime_caller_api_name
      ?? row.caller
      ?? row.callee
      ?? row.registrar
      ?? row.callback
      ?? row.src_symbol_name
      ?? row.api_name
      ?? row.name
      ?? row.symbol
      ?? "unknown",
    "unknown",
  )
}

function edgeLoc(row: Record<string, unknown>): EdgeRef["evidence"][number]["loc"] {
  return {
    file: str(row.file_path ?? row.filePath, "unknown"),
    line: Math.max(1, num(row.line_number ?? row.lineNumber, 1)),
    col: 1,
  }
}

function defaultNodeId(snapshotId: number, name: string): string {
  return `${snapshotId}:${name}`
}

function maybeExecCtx(row: Record<string, unknown>): EdgeRef["exec_ctx"] | undefined {
  const thread = nonEmpty(row.thread)
  const signalId = nonEmpty(row.signal_id)
  const irqSource = nonEmpty(row.irq_source)
  const wowState = nonEmpty(row.wow_state)
  if (!thread && !signalId && !irqSource && !wowState) return undefined
  return {
    thread,
    signal_id: signalId,
    irq_source: irqSource,
    power_state: "unknown",
    wow_state: wowState,
  }
}

function maybeRegistration(row: Record<string, unknown>, loc: EdgeRef["evidence"][number]["loc"]): EdgeRef["registration"] | undefined {
  const registrar = nonEmpty(row.registrar)
  const callback = nonEmpty(row.callback)
  const registerCall = nonEmpty(row.registration_api)
  if (!registrar && !callback && !registerCall) return undefined
  return {
    registration_kind: "callback",
    registrar_api: registrar,
    register_call: registerCall,
    context_owner: callback,
    callsite: loc,
  }
}

function maybeDispatch(row: Record<string, unknown>, loc: EdgeRef["evidence"][number]["loc"]): EdgeRef["dispatch"] | undefined {
  if (str(row.edge_kind).toLowerCase() !== "dispatches_to") return undefined
  return {
    dispatch_site: loc,
    trigger_event: "unknown",
  }
}

function relationPlacementForEdgeKind(
  kind: EdgeRef["edge_kind"],
  itemIsSource: boolean,
): { bucket: RelBucket; aliasBucket: RelBucket } {
  switch (kind) {
    case "read":
    case "write":
    case "init":
    case "mutate":
      return {
        bucket: "structures",
        aliasBucket: "structure_access_relationships",
      }
    case "owner":
      return {
        bucket: "owns",
        aliasBucket: "ownership_relationships",
      }
    case "use":
      return {
        bucket: "uses",
        aliasBucket: "usage_relationships",
      }
    case "inherit":
      return {
        bucket: "inherits_from",
        aliasBucket: "inheritance_parent_relationships",
      }
    case "implement":
      return {
        bucket: "implemented_by",
        aliasBucket: "implementation_child_relationships",
      }
    default:
      return {
        bucket: itemIsSource
          ? "calls_out"
          : kind === "call_direct"
            ? "calls_in_direct"
            : "calls_in_runtime",
        aliasBucket: itemIsSource
          ? "outgoing_call_relationships"
          : kind === "call_direct"
            ? "incoming_static_call_relationships"
            : "incoming_runtime_call_relationships",
      }
  }
}

function resolveEdgePlacement(
  req: QueryRequest,
  row: Record<string, unknown>,
  item: { name: string; nodeId: string; snapshotId: number },
): { bucket: RelBucket; aliasBucket: RelBucket; edge: EdgeRef } | null {
  const loc = edgeLoc(row)
  const kind = mapRowEdgeKindToProtocolEdgeKind(row)

  if (req.intent === "find_api_logs" || req.intent === "find_api_logs_by_level" || (mapKind(row) === "log_point" && nonEmpty(row.api_name))) {
    const srcName = nonEmpty(row.api_name) ?? req.apiName
    const dstName = item.name
    if (!srcName || !dstName) return null
    return {
      bucket: "logs",
      aliasBucket: "log_emission_relationships",
      edge: {
        edge_id: str(row.edge_id, `emit_log:${srcName}->${dstName}`),
        src_node_id: str(row.src_node_id, srcName === item.name ? item.nodeId : defaultNodeId(item.snapshotId, srcName)),
        dst_node_id: str(row.dst_node_id, dstName === item.name ? item.nodeId : defaultNodeId(item.snapshotId, dstName)),
        edge_kind: "emit_log",
        edge_kind_verbose: mapEdgeKindVerbose("emit_log"),
        src_name: srcName,
        dst_name: dstName,
        confidence: num(row.confidence, 1),
        evidence: [{ kind: "log_site", loc }],
      },
    }
  }

  const registration = maybeRegistration(row, loc)
  if (req.intent === "show_registration_chain" || req.intent === "find_callback_registrars" || registration) {
    const srcName = nonEmpty(row.registrar) ?? item.name
    const dstName = nonEmpty(row.callback) ?? req.apiName
    if (!srcName || !dstName) return null
    const itemIsSource = item.name === srcName
    return {
      bucket: itemIsSource ? "registrations_out" : "registrations_in",
      aliasBucket: itemIsSource ? "outgoing_registration_relationships" : "incoming_registration_relationships",
      edge: {
        edge_id: str(row.edge_id, `register:${srcName}->${dstName}`),
        src_node_id: str(row.src_node_id, srcName === item.name ? item.nodeId : defaultNodeId(item.snapshotId, srcName)),
        dst_node_id: str(row.dst_node_id, dstName === item.name ? item.nodeId : defaultNodeId(item.snapshotId, dstName)),
        edge_kind: "register",
        edge_kind_verbose: mapEdgeKindVerbose("register"),
        src_name: srcName,
        dst_name: dstName,
        confidence: num(row.confidence, 1),
        registration,
        evidence: [{ kind: "register_call", loc }],
      },
    }
  }

  const srcName =
    nonEmpty(row.runtime_caller_api_name)
    ?? nonEmpty(row.caller)
    ?? (req.intent === "what_api_calls" ? req.apiName : undefined)
  const dstName =
    nonEmpty(row.callee)
    ?? (req.intent === "what_api_calls" ? item.name : req.apiName)
  if (!srcName || !dstName) return null

  const itemIsSource = item.name === srcName
  const { bucket, aliasBucket } = relationPlacementForEdgeKind(kind, itemIsSource)

  const edgeKind = mapRowEdgeKindToProtocolEdgeKind(row)
  return {
    bucket,
    aliasBucket,
    edge: {
      edge_id: str(row.edge_id, `${edgeKind}:${srcName}->${dstName}`),
      src_node_id: str(row.src_node_id, srcName === item.name ? item.nodeId : defaultNodeId(item.snapshotId, srcName)),
      dst_node_id: str(row.dst_node_id, dstName === item.name ? item.nodeId : defaultNodeId(item.snapshotId, dstName)),
      edge_kind: edgeKind,
      edge_kind_verbose: mapEdgeKindVerbose(edgeKind),
      src_name: srcName,
      dst_name: dstName,
      confidence: num(row.confidence, 0.7),
      dispatch: maybeDispatch(row, loc),
      exec_ctx: maybeExecCtx(row),
      evidence: [{ kind: "unknown", loc }],
    },
  }
}

function rowToNode(
  req: QueryRequest,
  row: Record<string, unknown>,
  snapshotId: number,
): NodeItem {
  const name = rowName(row)
  const nodeId = str(row.node_id ?? row.id, `${snapshotId}:${name}`)
  const kind = mapKind(row)
  const rel: NodeItem["rel"] = {
    calls_out: [],
    calls_in_direct: [],
    calls_in_runtime: [],
    registrations_out: [],
    registrations_in: [],
    structures: [],
    logs: [],
    owns: [],
    uses: [],
    inherits_from: [],
    implemented_by: [],
    outgoing_call_relationships: [],
    incoming_static_call_relationships: [],
    incoming_runtime_call_relationships: [],
    outgoing_registration_relationships: [],
    incoming_registration_relationships: [],
    structure_access_relationships: [],
    log_emission_relationships: [],
    ownership_relationships: [],
    usage_relationships: [],
    inheritance_parent_relationships: [],
    implementation_child_relationships: [],
  }
  const placement = resolveEdgePlacement(req, row, { name, nodeId, snapshotId })
  if (placement) {
    (rel[placement.bucket] as EdgeRef[]).push(placement.edge);
    (rel[placement.aliasBucket] as EdgeRef[]).push(placement.edge)
  }

  return {
    node_id: nodeId,
    kind,
    kind_verbose: mapKindVerbose(kind),
    canonical_name: name,
    aliases: [],
    display_name: str(row.display_name, name),
    snapshot_id: snapshotId,
    workspace_root: str(row.workspace_root, "unknown"),
    fw_build: str(row.fw_build) || undefined,
    fw_branch: str(row.fw_branch) || undefined,
    compile_db_hash: str(row.compile_db_hash) || undefined,
    protocol_version: "1.1",
    sources: mapRowDerivationToSources(row),
    loc: {
      file: str(row.file_path ?? row.filePath, "unknown"),
      line: Math.max(1, num(row.line_number ?? row.lineNumber, 1)),
      col: 1,
    },
    confidence: {
      static_conf: num(row.static_conf ?? row.confidence, 0.7),
      runtime_conf: num(row.runtime_conf ?? row.confidence, 0.7),
      registration_conf: num(row.registration_conf ?? row.confidence, 0.7),
      overall_conf: num(row.overall_conf ?? row.confidence, 0.7),
    },
    rel,
    facets: kind === "log_point" && nonEmpty(row.template)
      ? {
          log_point: {
            template: str(row.template),
            api_name: str(row.api_name),
            // Carry actual log level and subsystem so toLegacyFlatResponse can re-emit them
            level: str(row.log_level ?? row.level, "UNKNOWN"),
            subsystem: nonEmpty(row.subsystem) ?? null,
          },
        }
      : {},
  }
}

export function toNodeResponse(req: QueryRequest, res: NormalizedQueryResponse): NodeProtocolResponse {
  const items = res.data.nodes.map((row) => rowToNode(req, row, req.snapshotId))
  const response: NodeProtocolResponse = {
    protocol_version: "1.1",
    schema_capabilities: ["node-centric", "relation-taxonomy-v1"],
    trace_id: `${req.intent}:${req.snapshotId}`,
    intent: req.intent,
    status: mapStatus(res.status),
    data: { items },
    meta: {
      snapshot_id: req.snapshotId,
      workspace_root: str(items[0]?.workspace_root, "unknown"),
      total_estimate: items.length,
      cursor: null,
      limit: req.limit,
      sort: "confidence_desc_name_asc",
    },
    errors: mapErrors(res.errors),
  }
  return nodeResponseSchema.parse(response)
}

export function toNodeErrorResponse(args: {
  intent?: string
  snapshotId?: number
  errors: string[]
}): NodeProtocolResponse {
  const snapshotId = typeof args.snapshotId === "number" && args.snapshotId > 0 ? args.snapshotId : 1
  const intent = args.intent ?? "who_calls_api"
  return nodeResponseSchema.parse({
    protocol_version: "1.1",
    schema_capabilities: ["node-centric", "relation-taxonomy-v1"],
    trace_id: `${intent}:${snapshotId}:error`,
    intent,
    status: "error",
    data: { items: [] },
    meta: {
      snapshot_id: snapshotId,
      workspace_root: "unknown",
      total_estimate: 0,
      cursor: null,
      limit: undefined,
      sort: "confidence_desc_name_asc",
    },
    errors: mapErrors(args.errors),
  })
}

// =============================================================================
// Legacy flat format compatibility wrapper
// =============================================================================
//
// The frontend (`tui-relation-window`) expects intelligence_query to return:
//
//   {
//     status: 'hit' | 'enriched' | 'llm_fallback' | 'not_found' | 'error',
//     data: {
//       nodes: Array<{ id, symbol, filePath, lineNumber, kind, ... }>,
//       edges: Array<{ from, to, kind, viaRegistrationApi?, ... }>,
//     },
//     provenance?: {},
//     // full NodeProtocolResponse is also included for forward compatibility:
//     nodeProtocol: <NodeProtocolResponse>
//   }
//
// `toLegacyFlatResponse` converts a `NodeProtocolResponse` into this format
// so the frontend adapters (queryResultToCallerNodes, queryResultToCalleeNodes,
// queryResultToRuntimeCallerNodes, queryResultToLogRows, etc.) can consume it
// without modification.

export interface LegacyFlatResponse {
  status: NodeProtocolResponse["status"]
  data: {
    nodes: Array<Record<string, unknown>>
    edges: Array<Record<string, unknown>>
  }
  provenance?: Record<string, unknown>
  /** Full NodeProtocolResponse — forward-compat escape hatch for future adapters */
  nodeProtocol: NodeProtocolResponse
}

export function toLegacyFlatResponse(proto: NodeProtocolResponse): LegacyFlatResponse {
  const nodes: Array<Record<string, unknown>> = []
  const edges: Array<Record<string, unknown>> = []

  // Emit a flat edge record from a NodeProtocol EdgeRef.
  // The frontend's `queryResultToCallerNodes` reads:
  //   edge['from'], edge['to'], edge['kind'], edge['viaRegistrationApi']
  const emitEdge = (edge: EdgeRef) => {
    edges.push({
      from: edge.src_node_id,
      to: edge.dst_node_id,
      // Map protocol edge_kind back to legacy EdgeKind string the frontend maps:
      kind: protoEdgeKindToLegacyKind(edge.edge_kind),
      viaRegistrationApi: edge.registration?.register_call ?? edge.registration?.registrar_api ?? undefined,
      edge_kind: edge.edge_kind,
      confidence: edge.confidence,
    })
  }

  for (const item of proto.data.items) {
    const filePath = (item.loc?.file ?? "unknown") !== "unknown" ? (item.loc?.file ?? "") : ""
    const lineNumber = item.loc?.line ?? 1
    const confidence = item.confidence?.overall_conf ?? 0.7

    // Base node — fields shared by all intents
    const node: Record<string, unknown> = {
      // Core identity (used by queryResultToCallerNodes/queryResultToCalleeNodes)
      id: item.node_id,
      symbol: item.canonical_name,
      filePath,
      lineNumber,
      kind: item.kind,
      canonical_name: item.canonical_name,
      file_path: filePath,
      line: lineNumber,
      confidence,
    }

    // ── GAP 4+5: Log point fields (find_api_logs / find_api_logs_by_level) ──
    // Emit level, template, subsystem from facets.log_point (stored by rowToNode).
    if (item.kind === "log_point") {
      const lp = item.facets.log_point as Record<string, unknown> | undefined
      node["template"] = lp?.["template"] ?? item.canonical_name
      node["level"]    = lp?.["level"]    ?? "UNKNOWN"
      node["subsystem"]= lp?.["subsystem"] ?? null
      node["api_name"] = lp?.["api_name"]  ?? null
    }

    // ── GAP 1+2: Runtime caller fields (who_calls_api_at_runtime) ──
    // Only nodes that appear as src in calls_in_runtime edges are actual callers.
    // Set runtime_caller_api_name to their own canonical_name (correct — they are the caller).
    // For nodes that are TARGETS (appear in dst only), do NOT set runtime_caller_api_name
    // so queryResultToRuntimeCallerNodes skips them.
    const isRuntimeCaller = item.rel.calls_in_runtime.some((e) => e.src_node_id === item.node_id)
    if (isRuntimeCaller) {
      node["runtime_caller_api_name"] = item.canonical_name
      // Derive invocation type from the edge kind on this node's runtime incoming edges.
      // Prefer the most specific kind found:
      //   call_runtime from exec_ctx.irq_source → "runtime_direct_call" (interrupt)
      //   call_runtime normal → "runtime_function_pointer_call"
      //   dispatch → "runtime_dispatch_table_call"
      //   register → "runtime_callback_registration_call"
      const edge = item.rel.calls_in_runtime.find((e) => e.src_node_id === item.node_id)
      const invocationType = edge
        ? deriveInvocationType(edge)
        : "runtime_function_pointer_call"
      node["runtime_caller_invocation_type_classification"] = invocationType
    }

    // ── GAP 3: Struct writer/reader fields (find_struct_writers / find_api_struct_writes) ──
    // Emit writer, target, edge_kind, derivation from the structures bucket edges.
    if (item.rel.structures.length > 0) {
      const structEdge = item.rel.structures[0]!
      const edgeKindStr = protoEdgeKindToLegacyKind(structEdge.edge_kind)
      // writer = src_name, target = dst_name
      node["writer"]    = structEdge.src_name
      node["target"]    = structEdge.dst_name
      node["edge_kind"] = edgeKindStr
      // Derivation: infer from edge kind (write/mutate → runtime, read/init → static)
      node["derivation"] = (structEdge.edge_kind === "write" || structEdge.edge_kind === "mutate")
        ? "runtime"
        : "static"
      // Long-form alias names the frontend also checks (legacy SQL row leak)
      node["current_structure_runtime_writer_api_name"]              = structEdge.src_name
      node["current_structure_runtime_target_structure_name"]        = structEdge.dst_name
      node["current_structure_runtime_structure_operation_type_classification"] = edgeKindStr
      node["current_structure_runtime_relation_derivation_source"]   = node["derivation"]
      node["current_api_runtime_structure_access_path_expression"]   =
        (item.facets.struct as Record<string, unknown> | undefined)?.["access_path"] ?? null
    }

    nodes.push(node)

    // Emit edges — only canonical buckets (NOT alias buckets) to avoid double-emit
    // GAP 8: alias buckets (outgoing_call_relationships etc.) hold the SAME EdgeRef
    // objects, so we skip them and only iterate the canonical 7 buckets.
    for (const e of item.rel.calls_in_runtime) emitEdge(e)
    for (const e of item.rel.calls_in_direct)  emitEdge(e)
    for (const e of item.rel.calls_out)         emitEdge(e)
    for (const e of item.rel.registrations_in)  emitEdge(e)
    for (const e of item.rel.registrations_out) emitEdge(e)
    for (const e of item.rel.structures)        emitEdge(e)
    for (const e of item.rel.logs)              emitEdge(e)
  }

  // De-duplicate edges by (from, to, kind)
  const seenEdges = new Set<string>()
  const dedupedEdges = edges.filter((e) => {
    const key = `${String(e.from)}|${String(e.to)}|${String(e.kind)}`
    if (seenEdges.has(key)) return false
    seenEdges.add(key)
    return true
  })

  return {
    status: proto.status,
    data: { nodes, edges: dedupedEdges },
    provenance: { trace_id: proto.trace_id, intent: proto.intent },
    nodeProtocol: proto,
  }
}

/** Map NodeProtocol edge_kind to the legacy EdgeKind strings the frontend's edgeKindToConnectionKind() handles. */
export function protoEdgeKindToLegacyKind(kind: EdgeRef["edge_kind"]): string {
  switch (kind) {
    case "call_direct":     return "calls"
    case "call_runtime":    return "indirect_calls"
    case "register":        return "registers_callback"
    case "dispatch":        return "dispatches_to"
    case "read":            return "reads_field"
    case "write":           return "writes_field"
    case "emit_log":        return "logs_event"
    case "use":             return "operates_on_struct"
    case "owner":           return "operates_on_struct"
    case "init":            return "operates_on_struct"
    case "mutate":          return "operates_on_struct"
    case "inherit":         return "extends"
    case "implement":       return "implements"
    case "use_macro":       return "uses_macro"
    case "import":          return "imports"
    case "contain":         return "contains"
    case "reference_type":  return "references_type"
    case "field_type":      return "field_of_type"
    case "aggregate":       return "aggregates"
    default:                return String(kind)
  }
}

/**
 * Derive the frontend's `runtime_caller_invocation_type_classification` string
 * from a NodeProtocol EdgeRef.
 *
 * Mapping:
 *   dispatch  → runtime_dispatch_table_call
 *   register  → runtime_callback_registration_call
 *   call_runtime with irq_source in exec_ctx → runtime_direct_call (interrupt)
 *   call_runtime (generic) → runtime_function_pointer_call
 *   call_direct → direct_call
 *   anything else → runtime_function_pointer_call
 */
function deriveInvocationType(edge: EdgeRef): string {
  if (edge.edge_kind === "dispatch") return "runtime_dispatch_table_call"
  if (edge.edge_kind === "register") return "runtime_callback_registration_call"
  if (edge.edge_kind === "call_direct") return "direct_call"
  if (edge.edge_kind === "call_runtime") {
    // If the execution context tells us an IRQ fired this call, it's a direct interrupt call
    if (edge.exec_ctx?.irq_source) return "runtime_direct_call"
    // Timer/signal-triggered calls map to callback registration kind
    if (edge.exec_ctx?.signal_id) return "runtime_callback_registration_call"
    return "runtime_function_pointer_call"
  }
  return "runtime_function_pointer_call"
}

// =============================================================================
// Port binding — IQueryNodeAdapter
// =============================================================================

export const queryNodeAdapter: IQueryNodeAdapter = {
  toNodeResponse,
  toNodeErrorResponse,
  toLegacyFlatResponse,
}
