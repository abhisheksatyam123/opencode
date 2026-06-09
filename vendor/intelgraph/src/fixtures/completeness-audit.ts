import fs from "fs/promises"
import path from "path"

/**
 * Completeness audit for WLAN fixture relations.
 *
 * Generates a comprehensive audit report showing:
 * - Per-API completeness scores (Tier 1, 1+2, 1+2+3)
 * - Relation counts and distribution
 * - APIs needing follow-up enrichment
 */

interface RelationSet {
  calls_in_direct?: Array<unknown>
  calls_in_runtime?: Array<unknown>
  calls_out?: Array<unknown>
  registrations_in?: Array<unknown>
  registrations_out?: Array<unknown>
  structures?: Array<unknown>
  logs?: Array<unknown>
  owns?: Array<unknown>
  uses?: Array<unknown>
}

interface ApiFixture {
  kind: string
  canonical_name: string
  relations: RelationSet
  contract?: Record<string, unknown>
}

interface ApiCompletenessScore {
  name: string
  tier1_complete: boolean
  tier2_complete: boolean
  tier3_complete: boolean
  completeness_score: number
  missing_relations: string[]
  relation_counts: {
    calls_in_direct: number
    calls_in_runtime: number
    calls_out: number
    registrations_in: number
    registrations_out: number
    structures: number
    logs: number
    owns: number
    uses: number
  }
}

interface AuditReport {
  timestamp: string
  total_apis: number
  average_completeness_score: number
  tier_distribution: {
    tier1_only: { count: number; percentage: number; apis: string[] }
    tier1_and_2: { count: number; percentage: number; apis: string[] }
    tier1_and_2_and_3: { count: number; percentage: number; apis: string[] }
  }
  total_relations: number
  relation_distribution: {
    calls_in_direct: number
    calls_in_runtime: number
    calls_out: number
    registrations_in: number
    registrations_out: number
    structures: number
    logs: number
    owns: number
    uses: number
  }
  apis_needing_followup: Array<{
    name: string
    completeness_score: number
    missing_relations: string[]
  }>
  per_api_scores: ApiCompletenessScore[]
}

/**
 * Calculate completeness tier scores for an API fixture.
 * Tier 1: requires at least one incoming relation (calls_in_direct OR calls_in_runtime OR registrations_in)
 * Tier 2: contextual relations (calls_out, structures, logs, owns)
 * Tier 3: optional relations (uses, registrations_out)
 */
function calculateCompletenessScore(fixture: ApiFixture): ApiCompletenessScore {
  const relations = fixture.relations || {}
  const name = fixture.canonical_name

  // Count relations in each array
  const counts = {
    calls_in_direct: (relations.calls_in_direct || []).length,
    calls_in_runtime: (relations.calls_in_runtime || []).length,
    calls_out: (relations.calls_out || []).length,
    registrations_in: (relations.registrations_in || []).length,
    registrations_out: (relations.registrations_out || []).length,
    structures: (relations.structures || []).length,
    logs: (relations.logs || []).length,
    owns: (relations.owns || []).length,
    uses: (relations.uses || []).length,
  }

  // Tier 1: at least one incoming
  const tier1Complete =
    counts.calls_in_direct > 0 || counts.calls_in_runtime > 0 || counts.registrations_in > 0

  // Tier 2: contextual relations (at least one of calls_out, structures, logs, owns)
  const tier2Complete =
    counts.calls_out > 0 || counts.structures > 0 || counts.logs > 0 || counts.owns > 0

  // Tier 3: optional relations
  const tier3Complete = counts.uses > 0 || counts.registrations_out > 0

  // Calculate completeness percentage
  const maxScore = 10 // weighted scoring
  let score = 0
  if (tier1Complete) score += 5 // Tier 1 worth 50%
  if (tier2Complete) score += 4 // Tier 2 worth 40%
  if (tier3Complete) score += 1 // Tier 3 worth 10%

  const completeness_score = (score / maxScore) * 100

  // Identify missing relations
  const missing_relations: string[] = []
  if (counts.calls_in_direct === 0) missing_relations.push("calls_in_direct")
  if (counts.calls_in_runtime === 0) missing_relations.push("calls_in_runtime")
  if (counts.calls_out === 0) missing_relations.push("calls_out")
  if (counts.registrations_in === 0) missing_relations.push("registrations_in")
  if (counts.registrations_out === 0) missing_relations.push("registrations_out")
  if (counts.structures === 0) missing_relations.push("structures")
  if (counts.logs === 0) missing_relations.push("logs")
  if (counts.owns === 0) missing_relations.push("owns")
  if (counts.uses === 0) missing_relations.push("uses")

  return {
    name,
    tier1_complete: tier1Complete,
    tier2_complete: tier2Complete,
    tier3_complete: tier3Complete,
    completeness_score,
    missing_relations,
    relation_counts: counts,
  }
}

/**
 * Load all API fixtures and generate completeness audit report.
 */
