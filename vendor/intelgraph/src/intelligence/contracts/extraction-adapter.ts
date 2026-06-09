import type {
  AggregateFieldRow,
  EdgeRow,
  IngestReport,
  SymbolRow,
  TypeRow,
} from "./common.js"

export interface ExtractionInput {
  workspaceRoot: string
  files?: string[]
  fileLimit?: number
  sourceRevision?: string
}

export interface SymbolBatch {
  symbols: SymbolRow[]
}

export interface TypeBatch {
  types: TypeRow[]
  fields: AggregateFieldRow[]
}

export interface EdgeBatch {
  edges: EdgeRow[]
}

export interface ExtractionBatches {
  symbolBatch: SymbolBatch
  typeBatch: TypeBatch
  edgeBatch: EdgeBatch
}

export interface IExtractionAdapter {
  extractSymbols(input: ExtractionInput): Promise<SymbolBatch>
  extractTypes(input: ExtractionInput): Promise<TypeBatch>
  extractEdges(input: ExtractionInput): Promise<EdgeBatch>
  materializeSnapshot(snapshotId: number, batches: ExtractionBatches): Promise<IngestReport>
}
