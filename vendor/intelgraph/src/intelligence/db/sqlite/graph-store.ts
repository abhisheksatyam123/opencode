/**
 * graph-store.ts — SQLite implementation of GraphWriteSink (and SymbolFinder).
 *
 * SQLite implementation of GraphWriteSink. Writes through Drizzle into the five
 * SQLite tables defined in schema.ts. The whole write() call runs in
 * one synchronous better-sqlite3 transaction for atomicity — either
 * every node/edge/evidence/observation in the batch is visible to
 * subsequent reads, or nothing is (on error).
 *
 * Conflict handling: INSERT ... ON CONFLICT(snapshot_id, id) DO UPDATE
 * matches the MERGE semantics the legacy code used. Re-running
 * an ingest against the same snapshot is safe and idempotent.
 *
 * JSON columns: Drizzle's text(mode: 'json') auto-serializes on insert
 * and auto-parses on select, so plugins and the FactBus can pass
 * SourceLocation objects and metadata records directly — no manual
 * JSON.stringify at the boundary.
 */

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import { and, eq, sql } from "drizzle-orm"
import type {
  GraphEdgeRow,
  GraphEvidenceRow,
  GraphNodeRow,
  GraphObservationRow,
  GraphWriteBatch,
  GraphWriteSink,
} from "../graph-rows.js"
import type { SymbolFinder } from "../ingestion/indirect-caller-ingestion-service.js"
import type { SourceLocation } from "../../contracts/common.js"
import * as schema from "./schema.js"
import {
  type EdgeMetadata,
  type EvidencePayload,
  type NodePayload,
  type ObservationPayload,
  graphEdges,
  graphEvidence,
  graphNodes,
  graphObservations,
} from "./schema.js"

type SqliteDb = BetterSQLite3Database<typeof schema>

export class SqliteGraphStore implements GraphWriteSink, SymbolFinder {
  constructor(private readonly db: SqliteDb) {}

  async hasSymbol(snapshotId: number, name: string): Promise<boolean> {
    const rows = this.db
      .select({ nodeId: graphNodes.nodeId })
      .from(graphNodes)
      .where(
        and(eq(graphNodes.snapshotId, snapshotId), eq(graphNodes.canonicalName, name), eq(graphNodes.kind, "function")),
      )
      .limit(1)
      .all()
    return rows.length > 0
  }

  async write(batch: GraphWriteBatch): Promise<void> {
    // better-sqlite3 transactions are synchronous; wrapping the whole
    // batch in one txn gives us atomicity without async overhead.
    this.db.transaction((tx) => {
      this.writeNodes(tx, batch.nodes)
      this.writeEdges(tx, batch.edges)
      this.writeGhostNodes(tx, batch.nodes, batch.edges)
      this.writeEvidence(tx, batch.evidence)
      this.writeObservations(tx, batch.observations)
    })
  }

  // -------------------------------------------------------------------------
  // Per-table writers
  // -------------------------------------------------------------------------

  private writeNodes(tx: SqliteDb, rows: GraphNodeRow[]): void {
    if (rows.length === 0) return
    tx.insert(graphNodes)
      .values(
        rows.map((r) => ({
          snapshotId: r.snapshot_id,
          nodeId: r.node_id,
          canonicalName: r.canonical_name,
          kind: r.kind,
          location: (r.location ?? null) as SourceLocation | null,
          payload: (r.payload ?? null) as NodePayload | null,
        })),
      )
      .onConflictDoUpdate({
        target: [graphNodes.snapshotId, graphNodes.nodeId],
        set: {
          canonicalName: sql`excluded.canonical_name`,
          kind: sql`excluded.kind`,
          location: sql`excluded.location`,
          payload: sql`excluded.payload`,
        },
      })
      .run()
  }

  private writeEdges(tx: SqliteDb, rows: GraphEdgeRow[]): void {
    if (rows.length === 0) return
    tx.insert(graphEdges)
      .values(
        rows.map((r) => ({
          snapshotId: r.snapshot_id,
          edgeId: r.edge_id,
          edgeKind: r.edge_kind,
          srcNodeId: r.src_node_id ?? null,
          dstNodeId: r.dst_node_id ?? null,
          confidence: r.confidence,
          derivation: r.derivation,
          metadata: (r.metadata ?? null) as EdgeMetadata | null,
        })),
      )
      .onConflictDoUpdate({
        target: [graphEdges.snapshotId, graphEdges.edgeId],
        set: {
          edgeKind: sql`excluded.edge_kind`,
          srcNodeId: sql`excluded.src_node_id`,
          dstNodeId: sql`excluded.dst_node_id`,
          confidence: sql`excluded.confidence`,
          derivation: sql`excluded.derivation`,
          metadata: sql`excluded.metadata`,
        },
      })
      .run()
  }

