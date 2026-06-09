/**
 * Fixture-vs-backend comparator.
 *
 * Compares a fixture (source of truth) against a backend response at
 * (entity, intent, bucket, field) granularity and emits classified diff rows.
 *
 * Uses classifyDiffRow from comparator-classifier.ts for deterministic
 * mismatch_type/severity/rule_id assignment.
 */

import { classifyDiffRow, ciOutcome as computeCiOutcome } from "./comparator-classifier"
import type { DiffRow, CiOutcome } from "./comparator-classifier"
import { mapIntentToArray } from "./intent-mapper"
import type { ApiFixture, Relation } from "./intent-mapper"
import type { QueryIntent } from "../intelligence/contracts/orchestrator"

export type { DiffRow, CiOutcome }

export type ComparisonResult = {
  entity: string
  intent: string
  bucket: string
  diffs: DiffRow[]
  ci_outcome: CiOutcome
  summary: {
    total_diffs: number
    fail_count: number
    warn_count: number
    pass_count: number
  }
}

export type ComparatorReport = {
  run_id: string
  fixture_count: number
  entity_results: ComparisonResult[]
  aggregate: {
    total_entities: number
    fail_entities: number
    warn_entities: number
    pass_entities: number
    ci_outcome: CiOutcome
  }
}

/**
 * Backend response item shape (minimal — only fields we compare against).
 */
export type BackendItem = {
  canonical_name?: string
  kind?: string
  kind_verbose?: string
  loc?: { file?: string; line?: number }
  rel?: Record<string, unknown[]>
  [key: string]: unknown
}

export type BackendResponse = {
  status?: string
  data?: { items?: BackendItem[] }
  [key: string]: unknown
}

/**
 * Derive a stable run_id from a sorted list of entity names.
 * Deterministic: same inputs → same run_id.
 */
export function deriveRunId(entityNames: string[]): string {
  const sorted = [...entityNames].sort().join(",")
  // Simple deterministic hash: djb2-style
  let h = 5381
  for (let i = 0; i < sorted.length; i++) {
    h = ((h << 5) + h) ^ sorted.charCodeAt(i)
    h = h >>> 0 // keep 32-bit unsigned
  }
  return `run-${h.toString(16).padStart(8, "0")}`
}

/**
 * Classify a single diff using the taxonomy rules.
 * Determines mismatch_type from field name heuristics, then delegates to classifyDiffRow.
 */
function classifyField(
  field: string,
  expected: unknown,
  actual: unknown,
  isFirst: boolean,
): DiffRow {
  const mismatch_type =
    isFirst && field === "status"
      ? "consistency"
      : field === "data.items.length"
        ? "missing"
        : field === "kind" || field === "kind_verbose"
          ? "source_mismatch"
          : field === "canonical_name"
            ? "unresolved_alias"
            : field.startsWith("rel.") && field.includes("minimum_count")
              ? "evidence_weak"
              : field.startsWith("rel.")
                ? "extra"
                : "source_mismatch"

  const classified = classifyDiffRow({ field, mismatch_type })
  return { field, expected, actual, ...classified }
}

/**
 * Compute worst CI outcome across a list of diff rows.
 */
function worstOutcome(diffs: DiffRow[]): CiOutcome {
  if (diffs.some((d) => computeCiOutcome(d.severity) === "fail")) return "fail"
  if (diffs.some((d) => computeCiOutcome(d.severity) === "warn")) return "warn"
  return "pass"
}

/**
 * Build a ComparisonResult summary from a list of diffs.
 */
function buildSummary(diffs: DiffRow[]): ComparisonResult["summary"] {
  return {
    total_diffs: diffs.length,
    fail_count: diffs.filter((d) => computeCiOutcome(d.severity) === "fail").length,
    warn_count: diffs.filter((d) => computeCiOutcome(d.severity) === "warn").length,
    pass_count: diffs.filter((d) => computeCiOutcome(d.severity) === "pass").length,
  }
}

/**
 * Compare a single fixture entity against a backend response for a given intent.
 *
 * Algorithm:
 * 1. Check response status (must be "hit" or "enriched")
 * 2. Check response has items
 * 3. For the relevant bucket (per intent), check fixture relations are present in backend
 * 4. Check backend items don't have extra relations not in fixture
 * 5. Classify each diff using classifyDiffRow
 */
