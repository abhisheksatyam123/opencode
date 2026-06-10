import type {
  EdgeBatch,
  ExtractionBatches,
  ExtractionInput,
  IExtractionAdapter,
  SymbolBatch,
  TypeBatch,
} from "../extraction-adapter.js"
import type { IngestReport } from "../common.js"

/**
 * In-memory IExtractionAdapter.
 *
 * Usage:
 *   const fake = new FakeExtractionAdapter()
 *   fake.seedSymbols([...])
 *   fake.seedTypes([...], [...])
 *   fake.seedEdges([...])
 *   await runner.run()
 *
 * Each extract*() method returns whatever was seeded (or empty when
 * unseeded). materializeSnapshot() produces an IngestReport with counts
 * derived from the inputs and records the call for assertion.
 */
export class FakeExtractionAdapter implements IExtractionAdapter {
  private seededSymbols: SymbolBatch = { symbols: [] }
  private seededTypes: TypeBatch = { types: [], fields: [] }
  private seededEdges: EdgeBatch = { edges: [] }

  readonly extractCalls: ExtractionInput[] = []
  readonly materializeCalls: Array<{
    snapshotId: number
    batches: ExtractionBatches
  }> = []

  seedSymbols(symbols: SymbolBatch["symbols"]): void {
    this.seededSymbols = { symbols: [...symbols] }
  }

  seedTypes(types: TypeBatch["types"], fields: TypeBatch["fields"] = []): void {
    this.seededTypes = { types: [...types], fields: [...fields] }
  }

  seedEdges(edges: EdgeBatch["edges"]): void {
    this.seededEdges = { edges: [...edges] }
  }

  async extractSymbols(input: ExtractionInput): Promise<SymbolBatch> {
    this.extractCalls.push(input)
    return { symbols: [...this.seededSymbols.symbols] }
  }

  async extractTypes(input: ExtractionInput): Promise<TypeBatch> {
    this.extractCalls.push(input)
    return {
      types: [...this.seededTypes.types],
      fields: [...this.seededTypes.fields],
    }
  }

  async extractEdges(input: ExtractionInput): Promise<EdgeBatch> {
    this.extractCalls.push(input)
    return { edges: [...this.seededEdges.edges] }
  }

  async materializeSnapshot(snapshotId: number, batches: ExtractionBatches): Promise<IngestReport> {
    this.materializeCalls.push({ snapshotId, batches })
    return {
      snapshotId,
      inserted: {
        symbols: batches.symbolBatch.symbols.length,
        types: batches.typeBatch.types.length,
        fields: batches.typeBatch.fields.length,
        edges: batches.edgeBatch.edges.length,
        runtimeCallers: 0,
        participantsMaterialized: 0,
        logs: 0,
        timerTriggers: 0,
      },
      warnings: [],
    }
  }
}