  // For edges referencing nodes that were never written by a symbol phase
  // (e.g. when clangd LSP is absent), insert minimal stub nodes so that
  // JOIN-based queries in db-lookup still return rows. Ghost nodes carry
  // kind="function" and no location; if the real symbol is later written,
  // the ON CONFLICT DO UPDATE upgrades the row in place.
  private writeGhostNodes(tx: SqliteDb, writtenNodes: GraphNodeRow[], edges: GraphEdgeRow[]): void {
    const writtenIds = new Set(writtenNodes.map((n) => `${n.snapshot_id}:${n.node_id}`))
    const ghosts = new Map<string, { snapshotId: number; nodeId: string; canonicalName: string }>()

    for (const edge of edges) {
      for (const [nodeId, snapshotId] of [
        [edge.src_node_id, edge.snapshot_id],
        [edge.dst_node_id, edge.snapshot_id],
      ] as Array<[string | undefined, number]>) {
        if (!nodeId) continue
        const key = `${snapshotId}:${nodeId}`
        if (writtenIds.has(key) || ghosts.has(key)) continue

        // node_id format: "graph_node:<snapshotId>:symbol:<canonicalName>"
        // Extract canonical name from the last segment after "symbol:"
        const symbolMarker = ":symbol:"
        const idx = nodeId.indexOf(symbolMarker)
        const canonicalName = idx >= 0 ? nodeId.slice(idx + symbolMarker.length) : nodeId

        ghosts.set(key, { snapshotId, nodeId, canonicalName })
      }
    }

    if (ghosts.size === 0) return
    tx.insert(graphNodes)
      .values(
        Array.from(ghosts.values()).map((g) => ({
          snapshotId: g.snapshotId,
          nodeId: g.nodeId,
          canonicalName: g.canonicalName,
          kind: (g.canonicalName.startsWith("log:") ? "log_point" : "function") as "log_point" | "function",
          location: null,
          payload: null,
        })),
      )
      .onConflictDoNothing()
      .run()
  }

  private writeEvidence(tx: SqliteDb, rows: GraphEvidenceRow[]): void {
    if (rows.length === 0) return
    tx.insert(graphEvidence)
      .values(
        rows.map((r) => ({
          snapshotId: r.snapshot_id,
          evidenceId: r.evidence_id,
          edgeId: r.edge_id ?? null,
          nodeId: r.node_id ?? null,
          sourceKind: r.source_kind,
          location: (r.location ?? null) as SourceLocation | null,
          payload: (r.payload ?? null) as EvidencePayload | null,
        })),
      )
      .onConflictDoUpdate({
        target: [graphEvidence.snapshotId, graphEvidence.evidenceId],
        set: {
          edgeId: sql`excluded.edge_id`,
          nodeId: sql`excluded.node_id`,
          sourceKind: sql`excluded.source_kind`,
          location: sql`excluded.location`,
          payload: sql`excluded.payload`,
        },
      })
      .run()
  }

  /**
   * Delete all graph data (nodes, edges, evidence, observations) whose
   * node_id or location contains the given file path. Used by incremental
   * extraction to purge stale data for a changed file before re-inserting.
   *
   * The node_id format is `graph_node:{snapshotId}:symbol:module:{filePath}#...`
   * so a LIKE '%{filePath}%' on node_id catches all nodes from that file.
   * Edges are purged when either endpoint references a node from that file.
   */
  async purgeFile(snapshotId: number, filePath: string): Promise<{ nodes: number; edges: number }> {
    // Escape SQL LIKE wildcards in filePath so '_' and '%' in file names
    // are matched literally (e.g. "api_handler.ts" should not match "apiXhandler.ts").
    const escaped = filePath.replace(/%/g, "\\%").replace(/_/g, "\\_")
    const filePattern = `%${escaped}%`
    let nodes = 0
    let edges = 0

    this.db.transaction((tx) => {
      // Find node IDs belonging to this file
      const nodeIds = tx
        .select({ nodeId: graphNodes.nodeId })
        .from(graphNodes)
        .where(
          and(
            eq(graphNodes.snapshotId, snapshotId),
            sql`(${graphNodes.nodeId} LIKE ${filePattern} ESCAPE '\\' OR json_extract(${graphNodes.location}, '$.filePath') LIKE ${filePattern} ESCAPE '\\')`,
          ),
        )
        .all()
        .map((r) => r.nodeId)

      if (nodeIds.length === 0) return

      const idSet = new Set(nodeIds)

      // Delete edges where src or dst is one of these nodes
      for (const nodeId of nodeIds) {
        const pattern = `%${nodeId.replace(/[%_]/g, "")}%`
        const edgeResult = tx
          .delete(graphEdges)
          .where(
            and(
              eq(graphEdges.snapshotId, snapshotId),
              sql`(${graphEdges.srcNodeId} = ${nodeId} OR ${graphEdges.dstNodeId} = ${nodeId})`,
            ),
          )
          .run()
        edges += edgeResult.changes
      }

      // Delete evidence and observations for these nodes
      for (const nodeId of nodeIds) {
        tx.delete(graphEvidence)
          .where(and(eq(graphEvidence.snapshotId, snapshotId), eq(graphEvidence.nodeId, nodeId)))
          .run()
        tx.delete(graphObservations)
          .where(and(eq(graphObservations.snapshotId, snapshotId), eq(graphObservations.nodeId, nodeId)))
          .run()
      }

      // Delete the nodes themselves
      for (const nodeId of nodeIds) {
        tx.delete(graphNodes)
          .where(and(eq(graphNodes.snapshotId, snapshotId), eq(graphNodes.nodeId, nodeId)))
          .run()
      }
      nodes = nodeIds.length
    })

    return { nodes, edges }
  }

  private writeObservations(tx: SqliteDb, rows: GraphObservationRow[]): void {
    if (rows.length === 0) return
    tx.insert(graphObservations)
      .values(
        rows.map((r) => ({
          snapshotId: r.snapshot_id,
          observationId: r.observation_id,
          nodeId: r.node_id ?? null,
          kind: r.kind,
          observedAt: r.observed_at,
          confidence: r.confidence,
          payload: (r.payload ?? null) as ObservationPayload | null,
        })),
      )
      .onConflictDoUpdate({
        target: [graphObservations.snapshotId, graphObservations.observationId],
        set: {
          nodeId: sql`excluded.node_id`,
          kind: sql`excluded.kind`,
          observedAt: sql`excluded.observed_at`,
          confidence: sql`excluded.confidence`,
          payload: sql`excluded.payload`,
        },
      })
      .run()
  }
}
