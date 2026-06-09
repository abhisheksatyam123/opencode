import fs from "fs/promises"
import path from "path"

import type { NormalizedQueryResponse, QueryIntent, QueryRequest } from "../intelligence/contracts/orchestrator"
import {
  deduplicateRelations,
  generateContractFromRelations,
  mapIntentToArray,
  normalizeEdge,
  selectIntentsForApi,
  type ApiFixture,
  type Relations,
} from "./intent-mapper"

/**
 * Query the intelligence backend for a given intent.
 * This is a facade that would normally call clangd_intelligence_query tool.
 */
async function queryBackend(request: QueryRequest): Promise<NormalizedQueryResponse> {
  // Placeholder: in production, this calls the intelligence tool
  // For now, return a minimal response structure that tests can mock
  return {
    snapshotId: request.snapshotId,
    intent: request.intent,
    status: "not_found",
    data: {
      nodes: [],
      edges: [],
    },
    provenance: {
      path: "db_hit",
      deterministicAttempts: [],
      llmUsed: false,
    },
  }
}

/**
 * Load an existing fixture from disk by API name.
 */
async function loadFixture(apiName: string): Promise<ApiFixture> {
  const fixturePath = path.join(
    process.cwd(),
    "test/fixtures/c/wlan/api",
    `${apiName}.json`,
  )

  try {
    const content = await fs.readFile(fixturePath, "utf-8")
    return JSON.parse(content)
  } catch (err) {
    throw new Error(`Failed to load fixture for ${apiName}: ${err}`)
  }
}

/**
 * Save an enriched fixture to disk.
 */
async function saveFixture(apiName: string, fixture: ApiFixture): Promise<void> {
  const fixturePath = path.join(
    process.cwd(),
    "test/fixtures/c/wlan/api",
    `${apiName}.json`,
  )

  const content = JSON.stringify(fixture, null, 2)
  await fs.writeFile(fixturePath, content, "utf-8")
}

/**
 * Enrich a single API fixture with multi-intent queries.
 *
 * Algorithm:
 * 1. Select applicable intents based on API role heuristics
 * 2. Query backend for all applicable intents (continue on failure per-intent)
 * 3. Normalize and merge results with deduplication
 * 4. Sort within each bucket by confidence descending
 * 5. Generate dynamic contract from populated arrays
 * 6. Return enriched fixture with metadata
 */
export async function enrichApiFixture(
  apiName: string,
  snapshotId: number,
): Promise<ApiFixture> {
  // Phase 1: Load existing fixture
  const existingFixture = await loadFixture(apiName)

  // Phase 2: Determine applicable intents
  const intents = selectIntentsForApi(apiName, existingFixture)

  // Phase 3: Query backend for all applicable intents
  const intentResults = new Map<QueryIntent, NormalizedQueryResponse>()

  for (const intent of intents) {
    try {
      const req: QueryRequest = {
        intent,
        snapshotId,
        apiName,
        apiNameAliases: [
          apiName,
          `_${apiName}`,
          `${apiName}___RAM`,
          `_${apiName}___RAM`,
        ],
      }

      const result = await queryBackend(req)
      intentResults.set(intent, result)
    } catch (err) {
      console.warn(`Intent ${intent} failed for ${apiName}: ${err}`)
      // Continue — don't fail entire enrichment
    }
  }

  // Phase 4: Normalize and merge results into relation arrays
  const enrichedRelations: Relations = JSON.parse(JSON.stringify(existingFixture.relations))
  const allNormalizedEdges: Relation[] = []

  for (const [intent, result] of intentResults) {
    if (result.status === "not_found") continue

    for (const edge of result.data.edges) {
      const bucket = mapIntentToArray(intent)
      const normalized = normalizeEdge(edge, bucket, intent)
      allNormalizedEdges.push(normalized)
    }
  }

  // Phase 5: Deduplicate
  const dedupTracker = deduplicateRelations(allNormalizedEdges)

  // Phase 6: Assign deduplicated relations to buckets
  for (const [, relation] of dedupTracker) {
    const bucket = relation.bucket || mapIntentToArray(relation.source_intent!)
    if (!enrichedRelations[bucket]) {
      enrichedRelations[bucket] = []
    }
    enrichedRelations[bucket].push(relation)
  }

  // Phase 7: Sort within each bucket (by confidence descending)
  for (const bucket of Object.keys(enrichedRelations) as (keyof Relations)[]) {
    enrichedRelations[bucket]?.sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
  }

  // Phase 8: Generate contract from populated arrays
  const contract = generateContractFromRelations(enrichedRelations)

  // Phase 9: Return enriched fixture
  return {
    ...existingFixture,
    relations: enrichedRelations,
    contract,
    enrichment_metadata: {
      timestamp: new Date().toISOString(),
      intents_queried: intents,
      intents_hit: Array.from(intentResults.entries())
        .filter(([, r]) => r.status === "hit" || r.status === "enriched")
        .map(([i]) => i),
      total_relations: Object.values(enrichedRelations).reduce(
        (sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0),
        0,
      ),
    },
  }
}

export interface FixtureEnrichmentReport {
  timestamp: string
  snapshot_id: number
  total_apis: number
  successful_apis: string[]
  failed_apis: Array<{ api: string; error: string }>
  total_relations_added: number
  intents_queried_per_api: Record<string, QueryIntent[]>
  intents_hit_per_api: Record<string, QueryIntent[]>
}

/**
 * Enrich all API fixtures in the test/fixtures/c/wlan/api directory.
 */
export async function enrichAllApis(
  snapshotIds: Record<string, number>,
): Promise<FixtureEnrichmentReport> {
  const fixturesDir = path.join(process.cwd(), "test/fixtures/c/wlan/api")
  const files = await fs.readdir(fixturesDir)
  const apiNames = files
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(".json", ""))

  const defaultSnapshotId = snapshotIds.default ?? 1
  const report: FixtureEnrichmentReport = {
    timestamp: new Date().toISOString(),
    snapshot_id: defaultSnapshotId,
    total_apis: apiNames.length,
    successful_apis: [],
    failed_apis: [],
    total_relations_added: 0,
    intents_queried_per_api: {},
    intents_hit_per_api: {},
  }

  for (const apiName of apiNames) {
    try {
      const snapshotId = snapshotIds[apiName] ?? defaultSnapshotId
      const enrichedFixture = await enrichApiFixture(apiName, snapshotId)

      await saveFixture(apiName, enrichedFixture)
      report.successful_apis.push(apiName)

      if (enrichedFixture.enrichment_metadata) {
        report.intents_queried_per_api[apiName] = enrichedFixture.enrichment_metadata.intents_queried
        report.intents_hit_per_api[apiName] = enrichedFixture.enrichment_metadata.intents_hit
        report.total_relations_added += enrichedFixture.enrichment_metadata.total_relations
      }
    } catch (err) {
      report.failed_apis.push({
        api: apiName,
        error: String(err),
      })
    }
  }

  return report
}

type Relation = Awaited<ReturnType<typeof enrichApiFixture>>["relations"]["calls_in_direct"][0]
