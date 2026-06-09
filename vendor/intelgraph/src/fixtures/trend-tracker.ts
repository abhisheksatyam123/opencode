/**
 * Trend tracker for WLAN confidence scores across runs.
 *
 * Compares consecutive reports to detect degradation patterns:
 *   - confidence worsening: score decreases
 *   - degradation band crossing: crosses WARN or FAIL threshold
 *   - severity escalation: S3→S2, S2→S1, S1→S0
 *
 * Produces trend verdicts: STABLE, IMPROVING, DEGRADING, THRESHOLD_BREACH
 */

export type TrendMetric = "confidence" | "severity" | "mismatch_count"

export type TrendVerdicts = "STABLE" | "IMPROVING" | "DEGRADING" | "THRESHOLD_BREACH"

export type TrendEntry = {
  run_id: string
  timestamp: number
  aggregate_confidence: number
  ci_outcome: "PASS" | "WARN" | "FAIL"
  max_severity: "S0" | "S1" | "S2" | "S3" | "none"
  mismatch_count: number
}

export type TrendAnalysis = {
  prior_run: TrendEntry
  current_run: TrendEntry
  confidence_delta: number // current - prior
  severity_escalated: boolean
  ci_boundary_crossed: "PASS->WARN" | "PASS->FAIL" | "WARN->FAIL" | "none"
  verdict: TrendVerdicts
}

const CI_BOUNDARIES = {
  PASS: 0.85,
  WARN: 0.70,
  FAIL: 0,
} as const

/**
 * Derive CI outcome from confidence score.
 */
function confidenceToCIOutcome(score: number): "PASS" | "WARN" | "FAIL" {
  if (score >= CI_BOUNDARIES.PASS) return "PASS"
  if (score >= CI_BOUNDARIES.WARN) return "WARN"
  return "FAIL"
}

/**
 * Severity levels ordered by severity (S0 worst, none best).
 */
const SEVERITY_ORDER: Record<string, number> = {
  S0: 4,
  S1: 3,
  S2: 2,
  S3: 1,
  none: 0,
}

/**
 * Detect which CI boundary was crossed, if any.
 */
function detectBoundaryCross(
  prior_score: number,
  current_score: number,
): "PASS->WARN" | "PASS->FAIL" | "WARN->FAIL" | "none" {
  const prior_outcome = confidenceToCIOutcome(prior_score)
  const current_outcome = confidenceToCIOutcome(current_score)

  if (prior_outcome === "PASS" && current_outcome === "WARN") return "PASS->WARN"
  if (prior_outcome === "PASS" && current_outcome === "FAIL") return "PASS->FAIL"
  if (prior_outcome === "WARN" && current_outcome === "FAIL") return "WARN->FAIL"

  return "none"
}

/**
 * Analyze trend between two runs.
 * Determines whether confidence is stable, improving, degrading, or crossing thresholds.
 */
export function analyzeTrend(prior_run: TrendEntry, current_run: TrendEntry): TrendAnalysis {
  const confidence_delta = current_run.aggregate_confidence - prior_run.aggregate_confidence
  const severity_escalated =
    SEVERITY_ORDER[current_run.max_severity] > SEVERITY_ORDER[prior_run.max_severity]
  const ci_boundary_crossed = detectBoundaryCross(
    prior_run.aggregate_confidence,
    current_run.aggregate_confidence,
  )

  let verdict: TrendVerdicts = "STABLE"

  // Threshold breach is the highest concern
  if (ci_boundary_crossed !== "none") {
    verdict = "THRESHOLD_BREACH"
  }
  // Then check for improving (positive delta of meaningful size)
  else if (confidence_delta > 0.05) {
    // More than 5% gain → improving
    verdict = "IMPROVING"
  }
  // Then check for degrading (negative delta of meaningful size OR severity escalation)
  else if (confidence_delta < -0.05) {
    // More than 5% drop → degrading
    verdict = "DEGRADING"
  } else if (severity_escalated) {
    // Severity worsened even if score stayed similar → degrading
    verdict = "DEGRADING"
  }
  // Otherwise stable (small deltas, no escalation)

  return {
    prior_run,
    current_run,
    confidence_delta,
    severity_escalated,
    ci_boundary_crossed,
    verdict,
  }
}

/**
 * Create a trend entry from confidence data.
 */
export function createTrendEntry(
  run_id: string,
  timestamp: number,
  aggregate_confidence: number,
  max_severity: "S0" | "S1" | "S2" | "S3" | "none",
  mismatch_count: number,
): TrendEntry {
  return {
    run_id,
    timestamp,
    aggregate_confidence,
    ci_outcome: confidenceToCIOutcome(aggregate_confidence),
    max_severity,
    mismatch_count,
  }
}

/**
 * Check if a trend is a concern (degrading or boundary breach).
 */
export function isTrendConcern(analysis: TrendAnalysis): boolean {
  return analysis.verdict === "DEGRADING" || analysis.verdict === "THRESHOLD_BREACH"
}

/**
 * Format trend summary for reporting.
 */
export function formatTrendSummary(analysis: TrendAnalysis): string {
  const lines = [
    `Run: ${analysis.prior_run.run_id} → ${analysis.current_run.run_id}`,
    `Confidence: ${analysis.prior_run.aggregate_confidence.toFixed(3)} → ${analysis.current_run.aggregate_confidence.toFixed(3)} (Δ ${analysis.confidence_delta > 0 ? "+" : ""}${analysis.confidence_delta.toFixed(3)})`,
    `CI outcome: ${analysis.prior_run.ci_outcome} → ${analysis.current_run.ci_outcome}`,
    `Verdict: ${analysis.verdict}`,
  ]

  if (analysis.ci_boundary_crossed !== "none") {
    lines.push(`⚠️ Boundary crossed: ${analysis.ci_boundary_crossed}`)
  }

  if (analysis.severity_escalated) {
    lines.push(
      `⚠️ Severity escalated: ${analysis.prior_run.max_severity} → ${analysis.current_run.max_severity}`,
    )
  }

  return lines.join("\n")
}