export async function generateCompletenessAudit(
  fixturesDir: string = "test/fixtures/c/wlan/api",
): Promise<AuditReport> {
  const files = await fs.readdir(fixturesDir)
  const jsonFiles = files.filter((f) => f.endsWith(".json"))

  const apiScores: ApiCompletenessScore[] = []
  const relationDistribution = {
    calls_in_direct: 0,
    calls_in_runtime: 0,
    calls_out: 0,
    registrations_in: 0,
    registrations_out: 0,
    structures: 0,
    logs: 0,
    owns: 0,
    uses: 0,
  }

  for (const file of jsonFiles) {
    const content = await fs.readFile(path.join(fixturesDir, file), "utf-8")
    const fixture: ApiFixture = JSON.parse(content)
    const score = calculateCompletenessScore(fixture)
    apiScores.push(score)

    // Accumulate relation distribution
    relationDistribution.calls_in_direct += score.relation_counts.calls_in_direct
    relationDistribution.calls_in_runtime += score.relation_counts.calls_in_runtime
    relationDistribution.calls_out += score.relation_counts.calls_out
    relationDistribution.registrations_in += score.relation_counts.registrations_in
    relationDistribution.registrations_out += score.relation_counts.registrations_out
    relationDistribution.structures += score.relation_counts.structures
    relationDistribution.logs += score.relation_counts.logs
    relationDistribution.owns += score.relation_counts.owns
    relationDistribution.uses += score.relation_counts.uses
  }

  // Calculate tier distribution
  const tier1_only = apiScores.filter(
    (s) => s.tier1_complete && !s.tier2_complete && !s.tier3_complete,
  )
  const tier1_and_2 = apiScores.filter(
    (s) => s.tier1_complete && s.tier2_complete && !s.tier3_complete,
  )
  const tier1_and_2_and_3 = apiScores.filter(
    (s) => s.tier1_complete && s.tier2_complete && s.tier3_complete,
  )

  // APIs needing follow-up: < 70% completeness
  const needsFollowup = apiScores
    .filter((s) => s.completeness_score < 70)
    .sort((a, b) => a.completeness_score - b.completeness_score)
    .slice(0, 10) // Top 10 most incomplete

  // Average completeness
  const avgCompleteness =
    apiScores.reduce((sum, s) => sum + s.completeness_score, 0) / apiScores.length

  const totalRelations = Object.values(relationDistribution).reduce((a, b) => a + b, 0)

  return {
    timestamp: new Date().toISOString(),
    total_apis: apiScores.length,
    average_completeness_score: Math.round(avgCompleteness * 10) / 10,
    tier_distribution: {
      tier1_only: {
        count: tier1_only.length,
        percentage: Math.round((tier1_only.length / apiScores.length) * 1000) / 10,
        apis: tier1_only.map((s) => s.name),
      },
      tier1_and_2: {
        count: tier1_and_2.length,
        percentage: Math.round((tier1_and_2.length / apiScores.length) * 1000) / 10,
        apis: tier1_and_2.map((s) => s.name),
      },
      tier1_and_2_and_3: {
        count: tier1_and_2_and_3.length,
        percentage: Math.round((tier1_and_2_and_3.length / apiScores.length) * 1000) / 10,
        apis: tier1_and_2_and_3.map((s) => s.name),
      },
    },
    total_relations: totalRelations,
    relation_distribution: relationDistribution,
    apis_needing_followup: needsFollowup.map((s) => ({
      name: s.name,
      completeness_score: s.completeness_score,
      missing_relations: s.missing_relations,
    })),
    per_api_scores: apiScores.sort((a, b) => b.completeness_score - a.completeness_score),
  }
}

/**
 * Format audit report as a box-drawn table.
 */
