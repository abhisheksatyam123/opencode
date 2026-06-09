/**
 * Confidence scorer for WLAN fixture-vs-backend comparison.
 *
 * Aggregates four dimensions into a single release-confidence score:
 *   - coverage_score       (0–1) from completeness audit tier coverage
 *   - backend_match_score  (0–1) fraction of fixture relations confirmed by backend
 *   - evidence_quality_score (0–1) fraction of relations with non-weak evidence
 *   - consistency_score    (0 or 1) 1.0 if no consistency mismatches, 0.0 if any S0
 *
 * CI thresholds:
 *   aggregate >= 0.85 → PASS
 *   0.70 <= aggregate < 0.85 → WARN
 *   aggregate < 0.70 → FAIL
 *   Any S0/S1 mismatch → override to FAIL regardless of score
 */

export type ConfidenceInput = {
  coverage_score: number           // 0–1 from completeness audit
  backend_match_score: number      // 0–1 fraction of fixture relations confirmed
  evidence_quality_score: number   // 0–1 fraction with non-weak evidence
  consistency_score: number        // 0 or 1
  has_s0_s1_mismatch: boolean      // override flag
}

export type ConfidenceResult = {
  aggregate_confidence: number     // 0–1 weighted score
  ci_outcome: "PASS" | "WARN" | "FAIL"
  dimension_scores: ConfidenceInput
  remediation_hints: string[]      // actionable guidance
}

export type FamilyConfidenceSummary = {
  family: string
  entity_count: number
  avg_confidence: number
  ci_outcome: "PASS" | "WARN" | "FAIL"
  low_confidence_entities: string[]  // canonical_names below warn threshold
}

export const CONFIDENCE_WEIGHTS = {
  coverage: 0.25,
  backend_match: 0.35,
  evidence_quality: 0.20,
  consistency: 0.20,
} as const

export const CONFIDENCE_THRESHOLDS = {
  pass: 0.85,
  warn: 0.70,
} as const

/**
 * Compute remediation hints from dimension scores.
 */
function buildHints(input: ConfidenceInput, aggregate: number): string[] {
  const hints: string[] = []
  if (input.coverage_score < 0.5)
    hints.push("Run enrichment pipeline to populate missing relation buckets")
  if (input.backend_match_score < 0.7)
    hints.push("Backend is missing fixture-expected relations — check DB snapshot freshness")
  if (input.evidence_quality_score < 0.7)
    hints.push("Relations have weak evidence — re-run enrichment with higher confidence threshold")
  if (input.consistency_score < 1.0)
    hints.push("Mock/live backend inconsistency detected — investigate DB query path")
  if (aggregate < CONFIDENCE_THRESHOLDS.warn)
    hints.push("Entity below release threshold — remediate before merge")
  return hints
}

/**
 * Derive CI outcome from aggregate score and S0/S1 override flag.
 */
function deriveOutcome(aggregate: number, has_s0_s1_mismatch: boolean): "PASS" | "WARN" | "FAIL" {
  if (has_s0_s1_mismatch) return "FAIL"
  if (aggregate >= CONFIDENCE_THRESHOLDS.pass) return "PASS"
  if (aggregate >= CONFIDENCE_THRESHOLDS.warn) return "WARN"
  return "FAIL"
}

/**
 * Score a single entity's confidence from its four dimension inputs.
 */
export function scoreConfidence(input: ConfidenceInput): ConfidenceResult {
  const aggregate =
    input.coverage_score * CONFIDENCE_WEIGHTS.coverage +
    input.backend_match_score * CONFIDENCE_WEIGHTS.backend_match +
    input.evidence_quality_score * CONFIDENCE_WEIGHTS.evidence_quality +
    input.consistency_score * CONFIDENCE_WEIGHTS.consistency

  const ci_outcome = deriveOutcome(aggregate, input.has_s0_s1_mismatch)
  const remediation_hints = buildHints(input, aggregate)

  return {
    aggregate_confidence: aggregate,
    ci_outcome,
    dimension_scores: input,
    remediation_hints,
  }
}

/**
 * Aggregate per-entity confidence results into per-family summaries.
 * low_confidence_entities lists canonical_names with aggregate < warn threshold.
 */
export function aggregateFamilyConfidence(
  results: Array<{ entity: string; family: string; confidence: ConfidenceResult }>,
): FamilyConfidenceSummary[] {
  const byFamily = new Map<string, Array<{ entity: string; confidence: ConfidenceResult }>>()

  for (const r of results) {
    const bucket = byFamily.get(r.family) ?? []
    bucket.push({ entity: r.entity, confidence: r.confidence })
    byFamily.set(r.family, bucket)
  }

  const summaries: FamilyConfidenceSummary[] = []

  for (const [family, entries] of byFamily) {
    const avg = entries.reduce((s, e) => s + e.confidence.aggregate_confidence, 0) / entries.length
    const low = entries
      .filter((e) => e.confidence.aggregate_confidence < CONFIDENCE_THRESHOLDS.warn)
      .map((e) => e.entity)

    summaries.push({
      family,
      entity_count: entries.length,
      avg_confidence: avg,
      ci_outcome: deriveOutcome(avg, entries.some((e) => e.confidence.ci_outcome === "FAIL" && e.confidence.dimension_scores.has_s0_s1_mismatch)),
      low_confidence_entities: low,
    })
  }

  return summaries
}