export function compareEntityToBackend(
  fixture: ApiFixture,
  backendResponse: BackendResponse,
  intent: string,
): ComparisonResult {
  const bucket = mapIntentToArray(intent as QueryIntent)
  const diffs: DiffRow[] = []

  // 1. Status check
  const status = backendResponse.status
  if (status !== "hit" && status !== "enriched") {
    diffs.push(classifyField("status", "hit|enriched", status, true))
  }

  // 2. Items presence check
  const items = backendResponse.data?.items ?? []
  if (items.length === 0) {
    diffs.push(classifyField("data.items.length", ">0", 0, diffs.length === 0))
    return {
      entity: fixture.canonical_name,
      intent,
      bucket,
      diffs,
      ci_outcome: worstOutcome(diffs),
      summary: buildSummary(diffs),
    }
  }

  // 3. Fixture relations for this bucket
  const fixtureRelations: Relation[] = (fixture.relations as unknown as Record<string, Relation[]>)[bucket] ?? []

  // Build a set of fixture relation keys for presence checking
  const fixtureKeys = new Set(
    fixtureRelations.map((r) => relationKey(r)),
  )

  // Collect all backend relations from this bucket across all items
  const backendRelations: unknown[] = []
  for (const item of items) {
    const bucketRels = item.rel?.[bucket] ?? []
    backendRelations.push(...bucketRels)
  }

  // 4. Check fixture relations are present in backend (missing check)
  for (const rel of fixtureRelations) {
    const key = relationKey(rel)
    const found = backendRelations.some((br) => relationKey(br as Relation) === key)
    if (!found) {
      diffs.push(classifyField(`rel.${bucket}`, key, null, diffs.length === 0))
    }
  }

  // 5. Check backend relations not in fixture (extra check)
  const backendKeys = new Set(backendRelations.map((br) => relationKey(br as Relation)))
  for (const key of backendKeys) {
    if (!fixtureKeys.has(key)) {
      diffs.push(classifyField(`rel.${bucket}`, null, key, diffs.length === 0))
    }
  }

  // 6. Check minimum_counts from contract
  const contract = fixture.contract
  if (contract) {
    const minCount = contract.minimum_counts[bucket]
    if (minCount !== undefined && fixtureRelations.length > 0) {
      const totalCount = items.reduce((sum, item) => {
        return sum + (item.rel?.[bucket]?.length ?? 0)
      }, 0)
      if (totalCount < minCount) {
        diffs.push(
          classifyField(
            `rel.${bucket} (minimum_count)`,
            `>=${minCount}`,
            totalCount,
            diffs.length === 0,
          ),
        )
      }
    }
  }

  return {
    entity: fixture.canonical_name,
    intent,
    bucket,
    diffs,
    ci_outcome: worstOutcome(diffs),
    summary: buildSummary(diffs),
  }
}

/**
 * Build a stable relation key for deduplication/comparison.
 * Uses (caller||api, callee||struct||callback, edge_kind) tuple.
 */
function relationKey(r: Relation): string {
  const src = r.caller ?? r.api ?? r.registrar ?? r.api_name ?? ""
  const dst = r.callee ?? r.struct ?? r.callback ?? r.template ?? ""
  return `${src}|${dst}|${r.edge_kind ?? ""}`
}

/**
 * Build a ComparatorReport from a list of ComparisonResults.
 * run_id is derived deterministically from entity names.
 */
export function buildComparatorReport(results: ComparisonResult[]): ComparatorReport {
  const entityNames = [...new Set(results.map((r) => r.entity))]
  const run_id = deriveRunId(entityNames)

  // Aggregate per-entity worst outcome
  const entityOutcomes = new Map<string, CiOutcome>()
  for (const r of results) {
    const prev = entityOutcomes.get(r.entity) ?? "pass"
    const curr = r.ci_outcome
    entityOutcomes.set(r.entity, mergeOutcome(prev, curr))
  }

  const fail_entities = [...entityOutcomes.values()].filter((o) => o === "fail").length
  const warn_entities = [...entityOutcomes.values()].filter((o) => o === "warn").length
  const pass_entities = [...entityOutcomes.values()].filter((o) => o === "pass").length

  const ci_outcome: CiOutcome =
    fail_entities > 0 ? "fail" : warn_entities > 0 ? "warn" : "pass"

  return {
    run_id,
    fixture_count: entityNames.length,
    entity_results: results,
    aggregate: {
      total_entities: entityNames.length,
      fail_entities,
      warn_entities,
      pass_entities,
      ci_outcome,
    },
  }
}

function mergeOutcome(a: CiOutcome, b: CiOutcome): CiOutcome {
  if (a === "fail" || b === "fail") return "fail"
  if (a === "warn" || b === "warn") return "warn"
  return "pass"
}