export function formatAuditReport(report: AuditReport): string {
  const lines: string[] = []

  lines.push("╔════════════════════════════════════════════════════════════════════════════╗")
  lines.push("║ FIXTURE COMPLETENESS AUDIT REPORT                                          ║")
  lines.push("╠════════════════════════════════════════════════════════════════════════════╣")
  lines.push(`║ Total APIs: ${report.total_apis}`.padEnd(77) + "║")
  lines.push(
    `║ Average Completeness Score: ${report.average_completeness_score}%`.padEnd(77) + "║",
  )
  lines.push("║ Tier Distribution:                                                         ║")
  lines.push(
    `║   - Tier 1 complete (${report.tier_distribution.tier1_only.count} APIs, ${report.tier_distribution.tier1_only.percentage}%):     calls_in_* or registrations_in`.padEnd(
      77,
    ) + "║",
  )
  lines.push(
    `║   - Tier 1+2 complete (${report.tier_distribution.tier1_and_2.count} APIs, ${report.tier_distribution.tier1_and_2.percentage}%): expected role relations`.padEnd(
      77,
    ) + "║",
  )
  lines.push(
    `║   - Tier 1+2+3 complete (${report.tier_distribution.tier1_and_2_and_3.count} APIs, ${report.tier_distribution.tier1_and_2_and_3.percentage}%): all relation types`.padEnd(
      77,
    ) + "║",
  )
  lines.push(`║ Total Relations: ${report.total_relations}`.padEnd(77) + "║")
  lines.push("║ Relation Distribution:                                                     ║")

  const relDist = report.relation_distribution
  lines.push(
    `║   - calls_in_direct: ${relDist.calls_in_direct}`.padEnd(77) + "║",
  )
  lines.push(
    `║   - calls_in_runtime: ${relDist.calls_in_runtime}`.padEnd(77) + "║",
  )
  lines.push(
    `║   - calls_out: ${relDist.calls_out}`.padEnd(77) + "║",
  )
  lines.push(
    `║   - registrations_in: ${relDist.registrations_in}`.padEnd(77) + "║",
  )
  lines.push(
    `║   - structures: ${relDist.structures}`.padEnd(77) + "║",
  )
  lines.push(
    `║   - logs: ${relDist.logs}`.padEnd(77) + "║",
  )
  lines.push(
    `║   - owns: ${relDist.owns}`.padEnd(77) + "║",
  )
  lines.push(
    `║   - registrations_out: ${relDist.registrations_out}`.padEnd(77) + "║",
  )
  lines.push(
    `║   - uses: ${relDist.uses}`.padEnd(77) + "║",
  )

  lines.push("╠════════════════════════════════════════════════════════════════════════════╣")

  if (report.apis_needing_followup.length > 0) {
    lines.push("║ APIs Needing Follow-up (<70% completeness):                                ║")
    report.apis_needing_followup.forEach((api, idx) => {
      const missing = api.missing_relations.slice(0, 3).join(", ")
      const label = `  ${idx + 1}. ${api.name} (${Math.round(api.completeness_score)}% - missing ${missing})`
      lines.push(`║${label.padEnd(77)}║`)
    })
  } else {
    lines.push("║ All APIs at ≥70% completeness! ✓                                           ║")
  }

  lines.push("╚════════════════════════════════════════════════════════════════════════════╝")

  return lines.join("\n")
}

/**
 * Format audit report as JSON.
 */
export function formatAuditReportJson(report: AuditReport): string {
  return JSON.stringify(report, null, 2)
}

/**
 * Format audit report as markdown table.
 */
export function formatAuditReportMarkdown(report: AuditReport): string {
  const lines: string[] = []

  lines.push("# WLAN Fixture Completeness Audit Report\n")
  lines.push(`**Generated:** ${report.timestamp}\n`)
  lines.push(`**Total APIs:** ${report.total_apis}`)
  lines.push(`**Average Completeness:** ${report.average_completeness_score}%\n`)

  lines.push("## Tier Distribution\n")
  lines.push("| Tier | Count | Percentage | Description |")
  lines.push("|------|-------|------------|-------------|")
  lines.push(
    `| Tier 1 | ${report.tier_distribution.tier1_only.count} | ${report.tier_distribution.tier1_only.percentage}% | Incoming relations only |`,
  )
  lines.push(
    `| Tier 1+2 | ${report.tier_distribution.tier1_and_2.count} | ${report.tier_distribution.tier1_and_2.percentage}% | With contextual relations |`,
  )
  lines.push(
    `| Tier 1+2+3 | ${report.tier_distribution.tier1_and_2_and_3.count} | ${report.tier_distribution.tier1_and_2_and_3.percentage}% | Complete with optional relations |`,
  )

  lines.push("\n## Relation Distribution\n")
  lines.push("| Relation Type | Count |")
  lines.push("|---|---|")
  lines.push(
    `| calls_in_direct | ${report.relation_distribution.calls_in_direct} |`,
  )
  lines.push(
    `| calls_in_runtime | ${report.relation_distribution.calls_in_runtime} |`,
  )
  lines.push(
    `| calls_out | ${report.relation_distribution.calls_out} |`,
  )
  lines.push(
    `| registrations_in | ${report.relation_distribution.registrations_in} |`,
  )
  lines.push(
    `| registrations_out | ${report.relation_distribution.registrations_out} |`,
  )
  lines.push(
    `| structures | ${report.relation_distribution.structures} |`,
  )
  lines.push(
    `| logs | ${report.relation_distribution.logs} |`,
  )
  lines.push(
    `| owns | ${report.relation_distribution.owns} |`,
  )
  lines.push(
    `| uses | ${report.relation_distribution.uses} |`,
  )

  if (report.apis_needing_followup.length > 0) {
    lines.push("\n## APIs Needing Follow-up\n")
    report.apis_needing_followup.forEach((api, idx) => {
      lines.push(`${idx + 1}. **${api.name}** (${Math.round(api.completeness_score)}%)`)
      lines.push(`   - Missing: ${api.missing_relations.join(", ")}\n`)
    })
  }

  return lines.join("\n")
}
