import type {
  IIndirectCallerIngestion,
  RuntimeCallerInput,
  RuntimeCallerBatch,
  LinkReport,
} from "../indirect-caller-ingestion.js"
import type { IngestReport, RuntimeCallerRow } from "../common.js"

/**
 * In-memory IIndirectCallerIngestion.
 *
 * `linkToSymbols` resolves against a configurable set of "known" symbol
 * names supplied at construction. `persistRuntimeChains` does not write
 * to any sink — it just returns a synthetic IngestReport that mirrors the
 * real impl's counter logic.
 *
 * Suitable for:
 *   - contract-test suites
 *   - ingest-tool.ts unit tests that need IIndirectCallerIngestion
 *     without a live SQLite store or symbol table
 *
 * Test hooks (not part of IIndirectCallerIngestion):
 *   - `calls[]` — ordered record of every method invocation
 */
export class FakeIndirectCallerIngestion implements IIndirectCallerIngestion {
  private readonly knownSymbols: ReadonlySet<string>

  /** Ordered record of every method invocation for assertion. */
  readonly calls: Array<{ method: string; args: unknown[] }> = []

  constructor(knownSymbols: string[] = []) {
    this.knownSymbols = new Set(knownSymbols)
  }

  async parseRuntimeCallers(input: RuntimeCallerInput): Promise<RuntimeCallerBatch> {
    this.calls.push({ method: "parseRuntimeCallers", args: [input] })
    return { rows: input.records ?? [] }
  }

  async linkToSymbols(snapshotId: number, batch: RuntimeCallerBatch): Promise<LinkReport> {
    this.calls.push({ method: "linkToSymbols", args: [snapshotId, batch] })
    if (batch.rows.length === 0) {
      return { linked: [], unresolved: [], warnings: [] }
    }
    const linked: RuntimeCallerRow[] = []
    const unresolved: RuntimeCallerRow[] = []
    const warnings: string[] = []
    for (const row of batch.rows) {
      if (this.knownSymbols.has(row.targetApi)) {
        linked.push(row)
      } else {
        unresolved.push(row)
        warnings.push(`symbol not found: ${row.targetApi}`)
      }
    }
    return { linked, unresolved, warnings }
  }

  async persistRuntimeChains(snapshotId: number, linked: LinkReport): Promise<IngestReport> {
    this.calls.push({ method: "persistRuntimeChains", args: [snapshotId, linked] })
    const participantsMaterialized = linked.linked.reduce((sum, row) => sum + (row.participants?.length ?? 0), 0)
    return {
      snapshotId,
      inserted: {
        symbols: 0,
        types: 0,
        fields: 0,
        logs: 0,
        timerTriggers: 0,
        edges: linked.linked.length,
        runtimeCallers: linked.linked.length,
        participantsMaterialized,
      },
      warnings: [...linked.warnings],
    }
  }
}
