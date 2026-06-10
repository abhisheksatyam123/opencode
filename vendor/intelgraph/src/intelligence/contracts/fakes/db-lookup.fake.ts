import type { DbLookupRepository, LookupResult, QueryIntent, QueryRequest } from "../orchestrator.js"

/**
 * Predicate used to select which seeded rows are returned for a given
 * request. `seed()` registers one entry per (intent, predicate) pair.
 */
type RequestMatcher = (req: QueryRequest) => boolean

interface SeedEntry {
  intent: QueryIntent
  match: RequestMatcher
  rows: Array<Record<string, unknown>>
}

/**
 * In-memory DbLookupRepository. Consumers seed rows for an (intent,
 * predicate) tuple; `lookup()` returns them verbatim. No query engine,
 * no JOINs — the fake models the PORT, not the SQLite schema.
 *
 * When nothing matches, returns a miss — same shape as the SQLite impl's
 * no-data path.
 */
export class FakeDbLookup implements DbLookupRepository {
  private seeds: SeedEntry[] = []
  readonly calls: QueryRequest[] = []

  /**
   * Register rows that the fake will return for matching requests.
   * `match` defaults to "every request with this intent".
   */
  seed(intent: QueryIntent, rows: Array<Record<string, unknown>>, match: RequestMatcher = () => true): void {
    this.seeds.push({ intent, match, rows })
  }

  /** Clear all seeded data. Useful between tests sharing a fake. */
  reset(): void {
    this.seeds = []
    this.calls.length = 0
  }

  async lookup(request: QueryRequest): Promise<LookupResult> {
    this.calls.push(request)

    const matching = this.seeds.filter((s) => s.intent === request.intent && s.match(request))
    const rows = matching.flatMap((s) => s.rows)

    return {
      hit: rows.length > 0,
      intent: request.intent,
      snapshotId: request.snapshotId,
      rows,
    }
  }
}
