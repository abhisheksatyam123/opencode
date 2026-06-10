/**
 * runtime-verbose.ts — OPTIONAL frontend-facing row expansion.
 *
 * ## Status
 *
 * These functions used to live in `src/intelligence/orchestrator-runner.ts`
 * and were applied to every `intelligence_query` response by default.
 * That was a leak: backend response shape was being driven by one
 * specific frontend's vocabulary preferences (e.g.
 * `runtime_caller_api_name` instead of the canonical short `caller`
 * field).
 *
 * The backend now emits canonical short-name rows. This module is
 * retained for any consumer that wants the long-form verbose
 * vocabulary — but consumers must opt in by importing + calling the
 * expansion themselves. It is **not** invoked by the orchestrator.
 *
 * ## Wire contract change (2026-04-24)
 *
 * `NormalizedQueryResponse.data.nodes` previously contained verbose
 * fields like `runtime_caller_api_name` for the
 * `who_calls_api_at_runtime` intent. It now contains the raw DB row
 * shape (`caller`, `callee`, `edge_kind`, `derivation`, ...).
 *
 * Consumers that relied on the verbose names should either migrate to
 * short names (recommended) or import `expandRuntimeCallerRows` etc.
 * from this module and apply the expansion themselves.
 */

import { RuntimeInvocationType } from "../../intelligence/contracts/orchestrator.js"
import type { QueryRequest } from "../../intelligence/contracts/orchestrator.js"

/**
 * Intents that used to trigger verbose expansion by default. Kept here
 * so a frontend adapter can decide on its own whether to expand.
 */
export const RUNTIME_ONLY_INTENTS = new Set<QueryRequest["intent"]>([
  "who_calls_api_at_runtime",
  "why_api_invoked",
  "show_runtime_flow_for_trace",
  "show_api_runtime_observations",
  "find_api_timer_triggers",
])

export const LEGACY_STRUCTURE_COMPAT_INTENTS = new Set<QueryRequest["intent"]>([
  "find_struct_writers",
  "find_struct_readers",
  "where_struct_initialized",
  "where_struct_modified",
  "find_struct_owners",
])

function pick(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k]
  }
  return out
}

export function classifyRuntimeInvocationType(edgeKind: string): string {
  switch (edgeKind) {
    case "calls":
      return RuntimeInvocationType.RUNTIME_DIRECT_CALL
    case "registers_callback":
      return RuntimeInvocationType.RUNTIME_CALLBACK_REGISTRATION_CALL
    case "runtime_calls":
      return RuntimeInvocationType.RUNTIME_FUNCTION_POINTER_CALL
    case "dispatches_to":
      return RuntimeInvocationType.RUNTIME_DISPATCH_TABLE_CALL
    default:
      return RuntimeInvocationType.RUNTIME_UNKNOWN_CALL_PATH
  }
}

export function expandRuntimeCallerRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const runtimeOnlyRows = rows.map((r) =>
    pick(r, [
      "kind",
      "canonical_name",
      "caller",
      "callee",
      "edge_kind",
      "confidence",
      "derivation",
      "file_path",
      "line_number",
      "filePath",
      "lineNumber",
    ]),
  )
  return runtimeOnlyRows.map((row) => ({
    kind: row.kind,
    canonical_name: row.canonical_name ?? row.caller,
    caller: row.caller,
    callee: row.callee,
    edge_kind: row.edge_kind,
    derivation: row.derivation,
    confidence: row.confidence,
    runtime_caller_api_name: row.caller,
    runtime_called_api_name: row.callee,
    runtime_caller_invocation_type_classification: classifyRuntimeInvocationType(String(row.edge_kind ?? "")),
    runtime_relation_confidence_score: row.confidence,
    runtime_relation_derivation_source: row.derivation,
    file_path: row.file_path,
    line_number: row.line_number,
  }))
}

