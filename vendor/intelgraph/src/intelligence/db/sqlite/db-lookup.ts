/**
 * db-lookup.ts — SQLite implementation of DbLookupRepository.
 *
 * SQLite implementation of DbLookupRepository.
 * 22 intents, same row shapes, same fallback semantics. The data model:
 * graph_nodes + graph_edges + graph_observations, keyed by (snapshot_id, id).
 *
 * Implementation notes:
 *
 * 1. The queries are three-way joins between GraphNode, GraphEdge, and
 *    GraphNode again. The pattern is:
 *
 *      SELECT ... FROM graph_edges e
 *      INNER JOIN graph_nodes src ON e.src_node_id = src.node_id
 *                                AND src.snapshot_id = e.snapshot_id
 *      INNER JOIN graph_nodes dst ON e.dst_node_id = dst.node_id
 *                                AND dst.snapshot_id = e.snapshot_id
 *      WHERE e.snapshot_id = @snapshotId AND ...
 *
 * 2. IN-list parameters: better-sqlite3 does not support array bindings
 *    directly, so we expand the IN list into repeated ? placeholders and
 *    pass the values as positional params. A tiny helper does this.
 *
 * 3. JSON fields (location, payload, metadata): stored as TEXT, returned
 *    as strings from raw SQL. The extractFilePath/extractLine helpers
 *    parse them on demand. For payload.target_api style nested access
 *    we use SQLite's json_extract() function.
 *
 * 4. Raw better-sqlite3 is used instead of the Drizzle query builder
 *    for these queries because Drizzle's self-join alias machinery
 *    gets verbose fast. Drizzle still owns schema + foundation writes.
 */

import type BetterSqlite3 from "better-sqlite3"
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import type { DbLookupRepository, LookupResult, QueryRequest } from "../../contracts/orchestrator.js"
import { loadGraphJsonFromDb, type GraphJson, type GraphJsonFilters } from "./graph-export.js"
import type * as schema from "./schema.js"

type SqliteDb = BetterSQLite3Database<typeof schema>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildApiNames(request: QueryRequest): string[] {
  const names = [...(request.apiName ? [request.apiName] : []), ...(request.apiNameAliases ?? [])].filter(Boolean)
  return [...new Set(names)]
}

function miss(request: QueryRequest): LookupResult {
  return { hit: false, intent: request.intent, snapshotId: request.snapshotId, rows: [] }
}

function expandIn(values: readonly string[]): string {
  // Returns "?, ?, ?" for N placeholders. Caller passes the values as
  // positional args after any other bound params.
  return values.map(() => "?").join(", ")
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value
  const n = Number(value)
  return isNaN(n) ? 0 : n
}

function toNumberOrNull(value: unknown): number | null {
  if (value == null) return null
  const n = toNumber(value)
  return isNaN(n) ? null : n
}

function parseJson<T = unknown>(value: unknown): T | null {
  if (value == null) return null
  if (typeof value !== "string") return value as T
  try {
    return JSON.parse(value) as T
  } catch {
    return null
  }
}

function extractFilePath(locationJson: unknown): string | null {
  const loc = parseJson<{ filePath?: string }>(locationJson)
  return loc && typeof loc.filePath === "string" ? loc.filePath : null
}

function extractLine(locationJson: unknown): number | null {
  const loc = parseJson<{ line?: unknown }>(locationJson)
  if (!loc || loc.line == null) return null
  return toNumberOrNull(loc.line)
}

// ---------------------------------------------------------------------------
// SqliteDbLookup
// ---------------------------------------------------------------------------

export class SqliteDbLookup implements DbLookupRepository {
  constructor(
    private readonly _db: SqliteDb,
    private readonly raw: BetterSqlite3.Database,
  ) {}

  async lookup(request: QueryRequest): Promise<LookupResult> {
    try {
      const rows = this.dispatch(request)
      return { hit: rows.length > 0, intent: request.intent, snapshotId: request.snapshotId, rows }
    } catch {
      return miss(request)
    }
  }

  /**
   * Read graph_nodes + graph_edges for `snapshotId` and assemble a
   * node-link `GraphJson` document. Used by the `intelligence_graph`
   * transport tool to expose the same data the snapshot-stats CLI's
   * `--graph-json` / `--html` modes render — but against the live
   * persisted snapshot, with no re-extraction. Pure read; no side
   * effects on the db.
   */
  loadGraphJson(snapshotId: number, workspaceRoot: string, filters: GraphJsonFilters = {}): GraphJson {
    return loadGraphJsonFromDb(this.raw, snapshotId, workspaceRoot, filters)
  }

  // -------------------------------------------------------------------------
  // Intent dispatch
  // -------------------------------------------------------------------------

  /**
   * Resolve bare names (e.g. "getLogger") to their canonical forms
   * (e.g. "module:src/logging/logger.ts#getLogger") by looking up
   * graph_nodes. If a name already matches a canonical_name exactly,
   * it is kept. Otherwise, we look for nodes whose canonical_name ends
   * with "#<name>" (module-qualified format from ts-core/rust-core).
   */
  private resolveNames(snapshotId: number, names: string[]): string[] {
    if (names.length === 0) return names
    const resolved = new Set<string>()
    for (const name of names) {
      // Always keep the original name (works for C where canonical == bare name)
      resolved.add(name)
      // Check for module-qualified matches: canonical_name ending with #<name>.
      // Escape LIKE wildcards in name so e.g. "foo_bar" matches literally,
      // not as "fooXbar". The endsWith check below is defense-in-depth.
      const suffix = `#${name}`
      const escapedSuffix = `#${name.replace(/%/g, "\\%").replace(/_/g, "\\_")}`
      const matches = this.raw
        .prepare(
          `SELECT canonical_name FROM graph_nodes
           WHERE snapshot_id = ? AND canonical_name LIKE ? ESCAPE '\\'
           LIMIT 20`,
        )
        .all(snapshotId, `%${escapedSuffix}`) as Array<{ canonical_name: string }>
      for (const m of matches) {
        // Verify exact suffix match (belt-and-suspenders after LIKE escaping)
        if (m.canonical_name.endsWith(suffix)) {
          resolved.add(m.canonical_name)
        }
      }
    }
    return [...resolved]
  }

  /**
   * Resolve a single bare name to its canonical form. Returns the first
   * canonical match, or the original value if no resolution is found.
   */
  private resolveSingle(snapshotId: number, name: string | undefined): string | undefined {
    if (!name) return name
    const resolved = this.resolveNames(snapshotId, [name])
    // Prefer the resolved canonical name over the bare name
    return resolved.find((n) => n !== name) ?? name
  }

  private dispatch(request: QueryRequest): Array<Record<string, unknown>> {
    const { intent, snapshotId } = request
    const limit = request.limit ?? 200
    const apiNames = this.resolveNames(snapshotId, buildApiNames(request))

    switch (intent) {
      case "who_calls_api":
        return this.callers(snapshotId, apiNames, ["calls", "runtime_calls", "registers_callback"], limit)
      case "who_calls_api_at_runtime":
        return this.runtimeCallers(snapshotId, apiNames, limit)
      case "what_api_calls":
        return this.callees(snapshotId, apiNames, limit)
      case "find_api_logs":
        return this.apiLogs(snapshotId, apiNames, undefined, limit)
      case "find_api_logs_by_level":
        return this.apiLogs(snapshotId, apiNames, request.logLevel, limit)
      case "find_api_timer_triggers":
        return this.timerTriggers(snapshotId, apiNames, limit)
      case "show_registration_chain":
      case "find_callback_registrars":
        return this.registrationChain(snapshotId, apiNames, limit)
      case "show_dispatch_sites":
        return this.dispatchSites(snapshotId, apiNames, limit)
      case "find_struct_writers":
      case "where_struct_modified": {
        const structNames = this.resolveNames(snapshotId, request.structName ? [request.structName] : apiNames)
        return this.structAccess(snapshotId, structNames, "writes_field", limit)
      }
      case "find_struct_readers":
      case "where_struct_initialized": {
        const structNames = this.resolveNames(snapshotId, request.structName ? [request.structName] : apiNames)
        return this.structAccess(snapshotId, structNames, "reads_field", limit)
      }
      case "find_struct_owners": {
        const structNames = this.resolveNames(snapshotId, request.structName ? [request.structName] : apiNames)
        return this.structAccess(snapshotId, structNames, "owns", limit)
      }
      case "find_api_struct_writes":
        return this.apiStructAccess(snapshotId, apiNames, "writes_field", limit)
      case "find_api_struct_reads":
        return this.apiStructAccess(snapshotId, apiNames, "reads_field", limit)
      case "find_field_access_path":
        return this.fieldAccessPath(snapshotId, request.structName, request.fieldName, limit)
      case "show_cross_module_path":
        return this.crossModulePath(
          snapshotId,
          this.resolveSingle(snapshotId, request.srcApi),
          this.resolveSingle(snapshotId, request.dstApi),
          limit,
        )
      case "show_hot_call_paths":
        return this.hotCallPaths(snapshotId, apiNames, limit)
      case "why_api_invoked":
      case "show_runtime_flow_for_trace":
      case "show_api_runtime_observations":
        return this.observations(snapshotId, apiNames, limit)
      case "find_api_by_log_pattern":
        return this.logPattern(snapshotId, request.pattern, limit)
      // ── Language-agnostic structural intents (used by ts-core and any
      //    future plugin that emits imports/contains/extends/implements)
      case "find_module_imports":
        return this.outgoingByEdgeKind(snapshotId, apiNames, "imports", limit)
      case "find_module_dependents":
        return this.incomingByEdgeKind(snapshotId, apiNames, "imports", limit)
      case "find_module_symbols":
        return this.outgoingByEdgeKind(snapshotId, apiNames, "contains", limit)
      case "find_class_inheritance":
        return this.outgoingByEdgeKind(snapshotId, apiNames, "extends", limit)
      case "find_class_subtypes":
        return this.incomingByEdgeKind(snapshotId, apiNames, "extends", limit)
      case "find_interface_implementors":
        return this.incomingByEdgeKind(snapshotId, apiNames, "implements", limit)
      case "find_type_dependencies":
        return this.outgoingByEdgeKind(snapshotId, apiNames, "references_type", limit)
      case "find_type_consumers":
        return this.incomingByEdgeKind(snapshotId, apiNames, "references_type", limit)
      // Phase 3e: data-structure intents
      case "find_field_type":
        return this.outgoingByEdgeKind(snapshotId, apiNames, "field_of_type", limit)
      case "find_type_fields":
        return this.containedFields(snapshotId, apiNames, limit)
      case "find_type_aggregates":
        return this.outgoingByEdgeKind(snapshotId, apiNames, "aggregates", limit)
      case "find_type_aggregators":
        return this.incomingByEdgeKind(snapshotId, apiNames, "aggregates", limit)
      // Phase 3g: language-agnostic field-access intents.
      // These delegate to the existing apiStructAccess / structAccess
      // helpers which were already SQL-generic over edge_kind. The
      // older find_api_struct_* / find_struct_* names are kept for
      // C/C++ back-compat but these four are recommended for TS/Rust.
      case "find_api_field_writes":
        return this.apiStructAccess(snapshotId, apiNames, "writes_field", limit)
      case "find_api_field_reads":
        return this.apiStructAccess(snapshotId, apiNames, "reads_field", limit)
      case "find_field_writers":
        return this.structAccess(snapshotId, apiNames, "writes_field", limit)
      case "find_field_readers":
        return this.structAccess(snapshotId, apiNames, "reads_field", limit)
      case "find_data_path":
        return this.dataPath(
          snapshotId,
          this.resolveSingle(snapshotId, request.srcApi) ?? "",
          this.resolveSingle(snapshotId, request.dstApi) ?? "",
          request.depth ?? 6,
          limit,
        )
      case "find_struct_cycles":
        return this.structCycles(snapshotId, limit)
      case "find_api_data_footprint":
        return this.apiDataFootprint(snapshotId, apiNames[0] ?? "", request.depth ?? 6, limit)
      case "find_top_touched_types":
        return this.topTouchedTypes(snapshotId, limit)
      case "find_call_cycles":
        return this.callCycles(snapshotId, limit)
      case "find_top_field_writers":
        return this.topFieldAccessors(snapshotId, "writes_field", limit)
      case "find_top_field_readers":
        return this.topFieldAccessors(snapshotId, "reads_field", limit)
      case "find_unused_fields":
        return this.unusedFields(snapshotId, limit)
      case "find_top_hot_fields":
        return this.topHotFields(snapshotId, limit)
      case "find_classes_by_field_count":
        return this.classesByFieldCount(snapshotId, limit)
      case "find_field_co_access":
        return this.fieldCoAccess(snapshotId, limit)
      case "find_unique_callers":
        return this.uniqueCallers(snapshotId, limit)
      case "find_recursive_methods":
        return this.recursiveMethods(snapshotId, limit)
      case "find_god_methods":
        return this.godMethods(snapshotId, limit)
      case "find_import_cycles":
        return this.importCycles(snapshotId, limit)
      case "find_top_imported_modules":
        return this.topByIncoming(snapshotId, "imports", "module", limit)
      case "find_top_called_functions":
        return this.topByIncoming(snapshotId, "calls", null, limit)
      case "find_module_entry_points":
        return this.moduleEntryPoints(snapshotId, limit)
      case "find_dead_exports":
        return this.deadExports(snapshotId, limit)
      case "find_call_chain":
        return this.callChain(
          snapshotId,
          this.resolveSingle(snapshotId, request.srcApi) ?? "",
          this.resolveSingle(snapshotId, request.dstApi) ?? "",
          request.depth ?? 6,
          limit,
        )
      case "find_symbols_by_name":
        return this.symbolsByName(snapshotId, request.pattern ?? "", limit)
      case "find_symbols_by_kind":
        return this.symbolsByKind(snapshotId, request.pattern ?? "", limit)
      case "find_transitive_dependencies":
        return this.transitiveDependencies(snapshotId, apiNames[0] ?? "", request.depth ?? 10, limit)
      case "find_symbol_at_location":
        return this.symbolAtLocation(snapshotId, request.filePath ?? "", request.lineNumber ?? 0, limit)
      case "find_long_functions":
        return this.longFunctions(snapshotId, request.depth ?? 50, limit)
      case "find_external_imports":
        return this.externalImports(snapshotId, limit)
      case "find_module_summary":
        return this.moduleSummary(snapshotId, apiNames[0] ?? "")
      case "find_class_summary":
        return this.classSummary(snapshotId, apiNames[0] ?? "")
      case "find_type_summary":
        return this.typeSummary(snapshotId, apiNames[0] ?? "")
      case "find_api_summary":
        return this.apiSummary(snapshotId, apiNames[0] ?? "")
      case "find_entity_summary":
        return this.entitySummary(snapshotId, apiNames[0] ?? "")
      case "find_module_apis":
        return this.moduleApis(snapshotId, apiNames[0] ?? "", limit)
      case "find_api_type_dependencies":
        return this.apiTypeDependencies(snapshotId, apiNames[0] ?? "", limit)
      case "find_type_defining_module":
        return this.typeDefiningModule(snapshotId, apiNames[0] ?? "")
      case "find_workspace_health":
        return this.workspaceHealth(snapshotId)
      case "analyze_problematic_modules":
        return this.analyzeProblematicModules(snapshotId, limit)
      case "analyze_god_classes":
        return this.analyzeGodClasses(snapshotId, limit)
      case "analyze_type_health":
        return this.analyzeTypeHealth(snapshotId, limit)
      case "analyze_dead_code":
        return this.analyzeDeadCode(snapshotId, limit)
      case "suggest_refactors":
        return this.suggestRefactors(snapshotId, limit)
      case "generate_health_report":
        return this.generateHealthReport(snapshotId, limit)
      case "generate_action_plan":
        return this.generateActionPlan(snapshotId, limit)
      case "compare_snapshots": {
        const prevId = request.depth ?? snapshotId - 1
        return this.compareSnapshots(snapshotId, prevId)
      }
      case "compare_snapshots_modules": {
        const prevId = request.depth ?? snapshotId - 1
        return this.compareSnapshotsModules(snapshotId, prevId, limit)
      }
      case "find_symbols_in_file":
        return this.symbolsInFile(snapshotId, request.filePath ?? "", limit)
      case "find_sibling_symbols":
        return this.siblingSymbols(snapshotId, apiNames[0] ?? "", limit)
      case "find_module_top_exports":
        return this.moduleTopExports(snapshotId, apiNames[0] ?? "", limit)
      case "find_import_cycles_deep":
        return this.importCyclesDeep(snapshotId, apiNames[0] ?? "", request.depth ?? 5, limit)
      case "find_symbol_degree":
        return this.symbolDegree(snapshotId, apiNames[0] ?? "")
      case "find_module_interactions":
        return this.moduleInteractions(
          snapshotId,
          this.resolveSingle(snapshotId, request.srcApi) ?? "",
          this.resolveSingle(snapshotId, request.dstApi) ?? "",
          limit,
        )
      case "find_modules_overview":
        return this.modulesOverview(snapshotId, limit)
      case "find_type_cycles":
        return this.typeCycles(snapshotId, limit)
      case "find_deepest_call_chain":
        return this.deepestCallChain(snapshotId, apiNames[0] ?? "", request.depth ?? 8)
      case "find_symbols_by_doc":
        return this.symbolsByDoc(snapshotId, request.pattern ?? "", limit)
      case "find_tightly_coupled_modules":
        return this.tightlyCoupledModules(snapshotId, limit)
      case "find_classes_by_method_count":
        return this.classesByMethodCount(snapshotId, limit)
      case "find_widely_referenced_types":
        return this.widelyReferencedTypes(snapshotId, limit)
      case "find_undocumented_exports":
        return this.undocumentedExports(snapshotId, limit)
      case "find_top_implemented_interfaces":
        return this.topByIncoming(snapshotId, "implements", "interface", limit)
      case "find_orphan_modules":
        return this.orphanModules(snapshotId, limit)
      case "find_largest_modules":
        return this.largestModules(snapshotId, limit)
      case "find_modules_by_directory":
        return this.modulesByDirectory(snapshotId, limit)
      default:
        return []
    }
  }

  // -------------------------------------------------------------------------
  // Query methods
  // -------------------------------------------------------------------------

  // ── who_calls_api (callers by edge kind) ────────────────────────────────
  private callers(
    snapshotId: number,
    apiNames: string[],
    edgeKinds: string[],
    limit: number,
  ): Array<Record<string, unknown>> {
    if (apiNames.length === 0) return []
    const sql = `
      SELECT
        src.canonical_name   AS caller,
        dst.canonical_name   AS callee,
        src.kind             AS kind,
        src.canonical_name   AS canonical_name,
        e.edge_kind          AS edge_kind,
        e.confidence         AS confidence,
        e.derivation         AS derivation,
        src.location         AS location
      FROM graph_edges e
      INNER JOIN graph_nodes src
        ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
      INNER JOIN graph_nodes dst
        ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
      WHERE e.snapshot_id = ?
        AND dst.canonical_name IN (${expandIn(apiNames)})
        AND e.edge_kind        IN (${expandIn(edgeKinds)})
      LIMIT ?
    `
    const rows = this.raw.prepare(sql).all(snapshotId, ...apiNames, ...edgeKinds, limit) as Array<
      Record<string, unknown>
    >
    return rows.map((obj) => ({
      kind: obj.kind ?? "function",
      canonical_name: obj.canonical_name ?? obj.caller,
      caller: obj.caller,
      callee: obj.callee,
      edge_kind: obj.edge_kind,
      confidence: toNumber(obj.confidence),
      derivation: obj.derivation,
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
    }))
  }

  // ── who_calls_api_at_runtime ────────────────────────────────────────────
  private runtimeCallers(snapshotId: number, apiNames: string[], limit: number): Array<Record<string, unknown>> {
    if (apiNames.length === 0) return []
    const edgeRows = this.callers(snapshotId, apiNames, ["runtime_calls", "dispatches_to"], limit)

    // GraphObservation rows
    const obsSql = `
      SELECT
        payload,
        confidence
      FROM graph_observations
      WHERE snapshot_id = ?
        AND kind = 'runtime_invocation'
        AND payload IS NOT NULL
        AND json_extract(payload, '$.target_api') IN (${expandIn(apiNames)})
      LIMIT ?
    `
    const obsRaw = this.raw.prepare(obsSql).all(snapshotId, ...apiNames, limit) as Array<{
      payload: string | null
      confidence: number
    }>

    const obsRows: Array<Record<string, unknown>> = obsRaw.map((r) => {
      const payload =
        parseJson<{
          target_api?: string
          immediate_invoker?: string
          runtime_trigger?: string
          dispatch_chain?: string[]
          dispatch_site?: { filePath?: string; line?: number }
        }>(r.payload) ?? {}
      const site = payload.dispatch_site
      return {
        kind: "function",
        canonical_name: payload.immediate_invoker,
        caller: payload.immediate_invoker,
        callee: payload.target_api,
        edge_kind: "runtime_calls",
        confidence: toNumber(r.confidence),
        derivation: "runtime",
        runtime_trigger: payload.runtime_trigger,
        dispatch_chain: payload.dispatch_chain,
        dispatch_site: payload.dispatch_site,
        file_path: site?.filePath ?? null,
        line_number: site?.line != null ? toNumber(site.line) : null,
      }
    })

    // Merge, preferring observation rows when both exist
    const seen = new Set<string>()
    const merged: Array<Record<string, unknown>> = []
    for (const row of [...obsRows, ...edgeRows]) {
      const key = `${String(row.caller)}::${String(row.callee)}`
      if (!seen.has(key)) {
        seen.add(key)
        merged.push(row)
      }
    }
    return merged.slice(0, limit)
  }

