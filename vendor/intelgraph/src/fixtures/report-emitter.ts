/**
 * Report emitter for comparator output.
 *
 * Emits machine-readable JSON and human-readable Markdown reports
 * from a ComparatorReport produced by fixture-comparator.ts.
 */

import { writeFile } from "node:fs/promises"
import type { ComparatorReport, ComparisonResult } from "./fixture-comparator"
import type { CiOutcome } from "./comparator-classifier"

const CI_BADGE: Record<CiOutcome, string> = {
  fail: "❌ FAIL",
  warn: "⚠️  WARN",
  pass: "✅ PASS",
}

/**
 * Write a JSON report to disk.
 */
export async function emitJsonReport(report: ComparatorReport, outputPath: string): Promise<void> {
  await writeFile(outputPath, JSON.stringify(report, null, 2), "utf-8")
}

/**
 * Write a Markdown report to disk.
 */
export async function emitMarkdownReport(report: ComparatorReport, outputPath: string): Promise<void> {
  await writeFile(outputPath, formatMarkdownSummary(report), "utf-8")
}

/**
 * Format a ComparatorReport as a Markdown string.
 *
 * Sections:
 * - Header with run_id and timestamp
 * - Aggregate summary table
 * - Per-entity diff tables
 * - CI outcome badge
 */
export function formatMarkdownSummary(report: ComparatorReport): string {
  const lines: string[] = []
  const ts = new Date().toISOString()

  // Header
  lines.push(`# Comparator Report`)
  lines.push(``)
  lines.push(`**Run ID:** \`${report.run_id}\`  `)
  lines.push(`**Generated:** ${ts}  `)
  lines.push(`**Fixtures:** ${report.fixture_count}`)
  lines.push(``)

  // CI outcome badge
  lines.push(`## CI Outcome: ${CI_BADGE[report.aggregate.ci_outcome]}`)
  lines.push(``)

  // Aggregate summary table
  lines.push(`## Aggregate Summary`)
  lines.push(``)
  lines.push(`| Metric | Count |`)
  lines.push(`|--------|-------|`)
  lines.push(`| Total entities | ${report.aggregate.total_entities} |`)
  lines.push(`| Fail entities | ${report.aggregate.fail_entities} |`)
  lines.push(`| Warn entities | ${report.aggregate.warn_entities} |`)
  lines.push(`| Pass entities | ${report.aggregate.pass_entities} |`)
  lines.push(``)

  // Per-entity sections
  if (report.entity_results.length > 0) {
    lines.push(`## Entity Results`)
    lines.push(``)

    // Group by entity
    const byEntity = new Map<string, ComparisonResult[]>()
    for (const r of report.entity_results) {
      const arr = byEntity.get(r.entity) ?? []
      arr.push(r)
      byEntity.set(r.entity, arr)
    }

    for (const [entity, results] of byEntity) {
      const entityOutcome = results.reduce<CiOutcome>((worst, r) => {
        if (worst === "fail" || r.ci_outcome === "fail") return "fail"
        if (worst === "warn" || r.ci_outcome === "warn") return "warn"
        return "pass"
      }, "pass")

      lines.push(`### ${entity} ${CI_BADGE[entityOutcome]}`)
      lines.push(``)

      for (const r of results) {
        if (r.diffs.length === 0) continue

        lines.push(`#### Intent: \`${r.intent}\` (bucket: \`${r.bucket}\`)`)
        lines.push(``)
        lines.push(`| Field | Expected | Actual | Mismatch Type | Severity | Rule ID |`)
        lines.push(`|-------|----------|--------|---------------|----------|---------|`)

        for (const d of r.diffs) {
          const expected = JSON.stringify(d.expected) ?? ""
          const actual = JSON.stringify(d.actual) ?? ""
          lines.push(`| \`${d.field}\` | ${expected} | ${actual} | ${d.mismatch_type} | ${d.severity} | \`${d.rule_id}\` |`)
        }

        lines.push(``)
      }
    }
  }

  return lines.join("\n")
}