export function expandRuntimeObservationRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const runtimeObservationRows = rows.map((r) =>
    pick(r, [
      "kind",
      "canonical_name",
      "target_api",
      "runtime_trigger",
      "dispatch_chain",
      "immediate_invoker",
      "dispatch_site",
      "edge_kind",
      "derivation",
      "confidence",
      "file_path",
      "line_number",
      "filePath",
      "lineNumber",
    ]),
  )
  return runtimeObservationRows.map((row) => ({
    kind: row.kind,
    canonical_name: row.canonical_name ?? row.immediate_invoker ?? row.target_api,
    caller: row.immediate_invoker,
    callee: row.target_api,
    edge_kind: row.edge_kind ?? "runtime_calls",
    derivation: row.derivation ?? "runtime",
    confidence: row.confidence,
    target_api_name: row.target_api,
    runtime_trigger_event_description: row.runtime_trigger,
    runtime_execution_path_from_entrypoint_to_target_api: row.dispatch_chain,
    runtime_immediate_caller_api_name: row.immediate_invoker,
    runtime_dispatch_source_location: row.dispatch_site,
    runtime_confidence_score: row.confidence,
    file_path: row.file_path ?? (row.dispatch_site as Record<string, unknown> | undefined)?.filePath,
    line_number: row.line_number ?? (row.dispatch_site as Record<string, unknown> | undefined)?.line,
  }))
}

export function expandTimerTriggerRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map((row) => ({
    kind: row.kind ?? "timer",
    canonical_name: row.canonical_name ?? row.timer_identifier_name ?? row.caller,
    caller: row.caller ?? row.timer_identifier_name ?? row.canonical_name,
    callee: row.callee,
    edge_kind: row.edge_kind ?? "runtime_calls",
    confidence: row.timer_trigger_confidence_score ?? row.confidence,
    derivation: row.derivation,
    file_path: row.file_path,
    line_number: row.line_number,
    current_api_runtime_timer_identifier_name: row.timer_identifier_name ?? row.caller ?? row.canonical_name,
    current_api_runtime_timer_trigger_condition_description: row.timer_trigger_condition_description,
    current_api_runtime_timer_trigger_confidence_score: row.timer_trigger_confidence_score ?? row.confidence,
    current_api_runtime_timer_relation_derivation_source: row.derivation,
  }))
}

function extractStructureEvidenceFields(row: Record<string, unknown>): Record<string, unknown> {
  const evidence = row.runtime_structure_evidence
  if (!evidence || typeof evidence !== "object") return {}
  const ev = evidence as Record<string, unknown>
  const out: Record<string, unknown> = {}
  if (ev.access_path) {
    out.current_api_runtime_structure_access_path_expression = ev.access_path
  }
  if (ev.source_location) {
    out.current_api_runtime_structure_access_source_evidence_location = ev.source_location
  } else if (ev.file_path && ev.line !== undefined) {
    out.current_api_runtime_structure_access_source_evidence_location = `${ev.file_path}:${ev.line}`
  }
  return out
}

export function expandLegacyStructureRows(
  intent: QueryRequest["intent"],
  rows: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const roleKeyByIntent: Record<string, string> = {
    find_struct_writers: "writer",
    where_struct_modified: "writer",
    find_struct_readers: "reader",
    where_struct_initialized: "initializer",
    find_struct_owners: "owner",
  }

  const roleFieldByIntent: Record<string, string> = {
    find_struct_writers: "current_structure_runtime_writer_api_name",
    where_struct_modified: "current_structure_runtime_writer_api_name",
    find_struct_readers: "current_structure_runtime_reader_api_name",
    where_struct_initialized: "current_structure_runtime_initializer_api_name",
    find_struct_owners: "current_structure_runtime_owner_api_name",
  }

  const roleKey = roleKeyByIntent[intent]
  const roleField = roleFieldByIntent[intent]

  return rows.map((row) => ({
    [roleField]: row[roleKey],
    current_structure_runtime_target_structure_name: row.target ?? row.struct_name,
    current_structure_runtime_structure_operation_type_classification: row.edge_kind,
    current_structure_runtime_structure_operation_confidence_score: row.confidence,
    current_structure_runtime_relation_derivation_source: row.derivation,
    ...extractStructureEvidenceFields(row),
  }))
}

/**
 * Unified entry point. Given an intent and raw canonical rows, apply
 * the appropriate expansion. Intents outside the runtime/legacy sets
 * pass through unchanged.
 *
 * Consumers that prefer canonical short-name fields should not call
 * this at all.
 */
export function expandRowsForIntent(
  intent: QueryRequest["intent"],
  rows: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  if (LEGACY_STRUCTURE_COMPAT_INTENTS.has(intent)) {
    return expandLegacyStructureRows(intent, rows)
  }
  if (!RUNTIME_ONLY_INTENTS.has(intent)) return rows
  if (intent === "who_calls_api_at_runtime") {
    return expandRuntimeCallerRows(rows)
  }
  if (intent === "find_api_timer_triggers") {
    return expandTimerTriggerRows(rows)
  }
  return expandRuntimeObservationRows(rows)
}
