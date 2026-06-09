import type {
  IDbFoundation,
  ISnapshotIngestWriter,
  SnapshotIngestBatch,
} from "../db-foundation.js"
import type {
  IngestReport,
  SnapshotMeta,
  SnapshotRef,
} from "../common.js"

interface SnapshotRecord {
  snapshotId: number
  workspaceRoot: string
  status: SnapshotRef["status"]
  createdAt: string
  failReason: string | null
  meta: SnapshotMeta
}

/**
 * In-memory IDbFoundation. Suitable for:
 *   - contract-test suites (runs the same assertions as the SQLite impl)
 *   - consumer unit tests that need a real foundation but not real SQLite
 *
 * Not suitable for production. Holds all state in plain JS maps and
 * throws eagerly on invalid transitions (commit of unknown id, double
 * commit, etc.) — stricter than the SQLite impl today on purpose, so
 * that the contract suite surfaces where the real impl is loose.
 */
export class FakeDbFoundation implements IDbFoundation {
  private schemaInitialized = false
  private migrationsRan = false
  private nextId = 1
  private snapshots = new Map<number, SnapshotRecord>()

  // Test hook: in-order log of lifecycle events. Contract tests may
  // assert on this directly to verify ordering invariants.
  readonly events: Array<{ kind: string; id?: number; reason?: string }> = []

  async initSchema(): Promise<void> {
    this.schemaInitialized = true
    this.events.push({ kind: "initSchema" })
  }

  async runMigrations(): Promise<void> {
    if (!this.schemaInitialized) await this.initSchema()
    this.migrationsRan = true
    this.events.push({ kind: "runMigrations" })
  }

  async beginSnapshot(meta: SnapshotMeta): Promise<SnapshotRef> {
    const snapshotId = this.nextId++
    const createdAt = new Date().toISOString()
    const record: SnapshotRecord = {
      snapshotId,
      workspaceRoot: meta.workspaceRoot,
      status: "building",
      createdAt,
      failReason: null,
      meta,
    }
    this.snapshots.set(snapshotId, record)
    this.events.push({ kind: "beginSnapshot", id: snapshotId })
    return { snapshotId, createdAt, status: "building" }
  }

  async commitSnapshot(snapshotId: number): Promise<void> {
    const rec = this.snapshots.get(snapshotId)
    if (!rec) {
      throw new Error(`[fake-foundation] commitSnapshot: unknown snapshotId=${snapshotId}`)
    }
    if (rec.status === "failed") {
      throw new Error(`[fake-foundation] commitSnapshot: snapshot ${snapshotId} already failed`)
    }
    rec.status = "ready"
    this.events.push({ kind: "commitSnapshot", id: snapshotId })
  }

  async failSnapshot(snapshotId: number, reason: string): Promise<void> {
    const rec = this.snapshots.get(snapshotId)
    if (!rec) {
      throw new Error(`[fake-foundation] failSnapshot: unknown snapshotId=${snapshotId}`)
    }
    if (rec.status === "ready") {
      throw new Error(`[fake-foundation] failSnapshot: snapshot ${snapshotId} already committed`)
    }
    rec.status = "failed"
    rec.failReason = reason
    this.events.push({ kind: "failSnapshot", id: snapshotId, reason })
  }

  async getLatestReadySnapshot(workspaceRoot: string): Promise<SnapshotRef | null> {
    let latest: SnapshotRecord | undefined
    for (const rec of this.snapshots.values()) {
      if (rec.workspaceRoot !== workspaceRoot || rec.status !== "ready") continue
      if (!latest || rec.snapshotId > latest.snapshotId) latest = rec
    }
    if (!latest) return null
    return {
      snapshotId: latest.snapshotId,
      createdAt: latest.createdAt,
      status: "ready",
    }
  }

  // ---- Test hooks (not part of IDbFoundation) ----

  /** All snapshots ever created, in insertion order. */
  allSnapshots(): ReadonlyArray<SnapshotRecord> {
    return Array.from(this.snapshots.values())
  }

  /** True after initSchema() has been invoked at least once. */
  isSchemaInitialized(): boolean {
    return this.schemaInitialized
  }

  /** True after runMigrations() has been invoked at least once. */
  didRunMigrations(): boolean {
    return this.migrationsRan
  }
}

/**
 * In-memory ISnapshotIngestWriter paired with FakeDbFoundation. Counts
 * the rows it was handed and records the batch in insertion order.
 */
export class FakeSnapshotIngestWriter implements ISnapshotIngestWriter {
  readonly batches: Array<{ snapshotId: number; batch: SnapshotIngestBatch }> = []

  async writeSnapshotBatch(
    snapshotId: number,
    batch: SnapshotIngestBatch,
  ): Promise<IngestReport> {
    this.batches.push({ snapshotId, batch })
    return {
      snapshotId,
      inserted: {
        symbols: batch.symbols?.length ?? 0,
        types: batch.types?.length ?? 0,
        fields: batch.fields?.length ?? 0,
        edges: batch.edges?.length ?? 0,
        runtimeCallers: batch.runtimeCallers?.length ?? 0,
        participantsMaterialized: (batch.runtimeCallers ?? []).reduce(
          (sum, row) => sum + (row.participants?.length ?? 0),
          0,
        ),
        logs: 0,
        timerTriggers: 0,
      },
      warnings: [],
    }
  }
}
