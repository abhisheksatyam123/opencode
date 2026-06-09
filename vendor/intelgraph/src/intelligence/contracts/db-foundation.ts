import type {
  AggregateFieldRow,
  EdgeRow,
  IngestReport,
  RuntimeCallerRow,
  SnapshotMeta,
  SnapshotRef,
  SymbolRow,
  TypeRow,
} from "./common.js"

export interface IDbFoundation {
  initSchema(): Promise<void>
  runMigrations(): Promise<void>
  beginSnapshot(meta: SnapshotMeta): Promise<SnapshotRef>
  commitSnapshot(snapshotId: number): Promise<void>
  failSnapshot(snapshotId: number, reason: string): Promise<void>
  /** Returns the latest ready snapshot for the given workspace root, or null if none exists. */
  getLatestReadySnapshot(workspaceRoot: string): Promise<SnapshotRef | null>
}

export interface SnapshotIngestBatch {
  symbols?: SymbolRow[]
  types?: TypeRow[]
  fields?: AggregateFieldRow[]
  edges?: EdgeRow[]
  runtimeCallers?: RuntimeCallerRow[]
}

export interface ISnapshotIngestWriter {
  writeSnapshotBatch(snapshotId: number, batch: SnapshotIngestBatch): Promise<IngestReport>
}