  // ── what_api_calls ──────────────────────────────────────────────────────
  private callees(snapshotId: number, apiNames: string[], limit: number): Array<Record<string, unknown>> {
    if (apiNames.length === 0) return []
    const sql = `
      SELECT
        src.canonical_name   AS caller,
        dst.canonical_name   AS callee,
        dst.kind             AS kind,
        dst.canonical_name   AS canonical_name,
        e.edge_kind          AS edge_kind,
        e.confidence         AS confidence,
        e.derivation         AS derivation,
        dst.location         AS location
      FROM graph_edges e
      INNER JOIN graph_nodes src
        ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
      INNER JOIN graph_nodes dst
        ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
      WHERE e.snapshot_id = ?
        AND src.canonical_name IN (${expandIn(apiNames)})
        AND e.edge_kind IN ('calls', 'runtime_calls')
      LIMIT ?
    `
    const rows = this.raw.prepare(sql).all(snapshotId, ...apiNames, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: obj.kind ?? "function",
      canonical_name: obj.canonical_name ?? obj.callee,
      caller: obj.caller,
      callee: obj.callee,
      edge_kind: obj.edge_kind,
      confidence: toNumber(obj.confidence),
      derivation: obj.derivation,
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
    }))
  }

  // ── find_api_logs / find_api_logs_by_level ──────────────────────────────
  private apiLogs(
    snapshotId: number,
    apiNames: string[],
    logLevel: string | undefined,
    limit: number,
  ): Array<Record<string, unknown>> {
    if (apiNames.length === 0) return []
    const levelFilter = logLevel ? `AND json_extract(e.metadata, '$.log_level') = ?` : ""
    const sql = `
      SELECT
        src.canonical_name   AS api_name,
        log.canonical_name   AS canonical_name,
        log.kind             AS kind,
        e.metadata           AS metadata,
        e.confidence         AS confidence,
        e.derivation         AS derivation,
        src.location         AS src_location,
        log.location         AS log_location
      FROM graph_edges e
      INNER JOIN graph_nodes src
        ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
      INNER JOIN graph_nodes log
        ON e.dst_node_id = log.node_id AND e.snapshot_id = log.snapshot_id
      WHERE e.snapshot_id = ?
        AND src.canonical_name IN (${expandIn(apiNames)})
        AND e.edge_kind = 'logs_event'
        AND log.kind = 'log_point'
        ${levelFilter}
      LIMIT ?
    `
    const params: unknown[] = [snapshotId, ...apiNames]
    if (logLevel) params.push(logLevel)
    params.push(limit)
    const rows = this.raw.prepare(sql).all(...params) as Array<Record<string, unknown>>

    return rows.map((obj) => {
      const meta = parseJson<Record<string, unknown>>(obj.metadata) ?? {}
      return {
        kind: "log_point",
        api_name: obj.api_name,
        canonical_name: obj.canonical_name,
        template: meta.template ?? meta.log_template ?? obj.canonical_name,
        log_level: meta.log_level ?? "UNKNOWN",
        subsystem: meta.subsystem ?? null,
        confidence: toNumber(obj.confidence),
        derivation: obj.derivation,
        file_path: extractFilePath(obj.src_location) ?? extractFilePath(obj.log_location),
        line_number: extractLine(obj.src_location) ?? extractLine(obj.log_location),
        edge_kind: "logs_event",
        caller: obj.api_name,
        callee: obj.canonical_name,
      }
    })
  }

  // ── find_api_timer_triggers ─────────────────────────────────────────────
  private timerTriggers(snapshotId: number, apiNames: string[], limit: number): Array<Record<string, unknown>> {
    if (apiNames.length === 0) return []
    const sql = `
      SELECT
        timer.canonical_name AS timer_identifier_name,
        timer.canonical_name AS canonical_name,
        timer.kind           AS kind,
        dst.canonical_name   AS callee,
        e.edge_kind          AS edge_kind,
        e.confidence         AS confidence,
        e.derivation         AS derivation,
        e.metadata           AS metadata,
        timer.location       AS location
      FROM graph_edges e
      INNER JOIN graph_nodes timer
        ON e.src_node_id = timer.node_id AND e.snapshot_id = timer.snapshot_id
      INNER JOIN graph_nodes dst
        ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
      WHERE e.snapshot_id = ?
        AND dst.canonical_name IN (${expandIn(apiNames)})
        AND e.edge_kind IN ('runtime_calls', 'calls')
        AND timer.kind = 'timer'
      LIMIT ?
    `
    const rows = this.raw.prepare(sql).all(snapshotId, ...apiNames, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => {
      const meta = parseJson<Record<string, unknown>>(obj.metadata) ?? {}
      return {
        kind: "timer",
        canonical_name: obj.canonical_name,
        timer_identifier_name: obj.timer_identifier_name,
        timer_trigger_condition_description: meta.timer_trigger_condition_description ?? null,
        timer_trigger_confidence_score: toNumber(obj.confidence),
        caller: obj.timer_identifier_name,
        callee: obj.callee,
        edge_kind: obj.edge_kind,
        confidence: toNumber(obj.confidence),
        derivation: obj.derivation,
        file_path: extractFilePath(obj.location),
        line_number: extractLine(obj.location),
      }
    })
  }

  // ── show_registration_chain / find_callback_registrars ─────────────────
  private registrationChain(snapshotId: number, apiNames: string[], limit: number): Array<Record<string, unknown>> {
    if (apiNames.length === 0) return []
    const sql = `
      SELECT
        registrar.canonical_name AS registrar,
        callback.canonical_name  AS callback,
        registrar.canonical_name AS canonical_name,
        registrar.kind           AS kind,
        e.metadata               AS metadata,
        e.confidence             AS confidence,
        e.derivation             AS derivation,
        registrar.location       AS location
      FROM graph_edges e
      INNER JOIN graph_nodes registrar
        ON e.src_node_id = registrar.node_id AND e.snapshot_id = registrar.snapshot_id
      INNER JOIN graph_nodes callback
        ON e.dst_node_id = callback.node_id AND e.snapshot_id = callback.snapshot_id
      WHERE e.snapshot_id = ?
        AND callback.canonical_name IN (${expandIn(apiNames)})
        AND e.edge_kind = 'registers_callback'
      LIMIT ?
    `
    const rows = this.raw.prepare(sql).all(snapshotId, ...apiNames, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => {
      const meta = parseJson<Record<string, unknown>>(obj.metadata) ?? {}
      return {
        kind: obj.kind ?? "function",
        canonical_name: obj.canonical_name,
        registrar: obj.registrar,
        callback: obj.callback,
        registration_api: meta.registration_api ?? obj.registrar,
        caller: obj.registrar,
        callee: obj.callback,
        edge_kind: "registers_callback",
        confidence: toNumber(obj.confidence),
        derivation: obj.derivation,
        file_path: extractFilePath(obj.location),
        line_number: extractLine(obj.location),
      }
    })
  }

  // ── show_dispatch_sites ─────────────────────────────────────────────────
  private dispatchSites(snapshotId: number, apiNames: string[], limit: number): Array<Record<string, unknown>> {
    if (apiNames.length === 0) return []
    const sql = `
      SELECT
        dispatcher.canonical_name AS caller,
        dst.canonical_name        AS callee,
        dispatcher.canonical_name AS canonical_name,
        dispatcher.kind           AS kind,
        e.metadata                AS metadata,
        e.confidence              AS confidence,
        e.derivation              AS derivation,
        dispatcher.location       AS location
      FROM graph_edges e
      INNER JOIN graph_nodes dispatcher
        ON e.src_node_id = dispatcher.node_id AND e.snapshot_id = dispatcher.snapshot_id
      INNER JOIN graph_nodes dst
        ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
      WHERE e.snapshot_id = ?
        AND dst.canonical_name IN (${expandIn(apiNames)})
        AND e.edge_kind = 'dispatches_to'
      LIMIT ?
    `
    const rows = this.raw.prepare(sql).all(snapshotId, ...apiNames, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => {
      const meta = parseJson<Record<string, unknown>>(obj.metadata) ?? {}
      const site = (meta.dispatch_site as Record<string, unknown> | undefined) ?? {}
      const filePath = extractFilePath(obj.location) ?? (typeof site.filePath === "string" ? site.filePath : "")
      const lineNumber = extractLine(obj.location) ?? toNumberOrNull(site.line)
      return {
        kind: obj.kind ?? "function",
        canonical_name: obj.canonical_name,
        caller: obj.caller,
        callee: obj.callee,
        edge_kind: "dispatches_to",
        dispatch_site: { file: filePath, line: lineNumber },
        confidence: toNumber(obj.confidence),
        derivation: obj.derivation,
        file_path: filePath,
        line_number: lineNumber,
      }
    })
  }

  // ── find_struct_writers / readers / owners ──────────────────────────────
  private structAccess(
    snapshotId: number,
    structNames: string[],
    edgeKind: string,
    limit: number,
  ): Array<Record<string, unknown>> {
    if (structNames.length === 0) return []
    const sql = `
      SELECT
        accessor.canonical_name AS accessor_name,
        target.canonical_name   AS target,
        target.canonical_name   AS struct_name,
        accessor.kind           AS kind,
        accessor.canonical_name AS canonical_name,
        e.edge_kind             AS edge_kind,
        e.metadata              AS metadata,
        e.confidence            AS confidence,
        e.derivation            AS derivation,
        accessor.location       AS location
      FROM graph_edges e
      INNER JOIN graph_nodes accessor
        ON e.src_node_id = accessor.node_id AND e.snapshot_id = accessor.snapshot_id
      INNER JOIN graph_nodes target
        ON e.dst_node_id = target.node_id AND e.snapshot_id = target.snapshot_id
      WHERE e.snapshot_id = ?
        AND target.canonical_name IN (${expandIn(structNames)})
        AND e.edge_kind = ?
      LIMIT ?
    `
    const rows = this.raw.prepare(sql).all(snapshotId, ...structNames, edgeKind, limit) as Array<
      Record<string, unknown>
    >

    const roleByEdgeKind: Record<string, string> = {
      writes_field: "writer",
      reads_field: "reader",
      owns: "owner",
      operates_on_struct: "reader",
    }
    const role = roleByEdgeKind[edgeKind] ?? "accessor"

    return rows.map((obj) => {
      const meta = parseJson<Record<string, unknown>>(obj.metadata) ?? {}
      return {
        kind: obj.kind ?? "function",
        canonical_name: obj.canonical_name,
        [role]: obj.accessor_name,
        target: obj.target,
        struct_name: obj.struct_name,
        edge_kind: obj.edge_kind,
        confidence: toNumber(obj.confidence),
        derivation: obj.derivation,
        caller: obj.accessor_name,
        callee: obj.target,
        runtime_structure_evidence: meta,
        file_path: extractFilePath(obj.location),
        line_number: extractLine(obj.location),
      }
    })
  }

  // ── find_api_struct_writes / reads ──────────────────────────────────────
  private apiStructAccess(
    snapshotId: number,
    apiNames: string[],
    edgeKind: string,
    limit: number,
  ): Array<Record<string, unknown>> {
    if (apiNames.length === 0) return []
    const sql = `
      SELECT
        src.canonical_name AS caller,
        dst.canonical_name AS callee,
        dst.canonical_name AS canonical_name,
        dst.kind           AS kind,
        e.edge_kind        AS edge_kind,
        e.metadata         AS metadata,
        e.confidence       AS confidence,
        e.derivation       AS derivation,
        src.location       AS location
      FROM graph_edges e
      INNER JOIN graph_nodes src
        ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
      INNER JOIN graph_nodes dst
        ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
      WHERE e.snapshot_id = ?
        AND src.canonical_name IN (${expandIn(apiNames)})
        AND e.edge_kind = ?
      LIMIT ?
    `
    const rows = this.raw.prepare(sql).all(snapshotId, ...apiNames, edgeKind, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: obj.kind ?? "struct",
      canonical_name: obj.canonical_name ?? obj.callee,
      caller: obj.caller,
      callee: obj.callee,
      edge_kind: obj.edge_kind,
      confidence: toNumber(obj.confidence),
      derivation: obj.derivation,
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
    }))
  }

  // ── find_field_access_path ──────────────────────────────────────────────
  private fieldAccessPath(
    snapshotId: number,
    structName: string | undefined,
    fieldName: string | undefined,
    limit: number,
  ): Array<Record<string, unknown>> {
    if (!structName && !fieldName) return []
    // SQLite LIKE is case-sensitive by default; the Cypher version used
    // exact prefix/suffix via STARTS WITH / ENDS WITH.
    const conditions: string[] = []
    const params: unknown[] = [snapshotId]
    if (structName) {
      const esc = structName.replace(/%/g, "\\%").replace(/_/g, "\\_")
      conditions.push("field.canonical_name LIKE ? ESCAPE '\\'")
      params.push(`${esc}%`)
    }
    if (fieldName) {
      const esc = fieldName.replace(/%/g, "\\%").replace(/_/g, "\\_")
      conditions.push("field.canonical_name LIKE ? ESCAPE '\\'")
      params.push(`%${esc}`)
    }
    params.push(limit)
    const sql = `
      SELECT
        accessor.canonical_name AS caller,
        field.canonical_name    AS callee,
        field.canonical_name    AS canonical_name,
        accessor.kind           AS kind,
        e.edge_kind             AS edge_kind,
        e.metadata              AS metadata,
        e.confidence            AS confidence,
        e.derivation            AS derivation,
        accessor.location       AS location
      FROM graph_edges e
      INNER JOIN graph_nodes accessor
        ON e.src_node_id = accessor.node_id AND e.snapshot_id = accessor.snapshot_id
      INNER JOIN graph_nodes field
        ON e.dst_node_id = field.node_id AND e.snapshot_id = field.snapshot_id
      WHERE e.snapshot_id = ?
        AND e.edge_kind IN ('reads_field', 'writes_field')
        ${conditions.length > 0 ? "AND " + conditions.join(" AND ") : ""}
      LIMIT ?
    `
    const rows = this.raw.prepare(sql).all(...params) as Array<Record<string, unknown>>
    return rows.map((obj) => {
      const meta = parseJson<Record<string, unknown>>(obj.metadata) ?? {}
      return {
        kind: obj.kind ?? "function",
        canonical_name: obj.canonical_name,
        caller: obj.caller,
        callee: obj.callee,
        edge_kind: obj.edge_kind,
        access_path: meta.access_path ?? obj.callee,
        confidence: toNumber(obj.confidence),
        derivation: obj.derivation,
        file_path: extractFilePath(obj.location),
        line_number: extractLine(obj.location),
      }
    })
  }

  // ── show_cross_module_path ──────────────────────────────────────────────
  private crossModulePath(
    snapshotId: number,
    srcApi: string | undefined,
    dstApi: string | undefined,
    limit: number,
  ): Array<Record<string, unknown>> {
    if (!srcApi || !dstApi) return []
    const sql = `
      SELECT
        src.canonical_name AS caller,
        dst.canonical_name AS callee,
        src.canonical_name AS canonical_name,
        src.kind           AS kind,
        e.edge_kind        AS edge_kind,
        e.confidence       AS confidence,
        e.derivation       AS derivation,
        src.location       AS location
      FROM graph_edges e
      INNER JOIN graph_nodes src
        ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
      INNER JOIN graph_nodes dst
        ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
      WHERE e.snapshot_id = ?
        AND src.canonical_name = ?
        AND dst.canonical_name = ?
      LIMIT ?
    `
    const rows = this.raw.prepare(sql).all(snapshotId, srcApi, dstApi, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: obj.kind ?? "function",
      canonical_name: obj.canonical_name,
      caller: obj.caller,
      callee: obj.callee,
      edge_kind: obj.edge_kind,
      confidence: toNumber(obj.confidence),
      derivation: obj.derivation,
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
    }))
  }

  // ── show_hot_call_paths (diagnostic probe) ──────────────────────────────
  private hotCallPaths(snapshotId: number, apiNames: string[], limit: number): Array<Record<string, unknown>> {
    // Any edges in the snapshot; used to detect empty snapshots. When
    // apiNames is empty, return everything; otherwise filter to edges
    // whose src or dst match.
    let sql: string
    let params: unknown[]
    if (apiNames.length === 0) {
      sql = `
        SELECT
          src.canonical_name AS caller,
          dst.canonical_name AS callee,
          src.canonical_name AS canonical_name,
          src.kind           AS kind,
          e.edge_kind        AS edge_kind,
          e.confidence       AS confidence,
          e.derivation       AS derivation,
          src.location       AS location
        FROM graph_edges e
        INNER JOIN graph_nodes src
          ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
        INNER JOIN graph_nodes dst
          ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
        WHERE e.snapshot_id = ?
        LIMIT ?
      `
      params = [snapshotId, limit]
    } else {
      const apiIn = expandIn(apiNames)
      sql = `
        SELECT
          src.canonical_name AS caller,
          dst.canonical_name AS callee,
          src.canonical_name AS canonical_name,
          src.kind           AS kind,
          e.edge_kind        AS edge_kind,
          e.confidence       AS confidence,
          e.derivation       AS derivation,
          src.location       AS location
        FROM graph_edges e
        INNER JOIN graph_nodes src
          ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
        INNER JOIN graph_nodes dst
          ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
        WHERE e.snapshot_id = ?
          AND (src.canonical_name IN (${apiIn}) OR dst.canonical_name IN (${apiIn}))
        LIMIT ?
      `
      params = [snapshotId, ...apiNames, ...apiNames, limit]
    }
    const rows = this.raw.prepare(sql).all(...params) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: obj.kind ?? "function",
      canonical_name: obj.canonical_name,
      caller: obj.caller,
      callee: obj.callee,
      edge_kind: obj.edge_kind,
      confidence: toNumber(obj.confidence),
      derivation: obj.derivation,
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
    }))
  }

  // ── runtime observations ────────────────────────────────────────────────
  private observations(snapshotId: number, apiNames: string[], limit: number): Array<Record<string, unknown>> {
    if (apiNames.length === 0) return []
    const sql = `
      SELECT payload, confidence
      FROM graph_observations
      WHERE snapshot_id = ?
        AND kind = 'runtime_invocation'
        AND payload IS NOT NULL
        AND json_extract(payload, '$.target_api') IN (${expandIn(apiNames)})
      LIMIT ?
    `
    const rows = this.raw.prepare(sql).all(snapshotId, ...apiNames, limit) as Array<{
      payload: string | null
      confidence: number
    }>
    return rows.map((r) => {
      const payload =
        parseJson<{
          target_api?: string
          immediate_invoker?: string
          runtime_trigger?: string
          dispatch_chain?: string[]
          dispatch_site?: { filePath?: string; line?: number }
        }>(r.payload) ?? {}
      const site = payload.dispatch_site
      return {
        kind: "function",
        canonical_name: payload.immediate_invoker ?? payload.target_api,
        target_api: payload.target_api,
        immediate_invoker: payload.immediate_invoker,
        runtime_trigger: payload.runtime_trigger,
        dispatch_chain: payload.dispatch_chain,
        dispatch_site: payload.dispatch_site,
        edge_kind: "runtime_calls",
        derivation: "runtime",
        confidence: toNumber(r.confidence),
        file_path: site?.filePath ?? null,
        line_number: site?.line != null ? toNumber(site.line) : null,
      }
    })
  }

  // ── find_api_by_log_pattern ─────────────────────────────────────────────
  private logPattern(snapshotId: number, pattern: string | undefined, limit: number): Array<Record<string, unknown>> {
    if (!pattern) return []
    const sql = `
      SELECT
        src.canonical_name AS canonical_name,
        src.kind           AS kind,
        log.canonical_name AS log_name,
        e.metadata         AS metadata,
        e.confidence       AS confidence,
        e.derivation       AS derivation,
        src.location       AS location
      FROM graph_edges e
      INNER JOIN graph_nodes src
        ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
      INNER JOIN graph_nodes log
        ON e.dst_node_id = log.node_id AND e.snapshot_id = log.snapshot_id
      WHERE e.snapshot_id = ?
        AND e.edge_kind = 'logs_event'
        AND log.kind = 'log_point'
        AND (
          log.canonical_name LIKE ? ESCAPE '\\'
          OR (e.metadata IS NOT NULL AND json_extract(e.metadata, '$.template') LIKE ? ESCAPE '\\')
        )
      LIMIT ?
    `
    const escapedPattern = pattern.replace(/%/g, "\\%").replace(/_/g, "\\_")
    const likePattern = `%${escapedPattern}%`
    const rows = this.raw.prepare(sql).all(snapshotId, likePattern, likePattern, limit) as Array<
      Record<string, unknown>
    >
    return rows.map((obj) => {
      const meta = parseJson<Record<string, unknown>>(obj.metadata) ?? {}
      return {
        kind: obj.kind ?? "function",
        canonical_name: obj.canonical_name,
        log_name: obj.log_name,
        template: meta.template ?? obj.log_name,
        confidence: toNumber(obj.confidence),
        derivation: obj.derivation,
        edge_kind: "logs_event",
        caller: obj.canonical_name,
        callee: obj.log_name,
        file_path: extractFilePath(obj.location),
        line_number: extractLine(obj.location),
      }
    })
  }

  // ── language-agnostic structural intent helpers ─────────────────────────
  //
  // outgoingByEdgeKind / incomingByEdgeKind back the new ts-core intents
  // (find_module_imports, find_class_inheritance, etc.) but are kind-
  // parameterized so they work for any future structural edge_kind
  // without per-intent code duplication.

  /**
   * Group modules by their parent directory and return per-directory
   * aggregate stats. Useful for visualizers showing "what's in
   * src/auth/" package overview views.
   *
   * The directory is everything before the last '/' in the
   * canonical_name (after stripping the 'module:' prefix). e.g.
   * `module:src/auth/repo.ts` → directory `module:src/auth`.
   *
   * SQLite doesn't have a clean LAST_INDEX_OF function, so we pull
   * all module rows and aggregate in JS. The volume is small —
   * one row per module — so the cost is negligible.
   *
   * Each row carries:
   *   - canonical_name: the directory key
   *   - module_count: number of modules in this directory
   *   - total_lines: sum of metadata.lineCount across all modules
   *
   * Result is ordered DESC by module_count, alphabetical tie-break.
   */
  private modulesByDirectory(snapshotId: number, limit: number): Array<Record<string, unknown>> {
    const allModules = this.raw
      .prepare(
        `SELECT canonical_name, json_extract(payload, '$.metadata.lineCount') AS line_count
         FROM graph_nodes
         WHERE snapshot_id = ?
           AND kind = 'module'
           AND canonical_name LIKE 'module:%/%'`,
      )
      .all(snapshotId) as Array<{ canonical_name: string; line_count: unknown }>

    const dirs = new Map<string, { count: number; lines: number }>()
    for (const m of allModules) {
      // Strip the trailing /filename to get the directory
      const lastSlash = m.canonical_name.lastIndexOf("/")
      if (lastSlash <= 7) continue // 'module:' = 7 chars, no actual directory
      const dir = m.canonical_name.substring(0, lastSlash)
      const lines = toNumber(m.line_count)
      const existing = dirs.get(dir) ?? { count: 0, lines: 0 }
      existing.count++
      existing.lines += lines
      dirs.set(dir, existing)
    }

    const sorted = [...dirs.entries()]
      .map(([dir, stats]) => ({ dir, ...stats }))
      .sort((a, b) => b.count - a.count || a.dir.localeCompare(b.dir))
      .slice(0, limit)

    return sorted.map((entry) => ({
      kind: "directory",
      canonical_name: entry.dir,
      caller: null,
      callee: entry.dir,
      edge_kind: "contains",
      confidence: 1,
      derivation: "clangd",
      file_path: null,
      line_number: null,
      module_count: entry.count,
      total_lines: entry.lines,
    }))
  }

  /**
   * Rank modules by line count (from metadata.lineCount set by D25).
   * Surfaces the biggest files in the workspace — useful for refactor
   * planning and finding files that are too large to maintain.
   *
   * Each row carries a line_count field. Modules without lineCount
   * (rare — should always be set after D25) are excluded.
   */
  private largestModules(snapshotId: number, limit: number): Array<Record<string, unknown>> {
    const sql = `
      SELECT
        canonical_name,
        kind,
        location,
        json_extract(payload, '$.metadata.lineCount') AS line_count
      FROM graph_nodes
      WHERE snapshot_id = ?
        AND kind = 'module'
        AND json_extract(payload, '$.metadata.lineCount') IS NOT NULL
      ORDER BY CAST(json_extract(payload, '$.metadata.lineCount') AS INTEGER) DESC
      LIMIT ?
    `
    const rows = this.raw.prepare(sql).all(snapshotId, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: "module",
      canonical_name: obj.canonical_name,
      caller: null,
      callee: obj.canonical_name,
      edge_kind: "contains",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
      line_count: toNumberOrNull(obj.line_count),
    }))
  }

  /**
   * Find modules with NO incoming AND NO outgoing imports. Stricter
   * than find_module_entry_points which only checks incoming. These
   * modules are completely isolated — usually dead code, build
   * artifacts, or accidental files.
   *
   * Two NOT EXISTS subqueries: one for incoming imports, one for
   * outgoing imports. The result is the set difference between all
   * modules and any module touched by an imports edge in either
   * direction.
   */
  private orphanModules(snapshotId: number, limit: number): Array<Record<string, unknown>> {
    const sql = `
      SELECT
        m.canonical_name AS canonical_name,
        m.kind AS kind,
        m.location AS location
      FROM graph_nodes m
      WHERE m.snapshot_id = ?
        AND m.kind = 'module'
        AND NOT EXISTS (
          SELECT 1 FROM graph_edges e
          INNER JOIN graph_nodes dst
            ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
          WHERE e.snapshot_id = m.snapshot_id
            AND e.edge_kind = 'imports'
            AND dst.canonical_name = m.canonical_name
        )
        AND NOT EXISTS (
          SELECT 1 FROM graph_edges e
          INNER JOIN graph_nodes src
            ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
          WHERE e.snapshot_id = m.snapshot_id
            AND e.edge_kind = 'imports'
            AND src.canonical_name = m.canonical_name
        )
      ORDER BY m.canonical_name
      LIMIT ?
    `
    const rows = this.raw.prepare(sql).all(snapshotId, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: "module",
      canonical_name: obj.canonical_name,
      caller: null,
      callee: obj.canonical_name,
      edge_kind: "imports",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
    }))
  }

  /**
   * Find exported symbols that lack a JSDoc comment. Builds on D26
   * (exported flag) and D59 (JSDoc extraction). Visualizers can use
   * this for "what's missing documentation" workflows on public APIs.
   *
   * Filters:
   *   - kind IN (function, class, interface)
   *   - payload.metadata.exported = true
   *   - payload.metadata.doc IS NULL
   *
   * Methods inside classes are excluded — they don't carry exported=true
   * (their class does), and method-level docs are a separate concern.
   */
  private undocumentedExports(snapshotId: number, limit: number): Array<Record<string, unknown>> {
    const sql = `
      SELECT
        canonical_name,
        kind,
        location
      FROM graph_nodes
      WHERE snapshot_id = ?
        AND kind IN ('function', 'class', 'interface')
        AND json_extract(payload, '$.metadata.exported') = 1
        AND json_extract(payload, '$.metadata.doc') IS NULL
      ORDER BY canonical_name
      LIMIT ?
    `
    const rows = this.raw.prepare(sql).all(snapshotId, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: obj.kind ?? "function",
      canonical_name: obj.canonical_name,
      caller: null,
      callee: obj.canonical_name,
      edge_kind: "contains",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
    }))
  }

  /**
   * Rank types by the number of DISTINCT modules that reference them.
   * Surfaces "core types" — types that touch many parts of the
   * codebase and are likely candidates for stability guarantees,
   * docs, or careful refactoring.
   *
   * Different from find_top_imported_modules: that counts module
   * imports, this counts type references across module boundaries.
   * A type used by 50 different modules is more central than a type
   * used 50 times in one module.
   *
   * Each row carries module_count = number of distinct source modules.
   */
  private widelyReferencedTypes(snapshotId: number, limit: number): Array<Record<string, unknown>> {
    const sql = `
      SELECT
        dst.canonical_name AS canonical_name,
        dst.kind AS kind,
        dst.location AS location,
        COUNT(DISTINCT
          SUBSTR(src.canonical_name, 1, INSTR(src.canonical_name, '#') - 1)
        ) AS module_count
      FROM graph_edges e
      INNER JOIN graph_nodes src
        ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
      INNER JOIN graph_nodes dst
        ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
      WHERE e.snapshot_id = ?
        AND e.edge_kind = 'references_type'
        AND INSTR(src.canonical_name, '#') > 0
        AND dst.kind IN ('class', 'interface', 'typedef')
      GROUP BY dst.canonical_name, dst.kind, dst.location
      ORDER BY module_count DESC, dst.canonical_name ASC
      LIMIT ?
    `
    const rows = this.raw.prepare(sql).all(snapshotId, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: obj.kind ?? "class",
      canonical_name: obj.canonical_name,
      caller: null,
      callee: obj.canonical_name,
      edge_kind: "references_type",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
      module_count: toNumber(obj.module_count),
    }))
  }

  /**
   * Rank classes by their method count. After D4 methods are anchored
   * at the class via contains edges, so this is just a GROUP BY on
   * the contains edges where src is a class and dst is a method.
   *
   * Surfaces god objects — classes with disproportionately many
   * methods that are often refactor candidates. Visualizers can
   * highlight these for "split this class" suggestions.
   *
   * Each row carries a method_count field.
   */
  private classesByMethodCount(snapshotId: number, limit: number): Array<Record<string, unknown>> {
    const sql = `
      SELECT
        src.canonical_name AS canonical_name,
        src.location AS location,
        COUNT(*) AS method_count
      FROM graph_edges e
      INNER JOIN graph_nodes src
        ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
      INNER JOIN graph_nodes dst
        ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
      WHERE e.snapshot_id = ?
        AND e.edge_kind = 'contains'
        AND src.kind = 'class'
        AND dst.kind = 'method'
      GROUP BY src.canonical_name, src.location
      ORDER BY method_count DESC, src.canonical_name ASC
      LIMIT ?
    `
    const rows = this.raw.prepare(sql).all(snapshotId, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: "class",
      canonical_name: obj.canonical_name,
      caller: null,
      callee: obj.canonical_name,
      edge_kind: "contains",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
      method_count: toNumber(obj.method_count),
    }))
  }

  /**
   * Phase 3u: god-class detector by state size. Sister of
   * find_classes_by_method_count which ranks by behavior. Ranks
   * classes (and structs/interfaces) by the number of contained
   * field nodes — surfaces types with too much state.
   *
   * State-size ranking complements method-count ranking because
   * the two anti-patterns can show up independently:
   *   - High method count, low field count: behavior god class
   *     (Service, Manager, Controller types)
   *   - High field count, low method count: data god class
   *     (large config bags, DTOs, denormalized records)
   *   - Both high: classic god class (refactor target #1)
   *
   * Includes struct + interface in addition to class so the
   * Rust + TS interface variants get caught too.
   */
  private classesByFieldCount(snapshotId: number, limit: number): Array<Record<string, unknown>> {
    const sql = `
      SELECT
        src.canonical_name AS canonical_name,
        src.kind AS kind,
        src.location AS location,
        COUNT(*) AS field_count
      FROM graph_edges e
      INNER JOIN graph_nodes src
        ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
      INNER JOIN graph_nodes dst
        ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
      WHERE e.snapshot_id = ?
        AND e.edge_kind = 'contains'
        AND src.kind IN ('class', 'struct', 'interface')
        AND dst.kind = 'field'
      GROUP BY src.canonical_name, src.kind, src.location
      ORDER BY field_count DESC, src.canonical_name ASC
      LIMIT ?
    `
    const rows = this.raw.prepare(sql).all(snapshotId, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: obj.kind ?? "class",
      canonical_name: obj.canonical_name,
      field_count: toNumber(obj.field_count),
      // Alias for the viewer's hub-panel renderer
      incoming_count: toNumber(obj.field_count),
      edge_kind: "contains_field",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
    }))
  }

  /**
   * Find module pairs ranked by total inter-module edges (calls +
   * references_type). Surfaces refactor candidates: pairs of modules
   * with high mutual coupling are often signs that code wants to be
   * combined or that an abstraction is leaking.
   *
   * Module membership is derived from canonical_name prefix: a symbol
   * `module:src/foo.ts#bar` belongs to module `module:src/foo.ts`.
   * The query aggregates by (src_module, dst_module) excluding pairs
   * where src == dst (those are intra-module noise).
   *
   * Result rows have caller=src_module, callee=dst_module, and
   * coupling_count = total edges between them. Ordered DESC.
   */
  private tightlyCoupledModules(snapshotId: number, limit: number): Array<Record<string, unknown>> {
    const sql = `
      SELECT
        SUBSTR(src.canonical_name, 1, INSTR(src.canonical_name, '#') - 1) AS src_module,
        SUBSTR(dst.canonical_name, 1, INSTR(dst.canonical_name, '#') - 1) AS dst_module,
        COUNT(*) AS coupling_count
      FROM graph_edges e
      INNER JOIN graph_nodes src
        ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
      INNER JOIN graph_nodes dst
        ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
      WHERE e.snapshot_id = ?
        AND e.edge_kind IN ('calls', 'references_type')
        AND INSTR(src.canonical_name, '#') > 0
        AND INSTR(dst.canonical_name, '#') > 0
        AND SUBSTR(src.canonical_name, 1, INSTR(src.canonical_name, '#') - 1)
            != SUBSTR(dst.canonical_name, 1, INSTR(dst.canonical_name, '#') - 1)
      GROUP BY src_module, dst_module
      ORDER BY coupling_count DESC
      LIMIT ?
    `
    const rows = this.raw.prepare(sql).all(snapshotId, limit) as Array<{
      src_module: string
      dst_module: string
      coupling_count: number
    }>
    return rows.map((row) => ({
      kind: "module",
      canonical_name: row.src_module,
      caller: row.src_module,
      callee: row.dst_module,
      edge_kind: "calls",
      confidence: 1,
      derivation: "clangd",
      file_path: null,
      line_number: null,
      coupling_count: toNumber(row.coupling_count),
    }))
  }

  /**
   * Search symbols by their JSDoc text. Builds on D59 which stores
   * the doc string at payload.metadata.doc. Useful for finding
   * deprecated APIs (search for "@deprecated"), TODO/FIXME comments,
   * or any documentation pattern across the codebase.
   *
   * Returns matching symbols ordered alphabetically by canonical_name.
   */
  private symbolsByDoc(snapshotId: number, pattern: string, limit: number): Array<Record<string, unknown>> {
    if (!pattern || pattern.length === 0) return []
    const safe = pattern.replace(/[\\%_]/g, "\\$&")
    const sql = `
      SELECT
        canonical_name,
        kind,
        location,
        json_extract(payload, '$.metadata.doc') AS doc
      FROM graph_nodes
      WHERE snapshot_id = ?
        AND json_extract(payload, '$.metadata.doc') LIKE ? ESCAPE '\\'
      ORDER BY canonical_name
      LIMIT ?
    `
    const rows = this.raw.prepare(sql).all(snapshotId, `%${safe}%`, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: obj.kind ?? "function",
      canonical_name: obj.canonical_name,
      caller: null,
      callee: obj.canonical_name,
      edge_kind: "contains",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
      doc: obj.doc,
    }))
  }

  /**
   * Find the deepest call chain reachable from a starting symbol.
   * Walks the calls graph forward via a recursive CTE without a
   * fixed destination — the result is the longest path from the
   * root within the depth bound.
   *
   * Visualizers use this for "worst-case execution path" or "show
   * me the deepest stack from this entry point" views. Returned
   * rows are per-hop in the longest chain found, ordered by
   * path_index, with chain_depth = total length.
   *
   * Bounded depth (default 8, clamped to [1, 12]) and cycle
   * prevention via the running path string.
   */
  private deepestCallChain(snapshotId: number, rootName: string, depth: number): Array<Record<string, unknown>> {
    if (!rootName) return []
    const maxDepth = Math.min(Math.max(depth, 1), 12)
    const sql = `
      WITH RECURSIVE chain(callee_name, depth_n, path) AS (
        SELECT
          dst.canonical_name,
          1,
          src.canonical_name || ' -> ' || dst.canonical_name
        FROM graph_edges e
        INNER JOIN graph_nodes src
          ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
        INNER JOIN graph_nodes dst
          ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
        WHERE e.snapshot_id = ?
          AND e.edge_kind = 'calls'
          AND src.canonical_name = ?
        UNION ALL
        SELECT
          dst.canonical_name,
          c.depth_n + 1,
          c.path || ' -> ' || dst.canonical_name
        FROM chain c
        INNER JOIN graph_edges e
          ON e.snapshot_id = ?
          AND e.edge_kind = 'calls'
        INNER JOIN graph_nodes src
          ON e.src_node_id = src.node_id
          AND e.snapshot_id = src.snapshot_id
          AND src.canonical_name = c.callee_name
        INNER JOIN graph_nodes dst
          ON e.dst_node_id = dst.node_id
          AND e.snapshot_id = dst.snapshot_id
        WHERE c.depth_n < ?
          AND instr(c.path || ' -> ', dst.canonical_name || ' -> ') = 0
      )
      SELECT depth_n, path
      FROM chain
      ORDER BY depth_n DESC, path ASC
      LIMIT 1
    `
    type Row = { depth_n: number; path: string }
    const rows = this.raw.prepare(sql).all(snapshotId, rootName, snapshotId, maxDepth) as Row[]
    if (rows.length === 0) return []
    const longest = rows[0]
    const segments = longest.path.split(" -> ")
    return segments.slice(0, -1).map((caller, i) => ({
      kind: "function",
      canonical_name: caller,
      caller,
      callee: segments[i + 1],
      edge_kind: "calls",
      confidence: 1,
      derivation: "clangd",
      file_path: null,
      line_number: null,
      path_index: i,
      chain_depth: longest.depth_n,
    }))
  }

  /**
   * Find pairs of types that reference each other (2-cycles in the
   * references_type graph). When type A has a field of type B and
   * type B has a field of type A, that's a circular type dependency
   * — often a refactor signal (extract a shared interface, break
   * the bidirectional coupling, etc.).
   *
   * Same self-join pattern as find_import_cycles but on
   * references_type edges. Filters to class/interface dst kinds so
   * the result is meaningful (function-level type references aren't
   * usually mutual). De-duped via canonical_name comparison.
   */
  private typeCycles(snapshotId: number, limit: number): Array<Record<string, unknown>> {
    const sql = `
      SELECT
        a.canonical_name AS caller,
        b.canonical_name AS callee,
        a.canonical_name AS canonical_name,
        a.kind AS kind,
        'references_type' AS edge_kind,
        1.0 AS confidence,
        'clangd' AS derivation,
        a.location AS location
      FROM graph_edges e1
      INNER JOIN graph_nodes a
        ON e1.src_node_id = a.node_id AND e1.snapshot_id = a.snapshot_id
      INNER JOIN graph_nodes b
        ON e1.dst_node_id = b.node_id AND e1.snapshot_id = b.snapshot_id
      INNER JOIN graph_edges e2
        ON e2.snapshot_id = e1.snapshot_id
        AND e2.src_node_id = e1.dst_node_id
        AND e2.dst_node_id = e1.src_node_id
      WHERE e1.snapshot_id = ?
        AND e1.edge_kind = 'references_type'
        AND e2.edge_kind = 'references_type'
        AND a.kind IN ('class', 'interface')
        AND b.kind IN ('class', 'interface')
        AND a.canonical_name < b.canonical_name
      LIMIT ?
    `
    const rows = this.raw.prepare(sql).all(snapshotId, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: obj.kind ?? "class",
      canonical_name: obj.canonical_name,
      caller: obj.caller,
      callee: obj.callee,
      edge_kind: "references_type",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
    }))
  }

  /**
   * Single-call overview of every module in the snapshot. Returns
   * aggregate counts (symbol_count, exported_count, outgoing_imports,
   * incoming_imports, line_count) for each module so visualizers can
   * populate a file tree without N round-trips.
   *
   * Each row is a module with its summary metrics. Ordered
   * alphabetically by canonical_name. Bounded by limit (the visualizer
   * can paginate or pre-filter via find_symbols_by_name first).
   */
  private modulesOverview(snapshotId: number, limit: number): Array<Record<string, unknown>> {
    const sql = `
      SELECT
        m.canonical_name AS canonical_name,
        m.location AS location,
        json_extract(m.payload, '$.metadata.lineCount') AS line_count,
        (
          SELECT COUNT(*) FROM graph_edges e
          INNER JOIN graph_nodes src
            ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
          WHERE e.snapshot_id = m.snapshot_id
            AND e.edge_kind = 'contains'
            AND src.canonical_name = m.canonical_name
        ) AS symbol_count,
        (
          SELECT COUNT(*) FROM graph_edges e
          INNER JOIN graph_nodes src
            ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
          INNER JOIN graph_nodes dst
            ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
          WHERE e.snapshot_id = m.snapshot_id
            AND e.edge_kind = 'contains'
            AND src.canonical_name = m.canonical_name
            AND json_extract(dst.payload, '$.metadata.exported') = 1
        ) AS exported_count,
        (
          SELECT COUNT(*) FROM graph_edges e
          INNER JOIN graph_nodes src
            ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
          WHERE e.snapshot_id = m.snapshot_id
            AND e.edge_kind = 'imports'
            AND src.canonical_name = m.canonical_name
        ) AS outgoing_imports,
        (
          SELECT COUNT(*) FROM graph_edges e
          INNER JOIN graph_nodes dst
            ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
          WHERE e.snapshot_id = m.snapshot_id
            AND e.edge_kind = 'imports'
            AND dst.canonical_name = m.canonical_name
        ) AS incoming_imports
      FROM graph_nodes m
      WHERE m.snapshot_id = ?
        AND m.kind = 'module'
      ORDER BY m.canonical_name ASC
      LIMIT ?
    `
    const rows = this.raw.prepare(sql).all(snapshotId, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: "module",
      canonical_name: obj.canonical_name,
      caller: null,
      callee: obj.canonical_name,
      edge_kind: "contains",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
      symbol_count: toNumber(obj.symbol_count),
      exported_count: toNumber(obj.exported_count),
      outgoing_imports: toNumber(obj.outgoing_imports),
      incoming_imports: toNumber(obj.incoming_imports),
      line_count: toNumberOrNull(obj.line_count),
    }))
  }

  /**
   * Find all calls + references_type edges between symbols in two
   * modules. Visualizers use this to render "how do these two modules
   * interact" views — typically a focused subgraph showing every
   * cross-talk site.
   *
   * Module membership is determined by canonical_name prefix matching.
   * A symbol with canonical_name `module:src/foo.ts#bar` belongs to
   * module `module:src/foo.ts`. The query also matches the module's
   * own symbol (for cases where the edge is module → module rather
   * than symbol → symbol).
   *
   * Required: srcApi and dstApi must be module canonical_names.
   */
  private moduleInteractions(
    snapshotId: number,
    srcModule: string,
    dstModule: string,
    limit: number,
  ): Array<Record<string, unknown>> {
    if (!srcModule || !dstModule) return []
    // Escape LIKE wildcards in the module names so they're treated
    // literally
    const escape = (s: string): string => s.replace(/[\\%_]/g, "\\$&")
    const srcPrefix = `${escape(srcModule)}#%`
    const dstPrefix = `${escape(dstModule)}#%`
    const sql = `
      SELECT
        src.canonical_name AS caller,
        dst.canonical_name AS callee,
        e.edge_kind AS edge_kind,
        e.confidence AS confidence,
        e.derivation AS derivation,
        src.location AS location,
        e.metadata AS metadata
      FROM graph_edges e
      INNER JOIN graph_nodes src
        ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
      INNER JOIN graph_nodes dst
        ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
      WHERE e.snapshot_id = ?
        AND e.edge_kind IN ('calls', 'references_type')
        AND (src.canonical_name = ? OR src.canonical_name LIKE ? ESCAPE '\\')
        AND (dst.canonical_name = ? OR dst.canonical_name LIKE ? ESCAPE '\\')
      ORDER BY e.edge_kind, src.canonical_name, dst.canonical_name
      LIMIT ?
    `
    const rows = this.raw.prepare(sql).all(snapshotId, srcModule, srcPrefix, dstModule, dstPrefix, limit) as Array<
      Record<string, unknown>
    >
    return rows.map((obj) => ({
      kind: "edge",
      canonical_name: obj.caller,
      caller: obj.caller,
      callee: obj.callee,
      edge_kind: obj.edge_kind,
      confidence: toNumber(obj.confidence),
      derivation: obj.derivation,
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
      metadata: parseJson(obj.metadata),
    }))
  }

  /**
   * Return degree counts for a single symbol: total incoming and
   * outgoing edges, plus per-edge_kind breakdowns. Visualizers use
   * this to render fan-in/fan-out badges next to a symbol.
   *
   * Returns one row per (direction, edge_kind) pair so the
   * visualizer can pivot client-side. The first column says whether
   * the count is incoming or outgoing.
   */
  private symbolDegree(snapshotId: number, symbolName: string): Array<Record<string, unknown>> {
    if (!symbolName) return []
    const sql = `
      SELECT 'outgoing' AS direction, e.edge_kind, COUNT(*) AS count
      FROM graph_edges e
      INNER JOIN graph_nodes src
        ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
      WHERE e.snapshot_id = ?
        AND src.canonical_name = ?
      GROUP BY e.edge_kind
      UNION ALL
      SELECT 'incoming' AS direction, e.edge_kind, COUNT(*) AS count
      FROM graph_edges e
      INNER JOIN graph_nodes dst
        ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
      WHERE e.snapshot_id = ?
        AND dst.canonical_name = ?
      GROUP BY e.edge_kind
      ORDER BY direction, count DESC
    `
    const rows = this.raw.prepare(sql).all(snapshotId, symbolName, snapshotId, symbolName) as Array<{
      direction: string
      edge_kind: string
      count: number
    }>
    return rows.map((row) => ({
      kind: "edge_count",
      canonical_name: symbolName,
      caller: row.direction === "incoming" ? null : symbolName,
      callee: row.direction === "outgoing" ? null : symbolName,
      edge_kind: row.edge_kind,
      confidence: 1,
      derivation: "clangd",
      file_path: null,
      line_number: null,
      direction: row.direction,
      degree_count: toNumber(row.count),
    }))
  }

  /**
   * Find cycles in the imports graph that pass through a specific
   * starting module, of length 3 to `depth`. Uses a recursive CTE
   * that walks forward only from the requested module, which bounds
   * the search to the local neighborhood instead of exploring the
   * entire graph (which would be exponential on a 600-module project).
   *
   * Each cycle returns one row whose `path` field contains the full
   * sequence of module names involved (e.g.
   * `module:src/a.ts -> module:src/b.ts -> module:src/c.ts -> module:src/a.ts`).
   *
   * Cycles are de-duped by their canonical (sorted) member set — the
   * same cycle starting at a different rotation only appears once.
   * The first row's `path` shows the canonical traversal.
   *
   * Required: apiName must be the canonical_name of a module. Without
   * a starting module the query would explode combinatorially.
   */
  private importCyclesDeep(
    snapshotId: number,
    rootName: string,
    depth: number,
    limit: number,
  ): Array<Record<string, unknown>> {
    if (!rootName) return []
    const maxDepth = Math.min(Math.max(depth, 3), 8)
    const sql = `
      WITH RECURSIVE walks(start_name, current_name, depth_n, path) AS (
        SELECT
          src.canonical_name,
          dst.canonical_name,
          1,
          src.canonical_name || ' -> ' || dst.canonical_name
        FROM graph_edges e
        INNER JOIN graph_nodes src
          ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
        INNER JOIN graph_nodes dst
          ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
        WHERE e.snapshot_id = ?
          AND e.edge_kind = 'imports'
          AND src.kind = 'module'
          AND dst.kind = 'module'
          AND src.canonical_name = ?
        UNION ALL
        SELECT
          w.start_name,
          dst.canonical_name,
          w.depth_n + 1,
          w.path || ' -> ' || dst.canonical_name
        FROM walks w
        INNER JOIN graph_edges e
          ON e.snapshot_id = ?
          AND e.edge_kind = 'imports'
        INNER JOIN graph_nodes src
          ON e.src_node_id = src.node_id
          AND e.snapshot_id = src.snapshot_id
          AND src.canonical_name = w.current_name
        INNER JOIN graph_nodes dst
          ON e.dst_node_id = dst.node_id
          AND e.snapshot_id = dst.snapshot_id
        WHERE w.depth_n < ?
          -- prevent revisiting nodes other than the start
          AND (
            dst.canonical_name = w.start_name
            OR instr(w.path || ' -> ', dst.canonical_name || ' -> ') = 0
          )
      )
      SELECT DISTINCT
        depth_n + 1 AS cycle_length,
        path
      FROM walks
      WHERE current_name = start_name
        AND depth_n >= 2
      ORDER BY cycle_length ASC, path ASC
      LIMIT ?
    `
    type Row = { cycle_length: number; path: string }
    const rows = this.raw.prepare(sql).all(snapshotId, rootName, snapshotId, maxDepth, limit) as Row[]
    // De-dup cycles by their canonical (sorted) member set so the same
    // cycle starting from different nodes only appears once.
    const seen = new Set<string>()
    const out: Array<Record<string, unknown>> = []
    for (const row of rows) {
      const segments = row.path.split(" -> ")
      // The path always closes back to the start, so the last segment
      // duplicates the first. Strip it for the canonical key.
      const ring = segments.slice(0, -1)
      const key = [...ring].sort().join("|")
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        kind: "module",
        canonical_name: ring[0],
        caller: ring[0],
        callee: ring[ring.length - 1],
        edge_kind: "imports",
        confidence: 1,
        derivation: "clangd",
        file_path: null,
        line_number: null,
        cycle_length: row.cycle_length - 1, // edges = nodes (since cycle closes)
        path: row.path,
      })
    }
    return out
  }

  /**
   * For a given module, return its exported symbols ranked by total
   * incoming usage (calls + references_type). Useful for "the most-used
   * exports of this module" views in API health dashboards.
   *
   * Implementation: a join between graph_nodes (the module's contained
   * symbols where exported=true) and a count of incoming usage edges.
   * Symbols are ordered DESC by usage_count, with ties broken
   * alphabetically.
   */
  private moduleTopExports(snapshotId: number, moduleName: string, limit: number): Array<Record<string, unknown>> {
    if (!moduleName) return []
    const sql = `
      SELECT
        n.canonical_name AS canonical_name,
        n.kind AS kind,
        n.location AS location,
        (
          SELECT COUNT(*) FROM graph_edges e
          INNER JOIN graph_nodes dst
            ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
          WHERE e.snapshot_id = n.snapshot_id
            AND e.edge_kind IN ('calls', 'references_type')
            AND dst.canonical_name = n.canonical_name
        ) AS usage_count
      FROM graph_nodes n
      INNER JOIN graph_edges contains
        ON contains.dst_node_id = n.node_id
        AND contains.snapshot_id = n.snapshot_id
        AND contains.edge_kind = 'contains'
      INNER JOIN graph_nodes parent
        ON contains.src_node_id = parent.node_id
        AND contains.snapshot_id = parent.snapshot_id
      WHERE n.snapshot_id = ?
        AND parent.canonical_name = ?
        AND parent.kind = 'module'
        AND json_extract(n.payload, '$.metadata.exported') = 1
      ORDER BY usage_count DESC, n.canonical_name ASC
      LIMIT ?
    `
    const rows = this.raw.prepare(sql).all(snapshotId, moduleName, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: obj.kind ?? "function",
      canonical_name: obj.canonical_name,
      caller: null,
      callee: obj.canonical_name,
      edge_kind: "contains",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
      usage_count: toNumber(obj.usage_count),
    }))
  }

  /**
   * Find sibling symbols: peers that share the same parent via
   * contains edges. When the user clicks on a method, this returns
   * the other methods of the same class. When the user clicks on a
   * top-level function, it returns the other top-level symbols in
   * the same module. The original symbol is excluded.
   *
   * Two-step query: a CTE finds the symbol's parent (the src of any
   * incoming contains edge), then the outer SELECT enumerates that
   * parent's other children. Uses canonical_name throughout for
   * legibility.
   */
  private siblingSymbols(snapshotId: number, symbolName: string, limit: number): Array<Record<string, unknown>> {
    if (!symbolName) return []
    const sql = `
      WITH parent AS (
        SELECT src.canonical_name AS name
        FROM graph_edges e
        INNER JOIN graph_nodes src
          ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
        INNER JOIN graph_nodes dst
          ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
        WHERE e.snapshot_id = ?
          AND e.edge_kind = 'contains'
          AND dst.canonical_name = ?
        LIMIT 1
      )
      SELECT DISTINCT
        dst.canonical_name AS canonical_name,
        dst.kind AS kind,
        dst.location AS location
      FROM graph_edges e
      INNER JOIN graph_nodes src
        ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
      INNER JOIN graph_nodes dst
        ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
      INNER JOIN parent p ON src.canonical_name = p.name
      WHERE e.snapshot_id = ?
        AND e.edge_kind = 'contains'
        AND dst.canonical_name != ?
      ORDER BY json_extract(dst.location, '$.line') ASC, dst.canonical_name ASC
      LIMIT ?
    `
    const rows = this.raw.prepare(sql).all(snapshotId, symbolName, snapshotId, symbolName, limit) as Array<
      Record<string, unknown>
    >
    return rows.map((obj) => ({
      kind: obj.kind ?? "function",
      canonical_name: obj.canonical_name,
      caller: null,
      callee: obj.canonical_name,
      edge_kind: "contains",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
    }))
  }

  /**
   * List all symbols defined in a given file, ordered by start line.
   * Used by visualizer file-outline views — the visualizer can pass
   * a filepath without having to construct the module FQ name first.
   *
   * Returns every symbol whose location.filePath matches, including
   * the module symbol itself, top-level functions/classes, and nested
   * methods. Modules and members both flow through.
   */
  private symbolsInFile(snapshotId: number, filePath: string, limit: number): Array<Record<string, unknown>> {
    if (!filePath) return []
    // Support both absolute and relative (workspace-relative) file paths.
    // The stored location.filePath may be absolute; try exact match first,
    // then fall back to a suffix match for relative paths.
    const sql = `
      SELECT
        canonical_name,
        kind,
        location,
        json_extract(payload, '$.metadata.endLine') AS end_line
      FROM graph_nodes
      WHERE snapshot_id = ?
        AND (json_extract(location, '$.filePath') = ?
             OR json_extract(location, '$.filePath') LIKE ? ESCAPE '\\')
      ORDER BY json_extract(location, '$.line') ASC, canonical_name ASC
      LIMIT ?
    `
    const escapedPath = filePath.replace(/%/g, "\\%").replace(/_/g, "\\_")
    const suffixPattern = `%/${escapedPath}`
    const rows = this.raw.prepare(sql).all(snapshotId, filePath, suffixPattern, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: obj.kind ?? "function",
      canonical_name: obj.canonical_name,
      caller: null,
      callee: obj.canonical_name,
      edge_kind: "contains",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
      end_line: toNumberOrNull(obj.end_line),
    }))
  }

  /**
   * Aggregate health summary for a single module. Returns one row
   * with these fields:
   *   - symbol_count: contained symbols (direct children via contains)
   *   - exported_count: contained symbols with metadata.exported=true
   *   - outgoing_imports: number of imports edges originating here
   *   - incoming_imports: number of imports edges pointing here
   *   - line_count: from the module's metadata.lineCount
   *
   * Visualizers use this for module browser hovers, tab badges, and
   * "module health at a glance" views.
   */
  private moduleSummary(snapshotId: number, moduleName: string): Array<Record<string, unknown>> {
    if (!moduleName) return []
    const sql = `
      SELECT
        m.canonical_name AS canonical_name,
        m.location AS location,
        json_extract(m.payload, '$.metadata.lineCount') AS line_count,
        (
          SELECT COUNT(*) FROM graph_edges e
          INNER JOIN graph_nodes src
            ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
          WHERE e.snapshot_id = m.snapshot_id
            AND e.edge_kind = 'contains'
            AND src.canonical_name = m.canonical_name
        ) AS symbol_count,
        (
          SELECT COUNT(*) FROM graph_edges e
          INNER JOIN graph_nodes src
            ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
          INNER JOIN graph_nodes dst
            ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
          WHERE e.snapshot_id = m.snapshot_id
            AND e.edge_kind = 'contains'
            AND src.canonical_name = m.canonical_name
            AND json_extract(dst.payload, '$.metadata.exported') = 1
        ) AS exported_count,
        (
          SELECT COUNT(*) FROM graph_edges e
          INNER JOIN graph_nodes src
            ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
          WHERE e.snapshot_id = m.snapshot_id
            AND e.edge_kind = 'imports'
            AND src.canonical_name = m.canonical_name
        ) AS outgoing_imports,
        (
          SELECT COUNT(*) FROM graph_edges e
          INNER JOIN graph_nodes dst
            ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
          WHERE e.snapshot_id = m.snapshot_id
            AND e.edge_kind = 'imports'
            AND dst.canonical_name = m.canonical_name
        ) AS incoming_imports
      FROM graph_nodes m
      WHERE m.snapshot_id = ?
        AND m.kind = 'module'
        AND m.canonical_name = ?
      LIMIT 1
    `
    const rows = this.raw.prepare(sql).all(snapshotId, moduleName) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: "module",
      canonical_name: obj.canonical_name,
      caller: null,
      callee: obj.canonical_name,
      edge_kind: "contains",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
      symbol_count: toNumber(obj.symbol_count),
      exported_count: toNumber(obj.exported_count),
      outgoing_imports: toNumber(obj.outgoing_imports),
      incoming_imports: toNumber(obj.incoming_imports),
      line_count: toNumberOrNull(obj.line_count),
    }))
  }

  private classSummary(snapshotId: number, className: string): Array<Record<string, unknown>> {
    if (!className) return []
    const sql = `
      SELECT
        n.canonical_name AS canonical_name,
        n.kind AS kind,
        n.location AS location,
        json_extract(n.payload, '$.metadata.lineCount') AS line_count,
        (
          SELECT COUNT(*) FROM graph_edges e
          INNER JOIN graph_nodes dst
            ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
          WHERE e.snapshot_id = n.snapshot_id
            AND e.edge_kind = 'contains'
            AND e.src_node_id = n.node_id
            AND dst.kind = 'method'
        ) AS method_count,
        (
          SELECT COUNT(*) FROM graph_edges e
          INNER JOIN graph_nodes dst
            ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
          WHERE e.snapshot_id = n.snapshot_id
            AND e.edge_kind = 'contains'
            AND e.src_node_id = n.node_id
            AND dst.kind = 'field'
        ) AS field_count,
        (
          SELECT COUNT(*) FROM graph_edges e
          WHERE e.snapshot_id = n.snapshot_id
            AND e.edge_kind = 'extends'
            AND e.src_node_id = n.node_id
        ) AS extends_count,
        (
          SELECT COUNT(*) FROM graph_edges e
          WHERE e.snapshot_id = n.snapshot_id
            AND e.edge_kind = 'implements'
            AND e.src_node_id = n.node_id
        ) AS implements_count,
        (
          SELECT COUNT(*) FROM graph_edges e
          WHERE e.snapshot_id = n.snapshot_id
            AND e.edge_kind = 'references_type'
            AND e.src_node_id = n.node_id
        ) AS type_dependency_count,
        (
          SELECT COUNT(*) FROM graph_edges e
          WHERE e.snapshot_id = n.snapshot_id
            AND e.edge_kind = 'aggregates'
            AND e.src_node_id = n.node_id
        ) AS aggregate_count
      FROM graph_nodes n
      WHERE n.snapshot_id = ?
        AND n.kind IN ('class', 'interface', 'struct')
        AND n.canonical_name = ?
      LIMIT 1
    `
    const rows = this.raw.prepare(sql).all(snapshotId, className) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: obj.kind ?? "class",
      canonical_name: obj.canonical_name,
      caller: null,
      callee: obj.canonical_name,
      edge_kind: "contains",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
      line_count: toNumberOrNull(obj.line_count),
      method_count: toNumber(obj.method_count),
      field_count: toNumber(obj.field_count),
      extends_count: toNumber(obj.extends_count),
      implements_count: toNumber(obj.implements_count),
      type_dependency_count: toNumber(obj.type_dependency_count),
      aggregate_count: toNumber(obj.aggregate_count),
    }))
  }

  private typeSummary(snapshotId: number, typeName: string): Array<Record<string, unknown>> {
    if (!typeName) return []
    const sql = `
      SELECT
        n.canonical_name AS canonical_name,
        n.kind AS kind,
        n.location AS location,
        json_extract(n.payload, '$.metadata.lineCount') AS line_count,
        (
          SELECT COUNT(*) FROM graph_edges e
          INNER JOIN graph_nodes dst
            ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
          WHERE e.snapshot_id = n.snapshot_id
            AND e.edge_kind = 'contains'
            AND e.src_node_id = n.node_id
            AND dst.kind IN ('field', 'enum_variant')
        ) AS field_count,
        (
          SELECT COUNT(*) FROM graph_edges e
          WHERE e.snapshot_id = n.snapshot_id
            AND e.edge_kind = 'aggregates'
            AND e.src_node_id = n.node_id
        ) AS aggregate_count,
        (
          SELECT COUNT(*) FROM graph_edges e
          WHERE e.snapshot_id = n.snapshot_id
            AND e.edge_kind = 'aggregates'
            AND e.dst_node_id = n.node_id
        ) AS aggregator_count,
        (
          SELECT COUNT(*) FROM graph_edges e
          WHERE e.snapshot_id = n.snapshot_id
            AND e.edge_kind = 'references_type'
            AND e.dst_node_id = n.node_id
        ) AS consumer_count,
        (
          SELECT COUNT(*) FROM graph_edges e
          WHERE e.snapshot_id = n.snapshot_id
            AND e.edge_kind = 'field_of_type'
            AND e.dst_node_id = n.node_id
        ) AS field_reference_count,
        (
          SELECT COUNT(*) FROM graph_edges e
          WHERE e.snapshot_id = n.snapshot_id
            AND e.edge_kind IN ('reads_field', 'writes_field')
            AND e.dst_node_id IN (
              SELECT dst.node_id
              FROM graph_edges c
              INNER JOIN graph_nodes dst
                ON c.dst_node_id = dst.node_id AND c.snapshot_id = dst.snapshot_id
              WHERE c.snapshot_id = n.snapshot_id
                AND c.edge_kind = 'contains'
                AND c.src_node_id = n.node_id
                AND dst.kind IN ('field', 'enum_variant')
            )
        ) AS field_touch_count
      FROM graph_nodes n
      WHERE n.snapshot_id = ?
        AND n.kind IN ('class', 'interface', 'struct', 'typedef', 'enum', 'union')
        AND n.canonical_name = ?
      LIMIT 1
    `
    const rows = this.raw.prepare(sql).all(snapshotId, typeName) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: obj.kind ?? "typedef",
      canonical_name: obj.canonical_name,
      caller: null,
      callee: obj.canonical_name,
      edge_kind: "aggregates",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
      line_count: toNumberOrNull(obj.line_count),
      field_count: toNumber(obj.field_count),
      aggregate_count: toNumber(obj.aggregate_count),
      aggregator_count: toNumber(obj.aggregator_count),
      consumer_count: toNumber(obj.consumer_count),
      field_reference_count: toNumber(obj.field_reference_count),
      field_touch_count: toNumber(obj.field_touch_count),
    }))
  }

  private apiSummary(snapshotId: number, apiName: string): Array<Record<string, unknown>> {
    if (!apiName) return []
    const sql = `
      SELECT
        n.canonical_name AS canonical_name,
        n.kind AS kind,
        n.location AS location,
        json_extract(n.payload, '$.metadata.lineCount') AS line_count,
        (
          SELECT COUNT(*) FROM graph_edges e
          WHERE e.snapshot_id = n.snapshot_id
            AND e.edge_kind = 'calls'
            AND e.src_node_id = n.node_id
        ) AS outgoing_calls,
        (
          SELECT COUNT(*) FROM graph_edges e
          WHERE e.snapshot_id = n.snapshot_id
            AND e.edge_kind = 'calls'
            AND e.dst_node_id = n.node_id
        ) AS incoming_calls,
        (
          SELECT COUNT(*) FROM graph_edges e
          WHERE e.snapshot_id = n.snapshot_id
            AND e.edge_kind = 'references_type'
            AND e.src_node_id = n.node_id
        ) AS type_dependency_count,
        (
          SELECT COUNT(*) FROM graph_edges e
          WHERE e.snapshot_id = n.snapshot_id
            AND e.edge_kind = 'reads_field'
            AND e.src_node_id = n.node_id
        ) AS field_read_count,
        (
          SELECT COUNT(*) FROM graph_edges e
          WHERE e.snapshot_id = n.snapshot_id
            AND e.edge_kind = 'writes_field'
            AND e.src_node_id = n.node_id
        ) AS field_write_count,
        (
          SELECT COUNT(*) FROM graph_edges e
          WHERE e.snapshot_id = n.snapshot_id
            AND e.edge_kind = 'logs_event'
            AND e.src_node_id = n.node_id
        ) AS log_count,
        (
          SELECT src.canonical_name
          FROM graph_edges e
          INNER JOIN graph_nodes src
            ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
          WHERE e.snapshot_id = n.snapshot_id
            AND e.edge_kind = 'contains'
            AND e.dst_node_id = n.node_id
          LIMIT 1
        ) AS owner_symbol
      FROM graph_nodes n
      WHERE n.snapshot_id = ?
        AND n.kind IN ('function', 'method')
        AND n.canonical_name = ?
      LIMIT 1
    `
    const rows = this.raw.prepare(sql).all(snapshotId, apiName) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: obj.kind ?? "function",
      canonical_name: obj.canonical_name,
      caller: null,
      callee: obj.canonical_name,
      edge_kind: "calls",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
      line_count: toNumberOrNull(obj.line_count),
      outgoing_calls: toNumber(obj.outgoing_calls),
      incoming_calls: toNumber(obj.incoming_calls),
      type_dependency_count: toNumber(obj.type_dependency_count),
      field_read_count: toNumber(obj.field_read_count),
      field_write_count: toNumber(obj.field_write_count),
      log_count: toNumber(obj.log_count),
      owner_symbol: obj.owner_symbol,
    }))
  }

  private entitySummary(snapshotId: number, entityName: string): Array<Record<string, unknown>> {
    if (!entityName) return []

    const entityKindRow = this.raw
      .prepare(
        `SELECT kind FROM graph_nodes
         WHERE snapshot_id = ? AND canonical_name = ?
         LIMIT 1`,
      )
      .get(snapshotId, entityName) as { kind: string } | undefined

    if (!entityKindRow) return []

    const kind = entityKindRow.kind
    if (kind === "module") {
      return this.moduleSummary(snapshotId, entityName)
    } else if (kind === "class" || kind === "interface" || kind === "struct") {
      return this.classSummary(snapshotId, entityName)
    } else if (kind === "typedef" || kind === "enum" || kind === "union") {
      return this.typeSummary(snapshotId, entityName)
    } else if (kind === "function" || kind === "method") {
      return this.apiSummary(snapshotId, entityName)
    } else {
      return []
    }
  }

  private moduleApis(snapshotId: number, moduleName: string, limit: number): Array<Record<string, unknown>> {
    if (!moduleName) return []
    const sql = `
      SELECT
        dst.canonical_name AS canonical_name,
        dst.kind AS kind,
        dst.location AS location,
        dst.payload AS payload,
        (
          SELECT COUNT(*) FROM graph_edges e
          WHERE e.snapshot_id = dst.snapshot_id
            AND e.edge_kind = 'calls'
            AND e.dst_node_id = dst.node_id
        ) AS incoming_calls,
        (
          SELECT COUNT(*) FROM graph_edges e
          WHERE e.snapshot_id = dst.snapshot_id
            AND e.edge_kind = 'calls'
            AND e.src_node_id = dst.node_id
        ) AS outgoing_calls
      FROM graph_edges e
      INNER JOIN graph_nodes src
        ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
      INNER JOIN graph_nodes dst
        ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
      WHERE e.snapshot_id = ?
        AND e.edge_kind = 'contains'
        AND src.canonical_name = ?
        AND dst.kind IN ('function', 'method')
        AND json_extract(dst.payload, '$.metadata.exported') = 1
      ORDER BY dst.canonical_name
      LIMIT ?
    `
    const rows = this.raw.prepare(sql).all(snapshotId, moduleName, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: obj.kind ?? "function",
      canonical_name: obj.canonical_name,
      caller: moduleName,
      callee: obj.canonical_name,
      edge_kind: "contains",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
      incoming_calls: toNumber(obj.incoming_calls),
      outgoing_calls: toNumber(obj.outgoing_calls),
      exported: true,
    }))
  }

  private apiTypeDependencies(snapshotId: number, apiName: string, limit: number): Array<Record<string, unknown>> {
    if (!apiName) return []
    const sql = `
      SELECT
        dst.canonical_name AS canonical_name,
        dst.kind AS kind,
        dst.location AS location,
        COUNT(*) AS ref_count
      FROM graph_edges e
      INNER JOIN graph_nodes src
        ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
      INNER JOIN graph_nodes dst
        ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
      WHERE e.snapshot_id = ?
        AND e.edge_kind = 'references_type'
        AND src.canonical_name = ?
        AND dst.kind IN ('class', 'interface', 'struct', 'typedef', 'enum', 'union')
      GROUP BY dst.canonical_name, dst.kind, dst.location
      ORDER BY ref_count DESC, dst.canonical_name
      LIMIT ?
    `
    const rows = this.raw.prepare(sql).all(snapshotId, apiName, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: obj.kind ?? "typedef",
      canonical_name: obj.canonical_name,
      caller: apiName,
      callee: obj.canonical_name,
      edge_kind: "references_type",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
      ref_count: toNumber(obj.ref_count),
    }))
  }

  private typeDefiningModule(snapshotId: number, typeName: string): Array<Record<string, unknown>> {
    if (!typeName) return []
    const sql = `
      SELECT
        src.canonical_name AS canonical_name,
        src.kind AS kind,
        src.location AS location,
        json_extract(src.payload, '$.metadata.lineCount') AS line_count
      FROM graph_edges e
      INNER JOIN graph_nodes src
        ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
      INNER JOIN graph_nodes dst
        ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
      WHERE e.snapshot_id = ?
        AND e.edge_kind = 'contains'
        AND dst.canonical_name = ?
        AND src.kind = 'module'
      LIMIT 1
    `
    const rows = this.raw.prepare(sql).all(snapshotId, typeName) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: "module",
      canonical_name: obj.canonical_name,
      caller: null,
      callee: obj.canonical_name,
      edge_kind: "contains",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
      line_count: toNumberOrNull(obj.line_count),
      type_contained: typeName,
    }))
  }

  private workspaceHealth(snapshotId: number): Array<Record<string, unknown>> {
    const moduleCount = (
      this.raw
        .prepare("SELECT COUNT(*) AS n FROM graph_nodes WHERE snapshot_id = ? AND kind = ?")
        .get(snapshotId, "module") as { n: number }
    ).n
    const classCount = (
      this.raw
        .prepare(
          `SELECT COUNT(*) AS n FROM graph_nodes
           WHERE snapshot_id = ? AND kind IN ('class', 'interface', 'struct')`,
        )
        .get(snapshotId) as { n: number }
    ).n
    const typeCount = (
      this.raw
        .prepare(
          `SELECT COUNT(*) AS n FROM graph_nodes
           WHERE snapshot_id = ? AND kind IN ('typedef', 'enum', 'union')`,
        )
        .get(snapshotId) as { n: number }
    ).n
    const apiCount = (
      this.raw
        .prepare(
          `SELECT COUNT(*) AS n FROM graph_nodes
           WHERE snapshot_id = ? AND kind IN ('function', 'method')`,
        )
        .get(snapshotId) as { n: number }
    ).n

    const callEdges = (
      this.raw
        .prepare("SELECT COUNT(*) AS n FROM graph_edges WHERE snapshot_id = ? AND edge_kind = ?")
        .get(snapshotId, "calls") as { n: number }
    ).n
    const importEdges = (
      this.raw
        .prepare("SELECT COUNT(*) AS n FROM graph_edges WHERE snapshot_id = ? AND edge_kind = ?")
        .get(snapshotId, "imports") as { n: number }
    ).n
    const refEdges = (
      this.raw
        .prepare("SELECT COUNT(*) AS n FROM graph_edges WHERE snapshot_id = ? AND edge_kind = ?")
        .get(snapshotId, "references_type") as { n: number }
    ).n
    const fieldEdges = (
      this.raw
        .prepare(
          `SELECT COUNT(*) AS n FROM graph_edges
           WHERE snapshot_id = ? AND edge_kind IN ('reads_field', 'writes_field')`,
        )
        .get(snapshotId) as { n: number }
    ).n

    const deadExports = (
      this.raw
        .prepare(
          `SELECT COUNT(*) AS n FROM graph_nodes n
           WHERE n.snapshot_id = ?
             AND json_extract(n.payload, '$.metadata.exported') = 1
             AND NOT EXISTS (
               SELECT 1 FROM graph_edges e
               WHERE e.snapshot_id = n.snapshot_id
                 AND e.edge_kind IN ('calls', 'references_type', 'imports')
                 AND e.dst_node_id = n.node_id
             )`,
        )
        .get(snapshotId) as { n: number }
    ).n

    const unusedFields = (
      this.raw
        .prepare(
          `SELECT COUNT(*) AS n FROM graph_edges dst_edge
           INNER JOIN graph_nodes field
             ON dst_edge.dst_node_id = field.node_id
           WHERE dst_edge.snapshot_id = ?
             AND field.kind IN ('field', 'enum_variant')
             AND NOT EXISTS (
               SELECT 1 FROM graph_edges access
               WHERE access.snapshot_id = field.snapshot_id
                 AND access.edge_kind IN ('reads_field', 'writes_field')
                 AND access.dst_node_id = field.node_id
             )`,
        )
        .get(snapshotId) as { n: number }
    ).n

    return [
      {
        kind: "workspace_health",
        canonical_name: `snapshot:${snapshotId}`,
        snapshot_id: snapshotId,
        modules_count: moduleCount,
        classes_count: classCount,
        types_count: typeCount,
        apis_count: apiCount,
        call_edges: callEdges,
        import_edges: importEdges,
        reference_edges: refEdges,
        field_access_edges: fieldEdges,
        dead_exports: deadExports,
        unused_fields: unusedFields,
        health_score: (
          100 -
          Math.min(50, (deadExports * 100) / Math.max(1, apiCount)) -
          Math.min(50, (unusedFields * 100) / Math.max(1, typeCount))
        ).toFixed(1),
      },
    ]
  }

  /**
   * Rank modules by a problem score combining dead exports, high outgoing
   * coupling, and low internal cohesion. Surfaces the modules most worth
   * attention during a cleanup sprint.
   *
   * problem_score = dead_exports*10 + outgoing_imports*2 - internal_calls*0.1
   * (Higher = more problematic.)
   */
  private analyzeProblematicModules(snapshotId: number, limit: number): Array<Record<string, unknown>> {
    // Collect per-module metrics in JS to avoid a deeply nested correlated subquery.
    const modules = this.raw
      .prepare(
        `SELECT node_id, canonical_name FROM graph_nodes
         WHERE snapshot_id = ? AND kind = 'module'`,
      )
      .all(snapshotId) as Array<{ node_id: string; canonical_name: string }>

    const results: Array<{
      canonical_name: string
      outgoing_imports: number
      dead_exports: number
      internal_calls: number
      problem_score: number
    }> = []

    for (const mod of modules) {
      const outgoing = (
        this.raw
          .prepare(
            `SELECT COUNT(*) AS n FROM graph_edges WHERE snapshot_id = ? AND edge_kind = 'imports' AND src_node_id = ?`,
          )
          .get(snapshotId, mod.node_id) as { n: number }
      ).n

      // Escape LIKE wildcards in module canonical_name so e.g. "module:src/api_handler.ts"
      // matches literally, not with '_' as a single-char wildcard.
      const escapedMod = mod.canonical_name.replace(/%/g, "\\%").replace(/_/g, "\\_")

      const deadExports = (
        this.raw
          .prepare(
            `SELECT COUNT(*) AS n FROM graph_nodes n
           WHERE n.snapshot_id = ?
             AND n.canonical_name LIKE ? || '#%' ESCAPE '\\'
             AND json_extract(n.payload, '$.metadata.exported') = 1
             AND NOT EXISTS (
               SELECT 1 FROM graph_edges e
               WHERE e.snapshot_id = n.snapshot_id
                 AND e.edge_kind IN ('calls', 'references_type', 'imports')
                 AND e.dst_node_id = n.node_id
             )`,
          )
          .get(snapshotId, escapedMod) as { n: number }
      ).n

      const internalCalls = (
        this.raw
          .prepare(
            `SELECT COUNT(*) AS n FROM graph_edges e
           INNER JOIN graph_nodes src ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
           INNER JOIN graph_nodes dst ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
           WHERE e.snapshot_id = ?
             AND e.edge_kind = 'calls'
             AND src.canonical_name LIKE ? || '#%' ESCAPE '\\'
             AND dst.canonical_name LIKE ? || '#%' ESCAPE '\\'`,
          )
          .get(snapshotId, escapedMod, escapedMod) as { n: number }
      ).n

      const score = deadExports * 10 + outgoing * 2 - internalCalls * 0.1
      results.push({
        canonical_name: mod.canonical_name,
        outgoing_imports: outgoing,
        dead_exports: deadExports,
        internal_calls: internalCalls,
        problem_score: score,
      })
    }

    return results
      .sort((a, b) => b.problem_score - a.problem_score)
      .slice(0, limit)
      .map((r) => ({
        kind: "module",
        canonical_name: r.canonical_name,
        outgoing_imports: r.outgoing_imports,
        dead_exports: r.dead_exports,
        internal_calls: r.internal_calls,
        problem_score: r.problem_score.toFixed(1),
      }))
  }

  /**
   * Rank classes/interfaces by a complexity score that combines method count,
   * field count, total internal calls, and type dependencies. God classes with
   * high scores across all dimensions are the strongest refactor candidates.
   *
   * complexity_score = methods*1.5 + fields + total_calls*0.5 + type_deps*0.3
   */
  private analyzeGodClasses(snapshotId: number, limit: number): Array<Record<string, unknown>> {
    const sql = `
      SELECT
        n.canonical_name AS canonical_name,
        n.kind AS kind,
        (
          SELECT COUNT(*) FROM graph_edges e
          INNER JOIN graph_nodes dst ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
          WHERE e.snapshot_id = n.snapshot_id AND e.edge_kind = 'contains'
            AND e.src_node_id = n.node_id AND dst.kind = 'method'
        ) AS method_count,
        (
          SELECT COUNT(*) FROM graph_edges e
          INNER JOIN graph_nodes dst ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
          WHERE e.snapshot_id = n.snapshot_id AND e.edge_kind = 'contains'
            AND e.src_node_id = n.node_id AND dst.kind = 'field'
        ) AS field_count,
        (
          SELECT COUNT(*) FROM graph_edges e
          WHERE e.snapshot_id = n.snapshot_id AND e.edge_kind = 'references_type'
            AND e.src_node_id IN (
              SELECT ee.dst_node_id FROM graph_edges ee WHERE ee.snapshot_id = n.snapshot_id
                AND ee.edge_kind = 'contains' AND ee.src_node_id = n.node_id
            )
        ) AS type_deps
      FROM graph_nodes n
      WHERE n.snapshot_id = ? AND n.kind IN ('class', 'interface')
      ORDER BY (method_count + field_count) DESC, type_deps DESC
      LIMIT ?
    `
    const rows = this.raw.prepare(sql).all(snapshotId, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => {
      const methods = toNumber(obj.method_count)
      const fields = toNumber(obj.field_count)
      const typeDeps = toNumber(obj.type_deps)
      return {
        kind: obj.kind,
        canonical_name: obj.canonical_name,
        method_count: methods,
        field_count: fields,
        type_deps: typeDeps,
        complexity_score: (methods * 1.5 + fields + typeDeps * 0.3).toFixed(1),
        recommendation:
          methods > 20 && fields > 10
            ? "split_class"
            : methods > 20
              ? "extract_service"
              : fields > 10
                ? "split_data_behavior"
                : "monitor",
      }
    })
  }

  /**
   * Rate each type/class by health status:
   *   - 'unused'  : no consumers and no field accesses (dead state)
   *   - 'hotspot' : field_touches > consumers*5 (contention risk)
   *   - 'healthy' : everything else
   *
   * Ordered so unused types and hotspots appear first.
   */
  private analyzeTypeHealth(snapshotId: number, limit: number): Array<Record<string, unknown>> {
    const sql = `
      SELECT
        n.canonical_name AS canonical_name,
        n.kind           AS kind,
        (
          SELECT COUNT(*) FROM graph_edges e
          INNER JOIN graph_nodes dst ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
          WHERE e.snapshot_id = n.snapshot_id AND e.edge_kind = 'contains'
            AND e.src_node_id = n.node_id AND dst.kind IN ('field', 'enum_variant')
        ) AS field_count,
        (
          SELECT COUNT(*) FROM graph_edges e
          WHERE e.snapshot_id = n.snapshot_id AND e.edge_kind = 'references_type'
            AND e.dst_node_id = n.node_id
        ) AS consumers,
        (
          SELECT COUNT(*) FROM graph_edges e
          WHERE e.snapshot_id = n.snapshot_id
            AND e.edge_kind IN ('reads_field', 'writes_field')
            AND e.dst_node_id IN (
              SELECT ee.dst_node_id FROM graph_edges ee WHERE ee.snapshot_id = n.snapshot_id
                AND ee.edge_kind = 'contains' AND ee.src_node_id = n.node_id
            )
        ) AS field_touches
      FROM graph_nodes n
      WHERE n.snapshot_id = ? AND n.kind IN ('class', 'interface', 'struct', 'typedef', 'enum')
      ORDER BY
        CASE WHEN consumers = 0 THEN 0 WHEN (field_touches * 1.0 / MAX(consumers, 1)) > 5 THEN 1 ELSE 2 END,
        field_touches DESC
      LIMIT ?
    `
    const rows = this.raw.prepare(sql).all(snapshotId, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => {
      const consumers = toNumber(obj.consumers)
      const touches = toNumber(obj.field_touches)
      const status = consumers === 0 ? "unused" : touches > consumers * 5 ? "hotspot" : "healthy"
      return {
        kind: "type_health",
        canonical_name: obj.canonical_name,
        type_kind: obj.kind,
        field_count: toNumber(obj.field_count),
        consumers,
        field_touches: touches,
        health_status: status,
      }
    })
  }

  /**
   * Identify dead code in two categories:
   *   - exported functions/methods with zero callers ('no_callers')
   *   - types/interfaces with no references at all ('no_references')
   *
   * Each row includes an `action` hint: remove_or_inline or remove_or_deprecate.
   */
  private analyzeDeadCode(snapshotId: number, limit: number): Array<Record<string, unknown>> {
    const halfLimit = Math.ceil(limit / 2)

    // A function/method is dead only when it has:
    //   no incoming calls AND no incoming imports
    // Re-exported symbols (imported by another module) are still live even if
    // never called directly within the snapshot.
    const deadApis = this.raw
      .prepare(
        `SELECT canonical_name, kind, location, 'no_callers' AS dead_reason
         FROM graph_nodes n
         WHERE n.snapshot_id = ?
           AND n.kind IN ('function', 'method')
           AND json_extract(n.payload, '$.metadata.exported') = 1
           AND NOT EXISTS (
             SELECT 1 FROM graph_edges e
             WHERE e.snapshot_id = n.snapshot_id AND e.edge_kind = 'calls'
               AND e.dst_node_id = n.node_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM graph_edges e
             WHERE e.snapshot_id = n.snapshot_id AND e.edge_kind = 'imports'
               AND e.dst_node_id = n.node_id
           )
         ORDER BY n.canonical_name
         LIMIT ?`,
      )
      .all(snapshotId, halfLimit) as Array<Record<string, unknown>>

    // A type is dead when it has no references_type, no contains, and no imports.
    const deadTypes = this.raw
      .prepare(
        `SELECT canonical_name, kind, location, 'no_references' AS dead_reason
         FROM graph_nodes n
         WHERE n.snapshot_id = ?
           AND n.kind IN ('typedef', 'class', 'interface')
           AND NOT EXISTS (
             SELECT 1 FROM graph_edges e
             WHERE e.snapshot_id = n.snapshot_id
               AND e.edge_kind IN ('references_type', 'contains', 'imports')
               AND e.dst_node_id = n.node_id
           )
         ORDER BY n.canonical_name
         LIMIT ?`,
      )
      .all(snapshotId, halfLimit) as Array<Record<string, unknown>>

    return [...deadApis, ...deadTypes].slice(0, limit).map((obj) => ({
      kind: obj.kind,
      canonical_name: obj.canonical_name,
      dead_reason: obj.dead_reason,
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
      action: obj.dead_reason === "no_callers" ? "remove_or_inline" : "remove_or_deprecate",
    }))
  }

  /**
   * Suggest refactoring targets by finding tightly coupled module pairs
   * (many cross-module calls + references). Returns the top pairs with a
   * human-readable suggestion message.
   */
  private suggestRefactors(snapshotId: number, limit: number): Array<Record<string, unknown>> {
    const sql = `
      SELECT
        SUBSTR(src.canonical_name, 1, INSTR(src.canonical_name, '#') - 1) AS src_module,
        SUBSTR(dst.canonical_name, 1, INSTR(dst.canonical_name, '#') - 1) AS dst_module,
        COUNT(*) AS coupling_count
      FROM graph_edges e
      INNER JOIN graph_nodes src ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
      INNER JOIN graph_nodes dst ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
      WHERE e.snapshot_id = ?
        AND e.edge_kind IN ('calls', 'references_type')
        AND INSTR(src.canonical_name, '#') > 0
        AND INSTR(dst.canonical_name, '#') > 0
        AND SUBSTR(src.canonical_name, 1, INSTR(src.canonical_name, '#') - 1)
            != SUBSTR(dst.canonical_name, 1, INSTR(dst.canonical_name, '#') - 1)
      GROUP BY src_module, dst_module
      ORDER BY coupling_count DESC
      LIMIT ?
    `
    const rows = this.raw.prepare(sql).all(snapshotId, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: "refactor_suggestion",
      canonical_name: String(obj.src_module),
      source: obj.src_module,
      target: obj.dst_module,
      coupling_count: toNumber(obj.coupling_count),
      suggestion: `High coupling (${toNumber(obj.coupling_count)} edges) between ${obj.src_module} and ${obj.dst_module}. Consider extracting shared logic or merging.`,
    }))
  }

  /**
   * Generate a per-module health report covering up to `limit` modules.
   * Each row carries: symbol count, exported count, API count, dead API
   * count, import fan-out, and a 0-100 module_health_score.
   *
   * module_health_score = 100
   *   - min(50, (dead_api_count / api_count) * 100)
   *   - min(50, outgoing_imports * 10)
   */
  private generateHealthReport(snapshotId: number, limit: number): Array<Record<string, unknown>> {
    const modules = this.raw
      .prepare(
        `SELECT node_id, canonical_name FROM graph_nodes
         WHERE snapshot_id = ? AND kind = 'module'
         ORDER BY canonical_name
         LIMIT ?`,
      )
      .all(snapshotId, Math.min(limit, 20)) as Array<{ node_id: string; canonical_name: string }>

    const report: Array<Record<string, unknown>> = []

    for (const mod of modules) {
      const summaryRows = this.moduleSummary(snapshotId, mod.canonical_name)
      const s = (summaryRows[0] ?? {}) as Record<string, unknown>

      const apiRows = this.moduleApis(snapshotId, mod.canonical_name, 1000)
      const apiCount = apiRows.length
      const deadApiCount = apiRows.filter(
        (r) => toNumber((r as { incoming_calls?: number }).incoming_calls) === 0,
      ).length

      const outgoingImports = toNumber((s as { outgoing_imports?: unknown }).outgoing_imports)

      const score = Math.max(
        0,
        100 - Math.min(50, (deadApiCount * 100) / Math.max(1, apiCount)) - Math.min(50, outgoingImports * 10),
      ).toFixed(1)

      report.push({
        kind: "module_health_report",
        canonical_name: mod.canonical_name,
        symbol_count: toNumber((s as { symbol_count?: unknown }).symbol_count),
        exported_count: toNumber((s as { exported_count?: unknown }).exported_count),
        api_count: apiCount,
        dead_api_count: deadApiCount,
        dead_api_ratio: (deadApiCount / Math.max(1, apiCount)).toFixed(2),
        outgoing_imports: outgoingImports,
        incoming_imports: toNumber((s as { incoming_imports?: unknown }).incoming_imports),
        module_health_score: score,
      })
    }

    return report.sort((a, b) => Number(a.module_health_score) - Number(b.module_health_score))
  }

  /**
   * Aggregate all analysis layers into a single prioritised action plan.
   *
   * Each row is one actionable item with:
   *   priority   1 (highest) – 4 (lowest)
   *   category   dead_code | god_class | refactor | type_health
   *   action     what to do
   *   target     the symbol/module/pair affected
   *   detail     supporting metric
   *
   * Priority assignment:
   *   1 – dead exported APIs (immediate removal candidates)
   *   2 – god classes scoring > 50 (strong refactor signal)
   *   3 – tightly coupled module pairs (coupling > 10 edges)
   *   4 – unused/hotspot types (monitor or cleanup)
   *
   * Ordered by priority ASC, then by detail metric DESC.
   */
  private generateActionPlan(snapshotId: number, limit: number): Array<Record<string, unknown>> {
    const items: Array<{
      priority: number
      category: string
      action: string
      target: string
      detail: string
    }> = []

    // Priority 1 — dead exported APIs (no callers AND not imported elsewhere)
    // Note: symbols passed as callbacks or re-exported through a barrel file
    // may still appear here because only direct `calls` edges are tracked.
    // Treat these as "review candidates" rather than guaranteed removals.
    const deadApis = this.raw
      .prepare(
        `SELECT canonical_name, kind,
           (SELECT COUNT(*) FROM graph_edges ei
            INNER JOIN graph_nodes msrc ON ei.src_node_id = msrc.node_id AND ei.snapshot_id = msrc.snapshot_id
            WHERE ei.snapshot_id = n.snapshot_id AND ei.edge_kind = 'imports'
              AND msrc.canonical_name != SUBSTR(n.canonical_name, 1, INSTR(n.canonical_name, '#') - 1)
              AND ei.dst_node_id = (
                SELECT node_id FROM graph_nodes
                WHERE snapshot_id = n.snapshot_id
                  AND canonical_name = SUBSTR(n.canonical_name, 1, INSTR(n.canonical_name, '#') - 1)
                LIMIT 1
              )
           ) AS module_import_count
         FROM graph_nodes n
         WHERE n.snapshot_id = ?
           AND n.kind IN ('function', 'method')
           AND json_extract(n.payload, '$.metadata.exported') = 1
           AND NOT EXISTS (
             SELECT 1 FROM graph_edges e
             WHERE e.snapshot_id = n.snapshot_id AND e.edge_kind = 'calls'
               AND e.dst_node_id = n.node_id
           )
         ORDER BY module_import_count ASC, n.canonical_name
         LIMIT 50`,
      )
      .all(snapshotId) as Array<{ canonical_name: string; kind: string; module_import_count: number }>

    for (const api of deadApis) {
      const isModuleImported = api.module_import_count > 0
      items.push({
        priority: 1,
        category: "dead_code",
        action: isModuleImported ? "review_callback_or_reexport" : "remove_or_inline",
        target: api.canonical_name,
        detail: isModuleImported
          ? `exported ${api.kind} with zero direct callers (module imported ${api.module_import_count}× — may be callback/re-export)`
          : `exported ${api.kind} with zero callers`,
      })
    }

    // Priority 2 — god classes: single SQL aggregation (fast path, no per-class subqueries)
    const godSql = `
      SELECT
        n.canonical_name AS canonical_name,
        SUM(CASE WHEN dst.kind = 'method' THEN 1 ELSE 0 END) AS method_count,
        SUM(CASE WHEN dst.kind = 'field'  THEN 1 ELSE 0 END) AS field_count
      FROM graph_nodes n
      INNER JOIN graph_edges ce ON ce.src_node_id = n.node_id AND ce.snapshot_id = n.snapshot_id
        AND ce.edge_kind = 'contains'
      INNER JOIN graph_nodes dst ON ce.dst_node_id = dst.node_id AND dst.snapshot_id = n.snapshot_id
        AND dst.kind IN ('method', 'field')
      WHERE n.snapshot_id = ?
        AND n.kind IN ('class', 'interface')
      GROUP BY n.canonical_name
      HAVING (method_count * 1.5 + field_count) > 50
      ORDER BY (method_count * 1.5 + field_count) DESC
      LIMIT 30
    `
    const godRowsFast = this.raw.prepare(godSql).all(snapshotId) as Array<{
      canonical_name: string
      method_count: number
      field_count: number
    }>
    for (const g of godRowsFast) {
      const score = g.method_count * 1.5 + g.field_count
      const recommendation =
        g.method_count > 20 && g.field_count > 10
          ? "split_class"
          : g.method_count > 20
            ? "extract_service"
            : "split_data_behavior"
      items.push({
        priority: 2,
        category: "god_class",
        action: recommendation,
        target: g.canonical_name,
        detail: `complexity=${score.toFixed(1)} methods=${g.method_count} fields=${g.field_count}`,
      })
    }

    // Priority 3 — tightly coupled module pairs (> 10 cross-module edges)
    const coupledRows = this.suggestRefactors(snapshotId, 30)
    for (const r of coupledRows) {
      if (Number(r.coupling_count) <= 10) continue
      items.push({
        priority: 3,
        category: "refactor",
        action: "consolidate_or_extract",
        target: `${r.source} ↔ ${r.target}`,
        detail: `${r.coupling_count} cross-module edges`,
      })
    }

    // Priority 4 — unused and hotspot types: single SQL aggregation (fast path)
    const typeHealthSql = `
      SELECT
        n.canonical_name AS canonical_name,
        (SELECT COUNT(*) FROM graph_edges e
         WHERE e.snapshot_id = n.snapshot_id AND e.edge_kind = 'references_type'
           AND e.dst_node_id = n.node_id) AS consumers,
        (SELECT COUNT(*) FROM graph_edges e
         INNER JOIN graph_edges ce ON ce.snapshot_id = n.snapshot_id AND ce.edge_kind = 'contains'
           AND ce.src_node_id = n.node_id AND ce.dst_node_id = e.dst_node_id
         WHERE e.snapshot_id = n.snapshot_id
           AND e.edge_kind IN ('reads_field', 'writes_field')) AS field_touches
      FROM graph_nodes n
      WHERE n.snapshot_id = ?
        AND n.kind IN ('class', 'interface', 'struct', 'typedef', 'enum')
      LIMIT 100
    `
    const typeRowsFast = this.raw.prepare(typeHealthSql).all(snapshotId) as Array<{
      canonical_name: string
      consumers: number
      field_touches: number
    }>
    for (const t of typeRowsFast) {
      const status = t.consumers === 0 ? "unused" : t.field_touches > t.consumers * 5 ? "hotspot" : null
      if (!status) continue
      items.push({
        priority: 4,
        category: "type_health",
        action: status === "unused" ? "remove_or_deprecate" : "review_contention",
        target: t.canonical_name,
        detail: `status=${status} consumers=${t.consumers} touches=${t.field_touches}`,
      })
    }

    // Sort: priority ASC, then by specificity of detail (length proxy)
    items.sort((a, b) => a.priority - b.priority || b.detail.length - a.detail.length)

    return items.slice(0, limit).map((item, idx) => ({
      kind: "action_item",
      canonical_name: item.target,
      rank: idx + 1,
      priority: item.priority,
      category: item.category,
      action: item.action,
      target: item.target,
      detail: item.detail,
    }))
  }

  /**
   * Compare health metrics between two snapshots.
   *
   * `snapshotId` is the current (newer) snapshot; `prevSnapshotId` is the
   * baseline (older) snapshot. The `depth` field in the request is reused as
   * the previous snapshot ID — callers set request.depth = prevSnapshotId.
   *
   * Returns one row per metric with:
   *   metric     name of the measurement
   *   current    value in the current snapshot
   *   previous   value in the previous snapshot (null if no baseline)
   *   delta      current - previous (positive = got worse for counts, better for scores)
   *   trend      'improved' | 'regressed' | 'unchanged' | 'new'
   */
  private compareSnapshots(snapshotId: number, prevSnapshotId: number): Array<Record<string, unknown>> {
    const measure = (sid: number) => {
      const exists = this.raw.prepare(`SELECT COUNT(*) AS n FROM graph_snapshots WHERE snapshot_id = ?`).get(sid) as {
        n: number
      }
      if (exists.n === 0) return null

      const nodes = this.raw
        .prepare(`SELECT kind, COUNT(*) AS n FROM graph_nodes WHERE snapshot_id = ? GROUP BY kind`)
        .all(sid) as Array<{ kind: string; n: number }>
      const nodeMap = Object.fromEntries(nodes.map((r) => [r.kind, r.n]))

      const edges = this.raw
        .prepare(`SELECT edge_kind, COUNT(*) AS n FROM graph_edges WHERE snapshot_id = ? GROUP BY edge_kind`)
        .all(sid) as Array<{ edge_kind: string; n: number }>
      const edgeMap = Object.fromEntries(edges.map((r) => [r.edge_kind, r.n]))

      const deadExports = (
        this.raw
          .prepare(
            `SELECT COUNT(*) AS n FROM graph_nodes n
           WHERE n.snapshot_id = ?
             AND json_extract(n.payload, '$.metadata.exported') = 1
             AND NOT EXISTS (
               SELECT 1 FROM graph_edges e
               WHERE e.snapshot_id = n.snapshot_id
                 AND e.edge_kind IN ('calls', 'references_type', 'imports')
                 AND e.dst_node_id = n.node_id
             )`,
          )
          .get(sid) as { n: number }
      ).n

      const unusedFields = (
        this.raw
          .prepare(
            `SELECT COUNT(*) AS n FROM graph_nodes field
           WHERE field.snapshot_id = ?
             AND field.kind IN ('field', 'enum_variant')
             AND NOT EXISTS (
               SELECT 1 FROM graph_edges access
               WHERE access.snapshot_id = field.snapshot_id
                 AND access.edge_kind IN ('reads_field', 'writes_field')
                 AND access.dst_node_id = field.node_id
             )`,
          )
          .get(sid) as { n: number }
      ).n

      const apiCount = (nodeMap["function"] ?? 0) + (nodeMap["method"] ?? 0)
      const typeCount = (nodeMap["typedef"] ?? 0) + (nodeMap["enum"] ?? 0) + (nodeMap["union"] ?? 0)

      const healthScore =
        100 -
        Math.min(50, (deadExports * 100) / Math.max(1, apiCount)) -
        Math.min(50, (unusedFields * 100) / Math.max(1, typeCount))

      return {
        modules: nodeMap["module"] ?? 0,
        classes: (nodeMap["class"] ?? 0) + (nodeMap["interface"] ?? 0) + (nodeMap["struct"] ?? 0),
        apis: apiCount,
        call_edges: edgeMap["calls"] ?? 0,
        import_edges: edgeMap["imports"] ?? 0,
        dead_exports: deadExports,
        unused_fields: unusedFields,
        health_score: parseFloat(healthScore.toFixed(1)),
      }
    }

    const curr = measure(snapshotId)
    const prev = measure(prevSnapshotId)

    if (!curr) return []

    type MetricRow = {
      metric: string
      current: number
      previous: number | null
      delta: number | null
      trend: "improved" | "regressed" | "unchanged" | "new"
      // higher-is-better for health_score; lower-is-better for everything else
      higher_is_better: boolean
    }

    const makeRow = (metric: string, higherIsBetter: boolean): MetricRow => {
      const cur = curr[metric as keyof typeof curr] as number
      const pre = prev ? (prev[metric as keyof typeof prev] as number) : null
      const delta = pre != null ? parseFloat((cur - pre).toFixed(1)) : null
      let trend: MetricRow["trend"] = "new"
      if (delta != null) {
        if (delta === 0) trend = "unchanged"
        else if (higherIsBetter ? delta > 0 : delta < 0) trend = "improved"
        else trend = "regressed"
      }
      return { metric, current: cur, previous: pre, delta, trend, higher_is_better: higherIsBetter }
    }

    const rows: MetricRow[] = [
      makeRow("health_score", true),
      makeRow("modules", true),
      makeRow("classes", true),
      makeRow("apis", true),
      makeRow("call_edges", true),
      makeRow("import_edges", false),
      makeRow("dead_exports", false),
      makeRow("unused_fields", false),
    ]

    return rows.map((r) => ({
      kind: "snapshot_diff",
      canonical_name: r.metric,
      metric: r.metric,
      current: r.current,
      previous: r.previous,
      delta: r.delta,
      trend: r.trend,
    }))
  }

  /**
   * Module-level diff between two snapshots.
   *
   * For every module that exists in either snapshot, classifies it as:
   *   'added'    — present in current, absent in previous
   *   'removed'  — absent in current, present in previous
   *   'grown'    — present in both, symbol count increased
   *   'shrunk'   — present in both, symbol count decreased
   *   'unchanged'— present in both, same symbol count
   *
   * Each row carries:
   *   canonical_name   module path
   *   change           one of the above
   *   current_symbols  count in current snapshot (null if removed)
   *   prev_symbols     count in previous snapshot (null if added)
   *   delta_symbols    current - previous (null for added/removed)
   *   current_lines    lineCount from payload (current snapshot)
   *   prev_lines       lineCount from payload (previous snapshot)
   *
   * Ordered: added/removed first, then largest symbol delta descending.
   */
  private compareSnapshotsModules(
    snapshotId: number,
    prevSnapshotId: number,
    limit: number,
  ): Array<Record<string, unknown>> {
    type ModRow = { canonical_name: string; symbol_count: number; line_count: number | null }

    const fetchModules = (sid: number): Map<string, ModRow> => {
      const rows = this.raw
        .prepare(
          `SELECT
             m.canonical_name,
             (SELECT COUNT(*) FROM graph_edges e
              WHERE e.snapshot_id = m.snapshot_id AND e.edge_kind = 'contains'
                AND e.src_node_id = m.node_id) AS symbol_count,
             CAST(json_extract(m.payload, '$.metadata.lineCount') AS INTEGER) AS line_count
           FROM graph_nodes m
           WHERE m.snapshot_id = ? AND m.kind = 'module'
           ORDER BY m.canonical_name`,
        )
        .all(sid) as ModRow[]
      return new Map(rows.map((r) => [r.canonical_name, r]))
    }

    const curr = fetchModules(snapshotId)
    const prev = fetchModules(prevSnapshotId)

    const results: Array<Record<string, unknown>> = []
    const allNames = new Set([...curr.keys(), ...prev.keys()])

    for (const name of allNames) {
      const c = curr.get(name)
      const p = prev.get(name)

      if (c && !p) {
        results.push({
          kind: "module_diff",
          canonical_name: name,
          change: "added",
          current_symbols: c.symbol_count,
          prev_symbols: null,
          delta_symbols: null,
          current_lines: c.line_count,
          prev_lines: null,
        })
      } else if (!c && p) {
        results.push({
          kind: "module_diff",
          canonical_name: name,
          change: "removed",
          current_symbols: null,
          prev_symbols: p.symbol_count,
          delta_symbols: null,
          current_lines: null,
          prev_lines: p.line_count,
        })
      } else if (c && p) {
        const delta = c.symbol_count - p.symbol_count
        const change = delta > 0 ? "grown" : delta < 0 ? "shrunk" : "unchanged"
        if (change === "unchanged") continue // omit noise
        results.push({
          kind: "module_diff",
          canonical_name: name,
          change,
          current_symbols: c.symbol_count,
          prev_symbols: p.symbol_count,
          delta_symbols: delta,
          current_lines: c.line_count,
          prev_lines: p.line_count,
        })
      }
    }

    // Sort: added/removed first, then by |delta_symbols| desc
    results.sort((a, b) => {
      const priority = (c: unknown) => (c === "added" ? 0 : c === "removed" ? 1 : 2)
      const pa = priority(a.change)
      const pb = priority(b.change)
      if (pa !== pb) return pa - pb
      return Math.abs(Number(b.delta_symbols ?? 0)) - Math.abs(Number(a.delta_symbols ?? 0))
    })

    return results.slice(0, limit)
  }

  /**
   * Find distinct external (npm/bare) imports with usage counts.
   * Internal imports have a `module:path/with/slashes` form; external
   * imports are bare like `module:react` or `module:effect`. The
   * heuristic: an import dst is external if there's no graph_node
   * row with that canonical_name in the same snapshot — internal
   * modules are always extracted as graph_nodes.
   *
   * Result rows are ordered DESC by usage count so the most-relied-on
   * dependencies appear first. Each row has an `incoming_count` field
   * showing how many imports edges point at the package.
   */
  private externalImports(snapshotId: number, limit: number): Array<Record<string, unknown>> {
    const sql = `
      SELECT
        e.dst_node_id AS dst_id,
        REPLACE(e.dst_node_id,
          'graph_node:' || e.snapshot_id || ':symbol:',
          '') AS canonical_name,
        COUNT(*) AS usage_count
      FROM graph_edges e
      WHERE e.snapshot_id = ?
        AND e.edge_kind = 'imports'
        AND NOT EXISTS (
          SELECT 1 FROM graph_nodes n
          WHERE n.snapshot_id = e.snapshot_id
            AND n.node_id = e.dst_node_id
        )
      GROUP BY e.dst_node_id
      ORDER BY usage_count DESC
      LIMIT ?
    `
    const rows = this.raw.prepare(sql).all(snapshotId, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: "module",
      canonical_name: obj.canonical_name,
      caller: null,
      callee: obj.canonical_name,
      edge_kind: "imports",
      confidence: 1,
      derivation: "clangd",
      file_path: null,
      line_number: null,
      incoming_count: toNumber(obj.usage_count),
    }))
  }

  /**
   * Find functions/methods exceeding a line-count threshold. Uses
   * the metadata.lineCount field set by D25. Visualizers can use
   * this to show "this function is too big" hints or rank symbols
   * by complexity proxy.
   *
   * The threshold comes from request.depth (a slight overload of
   * the depth field for size-based queries — naming a separate
   * minLineCount field would be cleaner but adding fields to
   * QueryRequest each round adds clutter). Default 50 lines.
   */
  private longFunctions(snapshotId: number, minLines: number, limit: number): Array<Record<string, unknown>> {
    const sql = `
      SELECT
        canonical_name,
        kind,
        location,
        json_extract(payload, '$.metadata.lineCount') AS line_count
      FROM graph_nodes
      WHERE snapshot_id = ?
        AND kind IN ('function', 'method')
        AND CAST(json_extract(payload, '$.metadata.lineCount') AS INTEGER) >= ?
      ORDER BY CAST(json_extract(payload, '$.metadata.lineCount') AS INTEGER) DESC
      LIMIT ?
    `
    const rows = this.raw.prepare(sql).all(snapshotId, minLines, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: obj.kind ?? "function",
      canonical_name: obj.canonical_name,
      caller: null,
      callee: obj.canonical_name,
      edge_kind: "contains",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
      line_count: toNumberOrNull(obj.line_count),
    }))
  }

  /**
   * Find the innermost symbol whose source range contains a given
   * file/line. Used by visualizers for click-to-symbol navigation.
   *
   * Range check uses location.line (start) and metadata.endLine (set
   * by D25). The result is ORDER BY (endLine - startLine) ASC so the
   * smallest containing scope wins — a method inside a class returns
   * the method, not the class.
   *
   * Returns up to `limit` rows (usually 1 is enough but allowing more
   * lets the visualizer show all containing scopes if it wants).
   */
  private symbolAtLocation(
    snapshotId: number,
    filePath: string,
    lineNumber: number,
    limit: number,
  ): Array<Record<string, unknown>> {
    if (!filePath || lineNumber <= 0) return []
    const escapedPath = filePath.replace(/%/g, "\\%").replace(/_/g, "\\_")
    const suffixPattern = `%/${escapedPath}`
    const sql = `
      SELECT
        canonical_name,
        kind,
        location,
        json_extract(payload, '$.metadata.endLine') AS end_line,
        json_extract(location, '$.line') AS start_line
      FROM graph_nodes
      WHERE snapshot_id = ?
        AND (json_extract(location, '$.filePath') = ?
             OR json_extract(location, '$.filePath') LIKE ? ESCAPE '\\')
        AND json_extract(location, '$.line') <= ?
        AND COALESCE(json_extract(payload, '$.metadata.endLine'), json_extract(location, '$.line')) >= ?
      ORDER BY
        -- Prefer non-module symbols (narrower scope) over the module itself
        CASE WHEN kind = 'module' THEN 1 ELSE 0 END ASC,
        (COALESCE(json_extract(payload, '$.metadata.endLine'), json_extract(location, '$.line'))
          - json_extract(location, '$.line')) ASC,
        json_extract(location, '$.line') DESC
      LIMIT ?
    `
    const rows = this.raw.prepare(sql).all(snapshotId, filePath, suffixPattern, lineNumber, lineNumber, limit) as Array<
      Record<string, unknown>
    >
    return rows.map((obj) => ({
      kind: obj.kind ?? "function",
      canonical_name: obj.canonical_name,
      caller: null,
      callee: obj.canonical_name,
      edge_kind: "contains",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: toNumberOrNull(obj.start_line),
      end_line: toNumberOrNull(obj.end_line),
    }))
  }

  /**
   * Find the full transitive imports closure of a module — every
   * module reachable via repeated imports edges, with the depth at
   * which it was discovered. Cycle prevention via the running path
   * string. Bounded depth (default 10, clamped to [1, 20]) keeps
   * the query bounded on huge graphs.
   *
   * Returned rows have an extra `transitive_depth` field. The starting
   * module is at depth 0 (not included in results — the visualizer
   * already knows the root). Each unique downstream module appears
   * exactly once at its shortest distance.
   */
  private transitiveDependencies(
    snapshotId: number,
    rootName: string,
    depth: number,
    limit: number,
  ): Array<Record<string, unknown>> {
    if (!rootName) return []
    const maxDepth = Math.min(Math.max(depth, 1), 20)
    const sql = `
      WITH RECURSIVE deps(module_name, depth_n, path) AS (
        SELECT
          dst.canonical_name,
          1,
          ? || ' -> ' || dst.canonical_name
        FROM graph_edges e
        INNER JOIN graph_nodes src
          ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
        INNER JOIN graph_nodes dst
          ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
        WHERE e.snapshot_id = ?
          AND e.edge_kind = 'imports'
          AND src.canonical_name = ?
        UNION ALL
        SELECT
          dst.canonical_name,
          d.depth_n + 1,
          d.path || ' -> ' || dst.canonical_name
        FROM deps d
        INNER JOIN graph_edges e
          ON e.snapshot_id = ?
          AND e.edge_kind = 'imports'
        INNER JOIN graph_nodes src
          ON e.src_node_id = src.node_id
          AND e.snapshot_id = src.snapshot_id
          AND src.canonical_name = d.module_name
        INNER JOIN graph_nodes dst
          ON e.dst_node_id = dst.node_id
          AND e.snapshot_id = dst.snapshot_id
        WHERE d.depth_n < ?
          AND instr(d.path || ' -> ', dst.canonical_name || ' -> ') = 0
      )
      SELECT module_name, MIN(depth_n) AS shortest_depth
      FROM deps
      GROUP BY module_name
      ORDER BY shortest_depth ASC, module_name ASC
      LIMIT ?
    `
    type Row = { module_name: string; shortest_depth: number }
    const rows = this.raw.prepare(sql).all(rootName, snapshotId, rootName, snapshotId, maxDepth, limit) as Row[]
    return rows.map((row) => ({
      kind: row.module_name.includes("#") ? "symbol" : "module",
      canonical_name: row.module_name,
      caller: rootName,
      callee: row.module_name,
      edge_kind: "imports",
      confidence: 1,
      derivation: "clangd",
      file_path: null,
      line_number: null,
      transitive_depth: row.shortest_depth,
    }))
  }

  /**
   * Browse all symbols of a given kind in the snapshot. Used by
   * visualizer kind-filtered views ("show me all classes", "show
   * me all interfaces"). Sorts alphabetically for deterministic
   * pagination.
   */
  private symbolsByKind(snapshotId: number, kind: string, limit: number): Array<Record<string, unknown>> {
    if (!kind || kind.length === 0) return []
    const sql = `
      SELECT
        canonical_name,
        kind,
        location
      FROM graph_nodes
      WHERE snapshot_id = ?
        AND kind = ?
      ORDER BY canonical_name
      LIMIT ?
    `
    const rows = this.raw.prepare(sql).all(snapshotId, kind, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: obj.kind ?? kind,
      canonical_name: obj.canonical_name,
      caller: null,
      callee: obj.canonical_name,
      edge_kind: "contains",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
    }))
  }

  /**
   * Substring search across graph_nodes by canonical_name. Used by
   * visualizer search boxes — returns all symbols whose name
   * contains the given pattern (case-insensitive in SQLite by
   * default for ASCII). Sorts alphabetically for deterministic
   * pagination.
   */
  private symbolsByName(snapshotId: number, pattern: string, limit: number): Array<Record<string, unknown>> {
    if (!pattern || pattern.length === 0) return []
    const sql = `
      SELECT
        canonical_name,
        kind,
        location
      FROM graph_nodes
      WHERE snapshot_id = ?
        AND canonical_name LIKE ? ESCAPE '\\'
      ORDER BY canonical_name
      LIMIT ?
    `
    // Escape any LIKE wildcards in the user pattern so the search is literal.
    // ESCAPE '\\' in the SQL tells SQLite that '\' is the escape character.
    const safe = pattern.replace(/[\\%_]/g, "\\$&")
    const rows = this.raw.prepare(sql).all(snapshotId, `%${safe}%`, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: obj.kind ?? "function",
      canonical_name: obj.canonical_name,
      caller: null,
      callee: obj.canonical_name,
      edge_kind: "contains",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
    }))
  }

  /**
   * Find a shortest call chain from srcApi to dstApi via a bounded
   * BFS over the calls graph. Implementation: SQLite recursive CTE
   * that walks dst.canonical_name forward, joining graph_nodes at
   * each step to filter the destination by name.
   *
   * Returns one row per hop in the chain, ordered by depth, with
   * `caller`, `callee`, `path_index`, and `chain_depth` fields. The
   * visualizer can render this as a vertical call list.
   *
   * Returns an empty list when:
   *   - srcApi or dstApi is empty
   *   - No path exists within the depth bound
   *   - The chain would exceed the depth bound
   */
  private callChain(
    snapshotId: number,
    srcApi: string,
    dstApi: string,
    depth: number,
    limit: number,
  ): Array<Record<string, unknown>> {
    if (!srcApi || !dstApi) return []
    const maxDepth = Math.min(Math.max(depth, 1), 10)
    // The recursive CTE walks forward via calls edges, tracking the
    // path through `prev_canonical` so we can reconstruct the chain
    // at the end. We use canonical_name (not node_id) so the join
    // back to graph_nodes is direct.
    const sql = `
      WITH RECURSIVE chain(caller_name, callee_name, depth_n, path) AS (
        SELECT
          src.canonical_name,
          dst.canonical_name,
          1,
          src.canonical_name || ' -> ' || dst.canonical_name
        FROM graph_edges e
        INNER JOIN graph_nodes src
          ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
        INNER JOIN graph_nodes dst
          ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
        WHERE e.snapshot_id = ?
          AND e.edge_kind = 'calls'
          AND src.canonical_name = ?
        UNION ALL
        SELECT
          c.callee_name,
          dst.canonical_name,
          c.depth_n + 1,
          c.path || ' -> ' || dst.canonical_name
        FROM chain c
        INNER JOIN graph_edges e
          ON e.snapshot_id = ?
          AND e.edge_kind = 'calls'
        INNER JOIN graph_nodes src
          ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
          AND src.canonical_name = c.callee_name
        INNER JOIN graph_nodes dst
          ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
        WHERE c.depth_n < ?
          -- avoid revisiting nodes already in the path (cycle prevention)
          AND instr(c.path || ' -> ', dst.canonical_name || ' -> ') = 0
      )
      SELECT caller_name, callee_name, depth_n, path
      FROM chain
      WHERE callee_name = ?
      ORDER BY depth_n ASC
      LIMIT ?
    `
    type Row = {
      caller_name: string
      callee_name: string
      depth_n: number
      path: string
    }
    const rows = this.raw.prepare(sql).all(snapshotId, srcApi, snapshotId, maxDepth, dstApi, limit) as Row[]
    // Take the shortest chain. Expand its path into per-hop rows.
    if (rows.length === 0) return []
    const shortest = rows[0]
    const segments = shortest.path.split(" -> ")
    return segments.slice(0, -1).map((caller, i) => ({
      kind: "function",
      canonical_name: caller,
      caller,
      callee: segments[i + 1],
      edge_kind: "calls",
      confidence: 1,
      derivation: "clangd",
      file_path: null,
      line_number: null,
      path_index: i,
      chain_depth: shortest.depth_n,
    }))
  }

  /**
   * Phase 3h: data-side analog of callChain. Walks field_of_type
   * AND aggregates edges from srcType to dstType, returning the
   * shortest path expanded into per-hop rows. Answers questions
   * like "how does Vault reach Reference structurally" — useful
   * for understanding type relationships in big codebases without
   * having to manually trace field declarations.
   *
   * Both edge kinds are walked together because they encode the
   * same conceptual relationship at different granularities:
   *   - field_of_type: per-field, with containment metadata
   *   - aggregates:    type-level rollup of field_of_type
   *
   * Walking both lets the BFS hop through either field nodes
   * (granular path) OR straight type-to-type (rolled up). The
   * resulting chain is whatever's shortest in the union graph.
   */
  private dataPath(
    snapshotId: number,
    srcType: string,
    dstType: string,
    depth: number,
    limit: number,
  ): Array<Record<string, unknown>> {
    if (!srcType || !dstType) return []
    const maxDepth = Math.min(Math.max(depth, 1), 10)
    const sql = `
      WITH RECURSIVE chain(src_name, dst_name, depth_n, path) AS (
        SELECT
          src.canonical_name,
          dst.canonical_name,
          1,
          src.canonical_name || ' -> ' || dst.canonical_name
        FROM graph_edges e
        INNER JOIN graph_nodes src
          ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
        INNER JOIN graph_nodes dst
          ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
        WHERE e.snapshot_id = ?
          AND e.edge_kind IN ('field_of_type', 'aggregates')
          AND src.canonical_name = ?
        UNION ALL
        SELECT
          c.dst_name,
          dst.canonical_name,
          c.depth_n + 1,
          c.path || ' -> ' || dst.canonical_name
        FROM chain c
        INNER JOIN graph_edges e
          ON e.snapshot_id = ?
          AND e.edge_kind IN ('field_of_type', 'aggregates')
        INNER JOIN graph_nodes src
          ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
          AND src.canonical_name = c.dst_name
        INNER JOIN graph_nodes dst
          ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
        WHERE c.depth_n < ?
          -- avoid revisiting nodes already in the path (cycle prevention)
          AND instr(c.path || ' -> ', dst.canonical_name || ' -> ') = 0
      )
      SELECT src_name, dst_name, depth_n, path
      FROM chain
      WHERE dst_name = ?
      ORDER BY depth_n ASC
      LIMIT ?
    `
    type Row = {
      src_name: string
      dst_name: string
      depth_n: number
      path: string
    }
    const rows = this.raw.prepare(sql).all(snapshotId, srcType, snapshotId, maxDepth, dstType, limit) as Row[]
    if (rows.length === 0) return []
    const shortest = rows[0]
    const segments = shortest.path.split(" -> ")
    // Hop kind is always "struct" for the response — the BFS only
    // walks edges between *types* (classes/structs/interfaces — every
    // node that carries field_of_type/aggregates edges is one of
    // those), so "struct" is a sensible canonical hop kind that the
    // node-protocol schema accepts. Mirrors how callChain hard-codes
    // kind="function" for its hops.
    return segments.slice(0, -1).map((src, i) => ({
      kind: "struct",
      canonical_name: src,
      src,
      dst: segments[i + 1],
      edge_kind: "data_path",
      confidence: 1,
      derivation: "clangd",
      file_path: null,
      line_number: null,
      path_index: i,
      chain_depth: shortest.depth_n,
    }))
  }

  /**
   * Phase 3i: structural cycles via field_of_type / aggregates edges.
   * The data-side analog of find_type_cycles (which only walks
   * references_type). Catches the "A.b: B and B.a: A" antipattern
   * where two types hold each other as fields — a real code smell
   * the existing find_type_cycles misses because field-typed
   * containment doesn't go through references_type.
   *
   * Implementation: same self-join pattern as find_type_cycles, but
   * walks the union of field_of_type and aggregates edges. Uses
   * aggregates as the canonical edge for cycle detection because
   * it's the de-duplicated rollup — the per-field field_of_type
   * edges would over-report (a single A.b: B and A.c: B pair would
   * look like two cycles instead of one).
   *
   * Both endpoints must be types (struct/class/interface). The
   * canonical_name comparison `a < b` ensures each cycle appears
   * once in the result, not twice.
   *
   * Returns one row per cycle pair with:
   *   - caller / callee = the two types that mutually reference
   *   - edge_kind = "data_cycle" so the visualizer can render with
   *     a distinct overlay
   *   - kind = the canonical kind of the first type (struct/class/etc.)
   */
  private structCycles(snapshotId: number, limit: number): Array<Record<string, unknown>> {
    const sql = `
      SELECT
        a.canonical_name AS caller,
        b.canonical_name AS callee,
        a.canonical_name AS canonical_name,
        a.kind AS kind,
        a.location AS location
      FROM graph_edges e1
      INNER JOIN graph_nodes a
        ON e1.src_node_id = a.node_id AND e1.snapshot_id = a.snapshot_id
      INNER JOIN graph_nodes b
        ON e1.dst_node_id = b.node_id AND e1.snapshot_id = b.snapshot_id
      INNER JOIN graph_edges e2
        ON e2.snapshot_id = e1.snapshot_id
        AND e2.src_node_id = e1.dst_node_id
        AND e2.dst_node_id = e1.src_node_id
      WHERE e1.snapshot_id = ?
        AND e1.edge_kind = 'aggregates'
        AND e2.edge_kind = 'aggregates'
        AND a.kind IN ('struct', 'class', 'interface')
        AND b.kind IN ('struct', 'class', 'interface')
        AND a.canonical_name < b.canonical_name
      LIMIT ?
    `
    const rows = this.raw.prepare(sql).all(snapshotId, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: obj.kind ?? "struct",
      canonical_name: obj.canonical_name,
      caller: obj.caller,
      callee: obj.callee,
      edge_kind: "data_cycle",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
    }))
  }

  /**
   * Phase 3l: transitive data footprint. BFS-walks `calls` edges
   * from a starting API, collects every method reachable within
   * `depth` hops, then unions every reads_field/writes_field edge
   * outgoing from any such method. Answers "what data does login()
   * ultimately touch" — including all the helpers it delegates to,
   * not just the literal field accesses in its own body.
   *
   * Two-phase implementation:
   *   1. Recursive CTE walks calls forward from `apiName`, building
   *      a closed set of reachable method canonical names. Cycle
   *      prevention via instr() on the path string mirrors the
   *      callChain / dataPath helpers.
   *   2. Outer SELECT joins that set against graph_edges with
   *      edge_kind IN ('reads_field', 'writes_field') and returns
   *      one row per unique (api, field, op) tuple — so a method
   *      that reads the same field via three call paths shows up
   *      once.
   *
   * Returns rows with:
   *   - api: the touching method's canonical name (the original
   *     starting api OR any reachable callee)
   *   - canonical_name: the touched field
   *   - kind: "field"
   *   - edge_kind: "reads_field" or "writes_field" — preserved so
   *     the visualizer can render reads/writes with distinct colors
   *   - hop_distance: how many calls hops away the touching method
   *     is from the starting api (0 = api itself)
   */
  private apiDataFootprint(
    snapshotId: number,
    apiName: string,
    depth: number,
    limit: number,
  ): Array<Record<string, unknown>> {
    if (!apiName) return []
    const maxDepth = Math.min(Math.max(depth, 1), 20)
    // Recursive CTE: walk calls forward from apiName, tracking the
    // hop distance from the seed. The starting node is at distance
    // 0 so its own field accesses are picked up by the outer JOIN
    // alongside its callees.
    const sql = `
      WITH RECURSIVE reachable(api_name, hop_distance, path) AS (
        SELECT
          ?,
          0,
          ? || ' -> '
        UNION ALL
        SELECT
          dst.canonical_name,
          r.hop_distance + 1,
          r.path || dst.canonical_name || ' -> '
        FROM reachable r
        INNER JOIN graph_edges e
          ON e.snapshot_id = ?
          AND e.edge_kind = 'calls'
        INNER JOIN graph_nodes src
          ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
          AND src.canonical_name = r.api_name
        INNER JOIN graph_nodes dst
          ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
        WHERE r.hop_distance < ?
          -- avoid revisiting nodes already on this path (cycle prevention)
          AND instr(r.path, dst.canonical_name || ' -> ') = 0
      )
      SELECT DISTINCT
        r.api_name AS api,
        r.hop_distance AS hop_distance,
        field.canonical_name AS canonical_name,
        field.kind AS kind,
        field.location AS location,
        e.edge_kind AS edge_kind
      FROM reachable r
      INNER JOIN graph_nodes touching
        ON touching.canonical_name = r.api_name
        AND touching.snapshot_id = ?
      INNER JOIN graph_edges e
        ON e.src_node_id = touching.node_id
        AND e.snapshot_id = touching.snapshot_id
        AND e.edge_kind IN ('reads_field', 'writes_field')
      INNER JOIN graph_nodes field
        ON e.dst_node_id = field.node_id
        AND e.snapshot_id = field.snapshot_id
      ORDER BY r.hop_distance ASC, e.edge_kind ASC, field.canonical_name ASC
      LIMIT ?
    `
    type Row = {
      api: string
      hop_distance: number
      canonical_name: string
      kind: string
      location: string | null
      edge_kind: string
    }
    const rows = this.raw.prepare(sql).all(apiName, apiName, snapshotId, maxDepth, snapshotId, limit) as Row[]
    return rows.map((row) => ({
      kind: row.kind ?? "field",
      canonical_name: row.canonical_name,
      api: row.api,
      hop_distance: row.hop_distance,
      edge_kind: row.edge_kind,
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(row.location),
      line_number: extractLine(row.location),
    }))
  }

  /**
   * Phase 3m: data-side analog of find_top_called_functions. Ranks
   * types (struct/class/interface) by the number of DISTINCT APIs
   * that read or write any of their fields. This surfaces "the
   * central pieces of state" — User, Session, Config — the types
   * the codebase actually revolves around. Visualizers can use
   * this to populate a "top types" panel symmetric to the
   * existing "top called functions" hub list.
   *
   * Two-step join:
   *   1. Find every (parent type, field) pair via contains edges
   *      where the contained kind is "field".
   *   2. Count DISTINCT touching APIs across all of a parent's
   *      fields by joining against reads_field/writes_field
   *      edges. Each touching API counts once per parent even
   *      when it touches multiple fields of that parent.
   *
   * Returns one row per type ordered by toucher count desc, with:
   *   - canonical_name = the type
   *   - kind = struct / class / interface (preserved)
   *   - toucher_count = the distinct API count
   *   - field_count = how many fields the type has (so the visualizer
   *     can show density: "User has 5 fields touched by 27 APIs")
   */
  private topTouchedTypes(snapshotId: number, limit: number): Array<Record<string, unknown>> {
    const sql = `
      WITH owned_fields AS (
        SELECT
          parent.canonical_name AS parent_name,
          parent.kind AS parent_kind,
          parent.location AS parent_location,
          field.node_id AS field_id
        FROM graph_edges e
        INNER JOIN graph_nodes parent
          ON e.src_node_id = parent.node_id AND e.snapshot_id = parent.snapshot_id
        INNER JOIN graph_nodes field
          ON e.dst_node_id = field.node_id AND e.snapshot_id = field.snapshot_id
        WHERE e.snapshot_id = ?
          AND e.edge_kind = 'contains'
          AND field.kind = 'field'
          AND parent.kind IN ('struct', 'class', 'interface')
      ),
      touchers AS (
        SELECT
          o.parent_name,
          o.parent_kind,
          o.parent_location,
          touching.canonical_name AS toucher
        FROM owned_fields o
        INNER JOIN graph_edges access
          ON access.snapshot_id = ?
          AND access.dst_node_id = o.field_id
          AND access.edge_kind IN ('reads_field', 'writes_field')
        INNER JOIN graph_nodes touching
          ON access.src_node_id = touching.node_id
          AND access.snapshot_id = touching.snapshot_id
      )
      SELECT
        t.parent_name AS canonical_name,
        t.parent_kind AS kind,
        t.parent_location AS location,
        COUNT(DISTINCT t.toucher) AS toucher_count,
        (
          SELECT COUNT(DISTINCT field_id)
          FROM owned_fields
          WHERE parent_name = t.parent_name
        ) AS field_count
      FROM touchers t
      GROUP BY t.parent_name, t.parent_kind, t.parent_location
      ORDER BY toucher_count DESC, t.parent_name ASC
      LIMIT ?
    `
    const rows = this.raw.prepare(sql).all(snapshotId, snapshotId, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: obj.kind ?? "struct",
      canonical_name: obj.canonical_name,
      toucher_count: Number(obj.toucher_count ?? 0),
      field_count: Number(obj.field_count ?? 0),
      // The visualizer's hub-panel renderer reads incoming_count for
      // its existing top-N lists; expose toucher_count under that
      // alias too so the same renderer works without a new code path.
      incoming_count: Number(obj.toucher_count ?? 0),
      edge_kind: "touched_by",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
    }))
  }

  /**
   * Phase 3n: direct mutual recursion at the function/method level.
   * Finds (A, B) pairs where A calls B AND B calls A, the call-side
   * analog of find_import_cycles, find_type_cycles, and
   * find_struct_cycles. Closes the cycle-detection family.
   *
   * Self-recursion (A calls A directly) is excluded — that's a
   * different (intentional) pattern, and `a.canonical_name <
   * b.canonical_name` would skip it anyway. The cycle detector is
   * for the *bug-suspect* shape where two methods bounce off each
   * other.
   *
   * Same self-join shape as find_struct_cycles, but on calls edges
   * with function/method endpoints.
   */
  private callCycles(snapshotId: number, limit: number): Array<Record<string, unknown>> {
    const sql = `
      SELECT
        a.canonical_name AS caller,
        b.canonical_name AS callee,
        a.canonical_name AS canonical_name,
        a.kind AS kind,
        a.location AS location
      FROM graph_edges e1
      INNER JOIN graph_nodes a
        ON e1.src_node_id = a.node_id AND e1.snapshot_id = a.snapshot_id
      INNER JOIN graph_nodes b
        ON e1.dst_node_id = b.node_id AND e1.snapshot_id = b.snapshot_id
      INNER JOIN graph_edges e2
        ON e2.snapshot_id = e1.snapshot_id
        AND e2.src_node_id = e1.dst_node_id
        AND e2.dst_node_id = e1.src_node_id
      WHERE e1.snapshot_id = ?
        AND e1.edge_kind = 'calls'
        AND e2.edge_kind = 'calls'
        AND a.kind IN ('function', 'method')
        AND b.kind IN ('function', 'method')
        AND a.canonical_name < b.canonical_name
      LIMIT ?
    `
    const rows = this.raw.prepare(sql).all(snapshotId, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: obj.kind ?? "function",
      canonical_name: obj.canonical_name,
      caller: obj.caller,
      callee: obj.callee,
      edge_kind: "call_cycle",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
    }))
  }

  /**
   * Phase 3o: top APIs ranked by the number of DISTINCT fields they
   * write or read. The methodological analog of find_top_touched_types
   * — from the API side instead of the data side. Surfaces "the
   * methods doing the most state mutation" (writers) or "the methods
   * reading the most state" (readers).
   *
   * Single helper parameterized by edge_kind so the writers and
   * readers intents share the implementation. The COUNT(DISTINCT
   * dst_node_id) means a method that writes the same field via
   * multiple syntactic paths counts that field once — the result
   * answers "how many distinct fields does this method touch", not
   * "how many access sites does it have".
   *
   * Endpoint must be a function or method (not a class/interface
   * since you can't write a field from a class declaration). The
   * incoming_count alias mirrors find_top_touched_types so the
   * viewer's existing hub-panel renderer works without a new code
   * path.
   */
  private topFieldAccessors(
    snapshotId: number,
    edgeKind: "reads_field" | "writes_field",
    limit: number,
  ): Array<Record<string, unknown>> {
    const sql = `
      SELECT
        api.canonical_name AS canonical_name,
        api.kind AS kind,
        api.location AS location,
        COUNT(DISTINCT e.dst_node_id) AS field_count
      FROM graph_edges e
      INNER JOIN graph_nodes api
        ON e.src_node_id = api.node_id AND e.snapshot_id = api.snapshot_id
      WHERE e.snapshot_id = ?
        AND e.edge_kind = ?
        AND api.kind IN ('function', 'method')
      GROUP BY api.canonical_name, api.kind, api.location
      ORDER BY field_count DESC, api.canonical_name ASC
      LIMIT ?
    `
    const rows = this.raw.prepare(sql).all(snapshotId, edgeKind, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: obj.kind ?? "function",
      canonical_name: obj.canonical_name,
      field_count: Number(obj.field_count ?? 0),
      // Alias for the viewer's hub-panel renderer (see Phase 3m)
      incoming_count: Number(obj.field_count ?? 0),
      edge_kind: edgeKind,
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
    }))
  }

  /**
   * Phase 3p: data-side analog of find_dead_exports. Finds fields
   * with zero incoming reads_field/writes_field edges — "dead
   * state" left over from refactors that removed the only
   * consumer. Common anti-pattern in evolving codebases: the field
   * still exists in the class declaration, but no method touches
   * it anywhere in the snapshot.
   *
   * Returns one row per orphan field with the canonical name,
   * the parent class via the contains edge, and the source
   * location so the visualizer can render a refactor-target list
   * symmetric to the existing dead-export view.
   *
   * Includes the parent class name in the row metadata so callers
   * don't have to make a second query — the most useful "where is
   * this dead field" answer is the class that declares it.
   */
  private unusedFields(snapshotId: number, limit: number): Array<Record<string, unknown>> {
    const sql = `
      SELECT
        f.canonical_name AS canonical_name,
        f.kind AS kind,
        f.location AS location,
        parent.canonical_name AS owning_class
      FROM graph_nodes f
      LEFT JOIN graph_edges contains
        ON contains.snapshot_id = f.snapshot_id
        AND contains.edge_kind = 'contains'
        AND contains.dst_node_id = f.node_id
      LEFT JOIN graph_nodes parent
        ON parent.snapshot_id = contains.snapshot_id
        AND parent.node_id = contains.src_node_id
      WHERE f.snapshot_id = ?
        AND f.kind = 'field'
        AND NOT EXISTS (
          SELECT 1 FROM graph_edges access
          WHERE access.snapshot_id = f.snapshot_id
            AND access.dst_node_id = f.node_id
            AND access.edge_kind IN ('reads_field', 'writes_field')
        )
      ORDER BY f.canonical_name ASC
      LIMIT ?
    `
    const rows = this.raw.prepare(sql).all(snapshotId, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: obj.kind ?? "field",
      canonical_name: obj.canonical_name,
      owning_class: obj.owning_class ?? null,
      edge_kind: "unused_field",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
    }))
  }

  /**
   * Phase 3t: field-level granularity sibling of
   * find_top_touched_types. find_top_touched_types ranks at the
   * type level (Agent has 19 touchers across 10 fields). This
   * intent ranks individual fields by distinct method touchers
   * — finds the read-write hot spots inside a popular type.
   *
   * The "most contended field" answer is useful because the type
   * ranking can hide which specific field is the bottleneck. A
   * type with 19 touchers might have one field touched by 18 of
   * them and the rest touched by just 1 each — the user wants to
   * know which field is the hub before refactoring.
   *
   * Returns rows ordered by toucher_count desc with:
   *   - canonical_name = the field
   *   - kind = "field"
   *   - toucher_count = distinct method count
   *   - read_count + write_count broken out so the user can tell
   *     read-mostly fields apart from write-heavy ones at a glance
   *   - incoming_count = alias for toucher_count so the viewer's
   *     buildHubPanel renderer works without a new code path
   */
  private topHotFields(snapshotId: number, limit: number): Array<Record<string, unknown>> {
    const sql = `
      SELECT
        f.canonical_name AS canonical_name,
        f.kind AS kind,
        f.location AS location,
        COUNT(DISTINCT e.src_node_id) AS toucher_count,
        SUM(CASE WHEN e.edge_kind = 'reads_field' THEN 1 ELSE 0 END) AS read_count,
        SUM(CASE WHEN e.edge_kind = 'writes_field' THEN 1 ELSE 0 END) AS write_count
      FROM graph_edges e
      INNER JOIN graph_nodes f
        ON e.dst_node_id = f.node_id AND e.snapshot_id = f.snapshot_id
      WHERE e.snapshot_id = ?
        AND e.edge_kind IN ('reads_field', 'writes_field')
        AND f.kind = 'field'
      GROUP BY f.canonical_name, f.kind, f.location
      ORDER BY toucher_count DESC, f.canonical_name ASC
      LIMIT ?
    `
    const rows = this.raw.prepare(sql).all(snapshotId, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: obj.kind ?? "field",
      canonical_name: obj.canonical_name,
      toucher_count: Number(obj.toucher_count ?? 0),
      read_count: Number(obj.read_count ?? 0),
      write_count: Number(obj.write_count ?? 0),
      // Alias for the viewer's hub-panel renderer
      incoming_count: Number(obj.toucher_count ?? 0),
      edge_kind: "hot_field",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
    }))
  }

  /**
   * Phase 3v: pairs of fields touched by the same method, ranked
   * by co-occurrence count. Surfaces fields that move together —
   * refactoring candidates for sub-object extraction.
   *
   * The classic refactoring book "Refactoring" calls this "data
   * clumps": groups of fields that always appear together in
   * methods. The fix is usually to extract them into their own
   * type. Examples:
   *   - user.firstName + user.lastName → Name struct
   *   - rect.x + rect.y + rect.w + rect.h → Bounds struct
   *   - http.host + http.port + http.scheme → Origin struct
   *
   * Algorithm: self-join on the same source method touching two
   * different fields. Count distinct (field_a, field_b) tuples
   * with field_a.canonical_name < field_b.canonical_name to
   * de-dupe. Restrict both fields to belong to the SAME parent
   * type — cross-type co-access usually isn't a "data clump"
   * candidate, just a signal that the touching method bridges
   * two types intentionally.
   *
   * Returns rows ranked by co_occurrence (number of methods that
   * touch both fields). The visualizer can present these as
   * "consider extracting these into a sub-object" suggestions.
   */
  private fieldCoAccess(snapshotId: number, limit: number): Array<Record<string, unknown>> {
    const sql = `
      SELECT
        f1.canonical_name AS field_a,
        f2.canonical_name AS field_b,
        f1.location AS location,
        COUNT(DISTINCT a1.src_node_id) AS co_occurrence
      FROM graph_edges a1
      INNER JOIN graph_nodes f1
        ON a1.dst_node_id = f1.node_id AND a1.snapshot_id = f1.snapshot_id
      INNER JOIN graph_edges a2
        ON a2.snapshot_id = a1.snapshot_id
        AND a2.src_node_id = a1.src_node_id
        AND a2.edge_kind IN ('reads_field', 'writes_field')
      INNER JOIN graph_nodes f2
        ON a2.dst_node_id = f2.node_id AND a2.snapshot_id = f2.snapshot_id
      INNER JOIN graph_edges parent_a
        ON parent_a.snapshot_id = f1.snapshot_id
        AND parent_a.dst_node_id = f1.node_id
        AND parent_a.edge_kind = 'contains'
      INNER JOIN graph_edges parent_b
        ON parent_b.snapshot_id = f2.snapshot_id
        AND parent_b.dst_node_id = f2.node_id
        AND parent_b.edge_kind = 'contains'
      WHERE a1.snapshot_id = ?
        AND a1.edge_kind IN ('reads_field', 'writes_field')
        AND f1.kind = 'field'
        AND f2.kind = 'field'
        AND f1.canonical_name < f2.canonical_name
        AND parent_a.src_node_id = parent_b.src_node_id
      GROUP BY f1.canonical_name, f2.canonical_name, f1.location
      HAVING co_occurrence >= 2
      ORDER BY co_occurrence DESC, f1.canonical_name ASC, f2.canonical_name ASC
      LIMIT ?
    `
    const rows = this.raw.prepare(sql).all(snapshotId, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: "field",
      canonical_name: obj.field_a,
      caller: obj.field_a,
      callee: obj.field_b,
      co_occurrence: Number(obj.co_occurrence ?? 0),
      // Alias so the viewer's hub-panel renderer can pick this up
      // under its existing incoming_count contract
      incoming_count: Number(obj.co_occurrence ?? 0),
      edge_kind: "co_access",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
    }))
  }

  /**
   * Phase 3w: methods called by exactly one other method. The
   * inline-or-keep refactor signal. Different from
   * find_dead_exports (zero callers, candidate for deletion) —
   * a function with exactly one caller is often a candidate to
   * inline back into that caller, especially if it's a private
   * helper.
   *
   * The query returns the callee plus the unique caller for
   * convenience: the visualizer can render the row as
   * "callee → only called by caller" without a second query.
   *
   * COUNT(DISTINCT src_node_id) = 1 means exactly one method
   * calls this — not "called once" (a single caller might call
   * it multiple times). The DISTINCT is the important part.
   */
  private uniqueCallers(snapshotId: number, limit: number): Array<Record<string, unknown>> {
    const sql = `
      SELECT
        callee.canonical_name AS canonical_name,
        callee.kind AS kind,
        callee.location AS location,
        MIN(caller.canonical_name) AS unique_caller
      FROM graph_edges e
      INNER JOIN graph_nodes caller
        ON e.src_node_id = caller.node_id AND e.snapshot_id = caller.snapshot_id
      INNER JOIN graph_nodes callee
        ON e.dst_node_id = callee.node_id AND e.snapshot_id = callee.snapshot_id
      WHERE e.snapshot_id = ?
        AND e.edge_kind = 'calls'
        AND callee.kind IN ('function', 'method')
        AND caller.kind IN ('function', 'method')
        -- Exclude pure self-recursion: a function calling itself
        -- isn't an inline candidate, it's a recursive algorithm.
        -- The "exactly one OTHER caller" definition is what makes
        -- this query useful for refactoring.
        AND caller.canonical_name != callee.canonical_name
      GROUP BY callee.canonical_name, callee.kind, callee.location
      HAVING COUNT(DISTINCT e.src_node_id) = 1
      ORDER BY callee.canonical_name ASC
      LIMIT ?
    `
    const rows = this.raw.prepare(sql).all(snapshotId, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: obj.kind ?? "function",
      canonical_name: obj.canonical_name,
      caller: obj.unique_caller,
      callee: obj.canonical_name,
      edge_kind: "single_caller",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
    }))
  }

  /**
   * Phase 3x: direct self-recursion detector. Returns methods that
   * call themselves directly. Different from find_call_cycles
   * (which catches mutual recursion: A→B→A) and from
   * find_unique_callers (which intentionally excludes self-calls
   * to avoid false-positive inline candidates).
   *
   * This is the simplest possible recursion shape — a method M
   * with at least one calls edge whose src and dst are both M.
   * Useful for spotting recursive algorithms in the codebase
   * (parsers, tree walks, traversal routines, refresh loops).
   *
   * Returns rows ordered by canonical_name for deterministic
   * output. Each row carries the canonical name of the recursive
   * method and the edge_kind set to "self_recursion" so the
   * visualizer can render it with a distinct overlay.
   */
  private recursiveMethods(snapshotId: number, limit: number): Array<Record<string, unknown>> {
    const sql = `
      SELECT DISTINCT
        m.canonical_name AS canonical_name,
        m.kind AS kind,
        m.location AS location
      FROM graph_edges e
      INNER JOIN graph_nodes m
        ON e.src_node_id = m.node_id AND e.snapshot_id = m.snapshot_id
      WHERE e.snapshot_id = ?
        AND e.edge_kind = 'calls'
        AND e.src_node_id = e.dst_node_id
        AND m.kind IN ('function', 'method')
      ORDER BY m.canonical_name ASC
      LIMIT ?
    `
    const rows = this.raw.prepare(sql).all(snapshotId, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: obj.kind ?? "function",
      canonical_name: obj.canonical_name,
      caller: obj.canonical_name,
      callee: obj.canonical_name,
      edge_kind: "self_recursion",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
    }))
  }

  /**
   * Phase 3y: combined-complexity god-method detector. Ranks
   * methods by fan-in (callers) + fan-out (callees) + distinct
   * field touches, summed into a single complexity score.
   *
   * Why combined ranking matters: each existing single-axis
   * ranking misses a different shape of god method:
   *   - find_top_called_functions catches utility hubs with
   *     many incoming callers but ignores what they do
   *   - find_top_field_writers/readers catches state mutators
   *     but ignores how many callers depend on them
   *   - find_classes_by_method_count is class-level, not method
   *
   * The combined score surfaces methods that score moderately
   * on every dimension — the "this method does everything"
   * shape that's the worst code-smell of all because it has no
   * single dimension to refactor along.
   *
   * Score components are added with equal weight (no scaling)
   * because empirically the three counts have similar ranges
   * in real codebases. The user can sort by any individual
   * component using the existing intents if they want a
   * different lens.
   */
  private godMethods(snapshotId: number, limit: number): Array<Record<string, unknown>> {
    // Three CTEs aggregate the per-method counts independently with
    // GROUP BY on the relevant edge column. The outer query LEFT
    // JOINs them to recover (canonical_name, kind, location). This
    // avoids the per-row correlated subquery shape that SQLite's
    // planner can't optimize on big snapshots — the original draft
    // hung indefinitely on a ~2000-file workspace. Each CTE is a single
    // index-friendly scan, and the LEFT JOINs are keyed by node_id
    // so the planner can hash-join cleanly.
    const sql = `
      WITH fan_in_counts AS (
        SELECT
          dst_node_id AS node_id,
          COUNT(DISTINCT src_node_id) AS n
        FROM graph_edges
        WHERE snapshot_id = ?
          AND edge_kind = 'calls'
        GROUP BY dst_node_id
      ),
      fan_out_counts AS (
        SELECT
          src_node_id AS node_id,
          COUNT(DISTINCT dst_node_id) AS n
        FROM graph_edges
        WHERE snapshot_id = ?
          AND edge_kind = 'calls'
        GROUP BY src_node_id
      ),
      field_touch_counts AS (
        SELECT
          src_node_id AS node_id,
          COUNT(DISTINCT dst_node_id) AS n
        FROM graph_edges
        WHERE snapshot_id = ?
          AND edge_kind IN ('reads_field', 'writes_field')
        GROUP BY src_node_id
      )
      SELECT
        m.canonical_name AS canonical_name,
        m.kind AS kind,
        m.location AS location,
        COALESCE(fi.n, 0) AS fan_in,
        COALESCE(fo.n, 0) AS fan_out,
        COALESCE(ft.n, 0) AS field_touches,
        (COALESCE(fi.n, 0) + COALESCE(fo.n, 0) + COALESCE(ft.n, 0)) AS complexity_score
      FROM graph_nodes m
      LEFT JOIN fan_in_counts fi ON fi.node_id = m.node_id
      LEFT JOIN fan_out_counts fo ON fo.node_id = m.node_id
      LEFT JOIN field_touch_counts ft ON ft.node_id = m.node_id
      WHERE m.snapshot_id = ?
        AND m.kind IN ('function', 'method')
        AND (COALESCE(fi.n, 0) + COALESCE(fo.n, 0) + COALESCE(ft.n, 0)) > 0
      ORDER BY complexity_score DESC, m.canonical_name ASC
      LIMIT ?
    `
    const rows = this.raw.prepare(sql).all(snapshotId, snapshotId, snapshotId, snapshotId, limit) as Array<
      Record<string, unknown>
    >
    return rows.map((obj) => ({
      kind: obj.kind ?? "function",
      canonical_name: obj.canonical_name,
      fan_in: Number(obj.fan_in ?? 0),
      fan_out: Number(obj.fan_out ?? 0),
      field_touches: Number(obj.field_touches ?? 0),
      complexity_score: Number(obj.complexity_score ?? 0),
      // Alias for the viewer's hub-panel renderer
      incoming_count: Number(obj.complexity_score ?? 0),
      edge_kind: "god_method",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
    }))
  }

  /**
   * Find exported symbols (functions/classes/interfaces) with zero
   * incoming calls AND zero incoming references_type. Likely dead
   * public API: declared in an `export ...` statement but nobody
   * actually uses them. Visualizers can surface these as refactor
   * targets.
   *
   * Filters:
   *   - kind IN (function, class, interface, method)
   *   - payload.metadata.exported = true (set by D26)
   *   - NOT EXISTS incoming calls edges
   *   - NOT EXISTS incoming references_type edges
   *
   * Methods inside an exported class don't carry exported=true (the
   * class does), so this query finds exported top-level functions,
   * classes, and interfaces specifically.
   */
  private deadExports(snapshotId: number, limit: number): Array<Record<string, unknown>> {
    const sql = `
      SELECT
        n.canonical_name AS canonical_name,
        n.kind AS kind,
        n.location AS location
      FROM graph_nodes n
      WHERE n.snapshot_id = ?
        AND n.kind IN ('function', 'class', 'interface')
        AND json_extract(n.payload, '$.metadata.exported') = 1
        AND NOT EXISTS (
          SELECT 1 FROM graph_edges e
          WHERE e.snapshot_id = n.snapshot_id
            AND e.edge_kind IN ('calls', 'references_type', 'extends', 'implements', 'imports')
            AND e.dst_node_id = n.node_id
        )
      ORDER BY n.canonical_name
      LIMIT ?
    `
    const rows = this.raw.prepare(sql).all(snapshotId, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: obj.kind ?? "function",
      canonical_name: obj.canonical_name,
      caller: null,
      callee: obj.canonical_name,
      edge_kind: "contains",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
    }))
  }

  /**
   * Find modules with zero incoming imports — likely entry points
   * (CLI files, test files, scripts, top-level pages). The query
   * returns module nodes that don't appear as the dst of any imports
   * edge. Visualizers can use this to root the dependency tree or
   * highlight scripts that are only invoked externally.
   */
  private moduleEntryPoints(snapshotId: number, limit: number): Array<Record<string, unknown>> {
    const sql = `
      SELECT
        m.canonical_name AS canonical_name,
        m.kind AS kind,
        m.location AS location
      FROM graph_nodes m
      WHERE m.snapshot_id = ? AND m.kind = 'module'
        AND NOT EXISTS (
          SELECT 1 FROM graph_edges e
          INNER JOIN graph_nodes dst
            ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
          WHERE e.snapshot_id = m.snapshot_id
            AND e.edge_kind = 'imports'
            AND dst.canonical_name = m.canonical_name
        )
      ORDER BY m.canonical_name
      LIMIT ?
    `
    const rows = this.raw.prepare(sql).all(snapshotId, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: "module",
      canonical_name: obj.canonical_name,
      caller: null,
      callee: obj.canonical_name,
      edge_kind: "imports",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
    }))
  }

  /**
   * Find the top-N nodes ranked by their incoming-edge count for a
   * given edge_kind. Useful for "hot spots" / hubs / most-X views in
   * visualizers. Optionally filters the dst node kind (e.g. only
   * count incoming edges to modules, or only to functions).
   *
   * Result rows include `incoming_count` so the visualizer can
   * render the in-degree alongside the symbol.
   */
  private topByIncoming(
    snapshotId: number,
    edgeKind: string,
    dstKind: string | null,
    limit: number,
  ): Array<Record<string, unknown>> {
    const kindFilter = dstKind ? "AND dst.kind = ?" : ""
    const sql = `
      SELECT
        dst.canonical_name AS canonical_name,
        dst.kind AS kind,
        dst.location AS location,
        COUNT(*) AS incoming_count
      FROM graph_edges e
      INNER JOIN graph_nodes dst
        ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
      WHERE e.snapshot_id = ?
        AND e.edge_kind = ?
        ${kindFilter}
      GROUP BY dst.canonical_name, dst.kind, dst.location
      ORDER BY incoming_count DESC
      LIMIT ?
    `
    const params: Array<string | number> = [snapshotId, edgeKind]
    if (dstKind) params.push(dstKind)
    params.push(limit)
    const rows = this.raw.prepare(sql).all(...params) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: obj.kind ?? "module",
      canonical_name: obj.canonical_name,
      caller: null,
      callee: obj.canonical_name,
      edge_kind: edgeKind,
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
      incoming_count: toNumber(obj.incoming_count),
    }))
  }

  /**
   * Find pairs of modules that mutually import each other (2-cycles
   * in the imports graph). Detected via a self-join: edge1 (A→B)
   * matched against edge2 (B→A) on the same snapshot. The
   * canonical_name comparison filters duplicates so each cycle
   * appears once as (a, b) with a < b alphabetically.
   *
   * Doesn't take an apiName — returns all cycles in the snapshot.
   * Visualizers can render these as bidirectional edges or refactor
   * suggestions.
   */
  private importCycles(snapshotId: number, limit: number): Array<Record<string, unknown>> {
    const sql = `
      SELECT
        a.canonical_name AS caller,
        b.canonical_name AS callee,
        a.canonical_name AS canonical_name,
        'module' AS kind,
        'imports' AS edge_kind,
        1.0 AS confidence,
        'clangd' AS derivation,
        a.location AS location
      FROM graph_edges e1
      INNER JOIN graph_nodes a
        ON e1.src_node_id = a.node_id AND e1.snapshot_id = a.snapshot_id
      INNER JOIN graph_nodes b
        ON e1.dst_node_id = b.node_id AND e1.snapshot_id = b.snapshot_id
      INNER JOIN graph_edges e2
        ON e2.snapshot_id = e1.snapshot_id
        AND e2.src_node_id = e1.dst_node_id
        AND e2.dst_node_id = e1.src_node_id
      WHERE e1.snapshot_id = ?
        AND e1.edge_kind = 'imports'
        AND e2.edge_kind = 'imports'
        AND a.kind = 'module' AND b.kind = 'module'
        AND a.canonical_name < b.canonical_name
      LIMIT ?
    `
    const rows = this.raw.prepare(sql).all(snapshotId, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: "module",
      canonical_name: obj.canonical_name,
      caller: obj.caller,
      callee: obj.callee,
      edge_kind: "imports",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
    }))
  }

  private outgoingByEdgeKind(
    snapshotId: number,
    srcNames: string[],
    edgeKind: string,
    limit: number,
  ): Array<Record<string, unknown>> {
    if (srcNames.length === 0) return []
    const sql = `
      SELECT
        src.canonical_name AS caller,
        dst.canonical_name AS callee,
        dst.canonical_name AS canonical_name,
        dst.kind           AS kind,
        e.edge_kind        AS edge_kind,
        e.confidence       AS confidence,
        e.derivation       AS derivation,
        dst.location       AS location
      FROM graph_edges e
      INNER JOIN graph_nodes src
        ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
      INNER JOIN graph_nodes dst
        ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
      WHERE e.snapshot_id = ?
        AND src.canonical_name IN (${expandIn(srcNames)})
        AND e.edge_kind = ?
      LIMIT ?
    `
    const rows = this.raw.prepare(sql).all(snapshotId, ...srcNames, edgeKind, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: obj.kind ?? "module",
      canonical_name: obj.canonical_name ?? obj.callee,
      caller: obj.caller,
      callee: obj.callee,
      edge_kind: obj.edge_kind,
      confidence: toNumber(obj.confidence),
      derivation: obj.derivation,
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
    }))
  }

  private incomingByEdgeKind(
    snapshotId: number,
    dstNames: string[],
    edgeKind: string,
    limit: number,
  ): Array<Record<string, unknown>> {
    if (dstNames.length === 0) return []
    const sql = `
      SELECT
        src.canonical_name AS caller,
        dst.canonical_name AS callee,
        src.canonical_name AS canonical_name,
        src.kind           AS kind,
        e.edge_kind        AS edge_kind,
        e.confidence       AS confidence,
        e.derivation       AS derivation,
        src.location       AS location
      FROM graph_edges e
      INNER JOIN graph_nodes src
        ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
      INNER JOIN graph_nodes dst
        ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
      WHERE e.snapshot_id = ?
        AND dst.canonical_name IN (${expandIn(dstNames)})
        AND e.edge_kind = ?
      LIMIT ?
    `
    const rows = this.raw.prepare(sql).all(snapshotId, ...dstNames, edgeKind, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: obj.kind ?? "module",
      canonical_name: obj.canonical_name ?? obj.caller,
      caller: obj.caller,
      callee: obj.callee,
      edge_kind: obj.edge_kind,
      confidence: toNumber(obj.confidence),
      derivation: obj.derivation,
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
    }))
  }

  /**
   * Phase 3e: list the field nodes directly contained by a struct,
   * class, interface, or enum. Same as outgoingByEdgeKind on
   * "contains" but filtered to dst.kind IN ('field', 'enum_variant')
   * so the result is JUST the data members — methods on a class
   * are excluded.
   *
   * The query semantics: "show me what data this type holds, not
   * what behavior it exposes". Pairs naturally with the existing
   * find_module_symbols (which lists ALL contains-edge children
   * regardless of kind).
   */
  private containedFields(snapshotId: number, srcNames: string[], limit: number): Array<Record<string, unknown>> {
    if (srcNames.length === 0) return []
    const sql = `
      SELECT
        src.canonical_name AS caller,
        dst.canonical_name AS callee,
        dst.canonical_name AS canonical_name,
        dst.kind           AS kind,
        e.edge_kind        AS edge_kind,
        e.confidence       AS confidence,
        e.derivation       AS derivation,
        dst.location       AS location,
        dst.payload        AS payload
      FROM graph_edges e
      INNER JOIN graph_nodes src
        ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
      INNER JOIN graph_nodes dst
        ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
      WHERE e.snapshot_id = ?
        AND src.canonical_name IN (${expandIn(srcNames)})
        AND e.edge_kind = 'contains'
        AND dst.kind IN ('field', 'enum_variant')
      LIMIT ?
    `
    const rows = this.raw.prepare(sql).all(snapshotId, ...srcNames, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: obj.kind ?? "field",
      canonical_name: obj.canonical_name ?? obj.callee,
      caller: obj.caller,
      callee: obj.callee,
      edge_kind: obj.edge_kind,
      confidence: toNumber(obj.confidence),
      derivation: obj.derivation,
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
    }))
  }
}
