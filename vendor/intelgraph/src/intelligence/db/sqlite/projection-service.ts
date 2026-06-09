/**
 * projection-service.ts — SQLite (no-op) projection service.
 *
 * No-op projection service. The "projection" concept was planned as a
 * separate read-optimized layer (auth store -> derived view), but it was
 * never implemented.
 *
 * SQLite doesn't need a projection layer: graph_nodes and graph_edges
 * are already directly queryable by SqliteDbLookup. Keeping the same
 * no-op contract preserves backward compatibility with ingest-tool
 * and the orchestrator-runner, which call projection.syncFromAuthoritative()
 * at the end of every snapshot.
 *
 * If the future brings a real need for a projection layer (denormalized
 * read model, cached graph-closure indexes, read-replicas), it lands
 * here as a real implementation.
 */

import type { GraphProjectionRepository } from "../../contracts/orchestrator.js"

export class SqliteGraphProjectionService implements GraphProjectionRepository {
  async syncFromAuthoritative(
    _snapshotId: number,
  ): Promise<{ synced: boolean; nodesUpserted: number; edgesUpserted: number }> {
    return { synced: false, nodesUpserted: 0, edgesUpserted: 0 }
  }
}
