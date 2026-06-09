/**
 * schema.ts — Drizzle schema for the intelligence graph.
 *
 * Five core tables for the intelligence graph:
 *   graph_snapshots
 *   graph_nodes
 *   graph_edges
 *   graph_evidence
 *   graph_observations
 *
 * Edges are rows with src_node_id / dst_node_id foreign keys.
 * The query code uses standard SQL JOINs across the 22 intent queries.
 *
 * JSON-shaped fields (`location`, `payload`, `metadata`) use Drizzle's
 * `text({ mode: 'json' })` column mode so Drizzle auto-serializes and
 * Typescript sees them as structured types. Complex queries can still
 * reach into the JSON via `sql` raw fragments with json_extract().
 *
 * Schema migrations: today, initSchema() runs a static DDL string
 * (CREATE TABLE IF NOT EXISTS) generated to mirror this file. When we
 * grow migration needs, swap to drizzle-kit generated migration files.
 * The DDL constant and the Drizzle table defs must stay in sync — a
 * test in Phase 1 asserts that a freshly-created table from the DDL
 * round-trips a Drizzle insert+select correctly.
 */

import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core"
import type {
  SourceLocation,
} from "../../contracts/common.js"

// ---------------------------------------------------------------------------
// Typed JSON payloads
// ---------------------------------------------------------------------------

export type NodePayload = {
  signature?: string
  linkage?: string
  metadata?: Record<string, unknown>
  _provenance?: { producedBy: readonly string[]; busConfidence: number }
} & Record<string, unknown>

export type EdgeMetadata = {
  access_path?: string
  source_location?: { sourceFilePath: string; sourceLineNumber: number }
  _provenance?: { producedBy: readonly string[]; busConfidence: number }
} & Record<string, unknown>

export type EvidencePayload = Record<string, unknown>

export type ObservationPayload = {
  target_api?: string
  immediate_invoker?: string
  runtime_trigger?: string
  dispatch_chain?: readonly string[]
  dispatch_site?: { filePath?: string; line?: number; column?: number }
  location?: SourceLocation
} & Record<string, unknown>

// ---------------------------------------------------------------------------
// graph_snapshots
// ---------------------------------------------------------------------------

export const graphSnapshots = sqliteTable(
  "graph_snapshots",
  {
    snapshotId: integer("snapshot_id").primaryKey({ autoIncrement: true }),
    workspaceRoot: text("workspace_root").notNull(),
    compileDbHash: text("compile_db_hash").notNull(),
    parserVersion: text("parser_version").notNull(),
    sourceRevision: text("source_revision"),
    status: text("status", { enum: ["building", "ready", "failed"] }).notNull(),
    createdAt: text("created_at").notNull(),
    readyAt: text("ready_at"),
    failedAt: text("failed_at"),
    failReason: text("fail_reason"),
    fingerprint: text("fingerprint").notNull(),
    metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown> | null>(),
  },
  (t) => ({
    idxWsStatus: index("idx_graph_snapshots_ws_status").on(
      t.workspaceRoot,
      t.status,
      t.snapshotId,
    ),
  }),
)

// ---------------------------------------------------------------------------
// graph_nodes
// ---------------------------------------------------------------------------

export const graphNodes = sqliteTable(
  "graph_nodes",
  {
    snapshotId: integer("snapshot_id")
      .notNull()
      .references(() => graphSnapshots.snapshotId, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    canonicalName: text("canonical_name").notNull(),
    kind: text("kind").notNull(),
    location: text("location", { mode: "json" }).$type<SourceLocation | null>(),
    payload: text("payload", { mode: "json" }).$type<NodePayload | null>(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.snapshotId, t.nodeId] }),
    idxWsName: index("idx_graph_nodes_ws_name").on(t.snapshotId, t.canonicalName),
    idxKind: index("idx_graph_nodes_kind").on(t.snapshotId, t.kind),
  }),
)

// ---------------------------------------------------------------------------
// graph_edges
// ---------------------------------------------------------------------------

export const graphEdges = sqliteTable(
  "graph_edges",
  {
    snapshotId: integer("snapshot_id")
      .notNull()
      .references(() => graphSnapshots.snapshotId, { onDelete: "cascade" }),
    edgeId: text("edge_id").notNull(),
    edgeKind: text("edge_kind").notNull(),
    srcNodeId: text("src_node_id"),
    dstNodeId: text("dst_node_id"),
    confidence: real("confidence").notNull(),
    derivation: text("derivation").notNull(),
    metadata: text("metadata", { mode: "json" }).$type<EdgeMetadata | null>(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.snapshotId, t.edgeId] }),
    idxSrc: index("idx_graph_edges_src").on(t.snapshotId, t.srcNodeId),
    idxDst: index("idx_graph_edges_dst").on(t.snapshotId, t.dstNodeId),
    idxKind: index("idx_graph_edges_kind").on(t.snapshotId, t.edgeKind),
  }),
)

// ---------------------------------------------------------------------------
// graph_evidence
// ---------------------------------------------------------------------------

export const graphEvidence = sqliteTable(
  "graph_evidence",
  {
    snapshotId: integer("snapshot_id")
      .notNull()
      .references(() => graphSnapshots.snapshotId, { onDelete: "cascade" }),
    evidenceId: text("evidence_id").notNull(),
    edgeId: text("edge_id"),
    nodeId: text("node_id"),
    sourceKind: text("source_kind").notNull(),
    location: text("location", { mode: "json" }).$type<SourceLocation | null>(),
    payload: text("payload", { mode: "json" }).$type<EvidencePayload | null>(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.snapshotId, t.evidenceId] }),
    idxEdge: index("idx_graph_evidence_edge").on(t.snapshotId, t.edgeId),
    idxNode: index("idx_graph_evidence_node").on(t.snapshotId, t.nodeId),
  }),
)

// ---------------------------------------------------------------------------
// graph_observations
// ---------------------------------------------------------------------------

export const graphObservations = sqliteTable(
  "graph_observations",
  {
    snapshotId: integer("snapshot_id")
      .notNull()
      .references(() => graphSnapshots.snapshotId, { onDelete: "cascade" }),
    observationId: text("observation_id").notNull(),
    nodeId: text("node_id"),
    kind: text("kind").notNull(),
    observedAt: text("observed_at").notNull(),
    confidence: real("confidence").notNull(),
    payload: text("payload", { mode: "json" }).$type<ObservationPayload | null>(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.snapshotId, t.observationId] }),
    idxKind: index("idx_graph_observations_kind").on(t.snapshotId, t.kind),
  }),
)

// ---------------------------------------------------------------------------
// DDL statements for initSchema()
//
// Mirrors the Drizzle defs above. Must be kept in sync manually until we
// add a drizzle-kit migration step. The snapshot-lifecycle tests in
// Phase 1 catch drift by doing an insert → select → value-equality check
// through the Drizzle query layer against a freshly-created database.
//
// Each entry is one statement. better-sqlite3's Database.exec() accepts
// either single or multi-statement strings; running them one at a time
// keeps error messages more actionable when a particular CREATE fails.
// ---------------------------------------------------------------------------

export const DDL_STATEMENTS: readonly string[] = [
  `PRAGMA foreign_keys = ON`,

  `CREATE TABLE IF NOT EXISTS graph_snapshots (
    snapshot_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_root   TEXT NOT NULL,
    compile_db_hash  TEXT NOT NULL,
    parser_version   TEXT NOT NULL,
    source_revision  TEXT,
    status           TEXT NOT NULL CHECK (status IN ('building', 'ready', 'failed')),
    created_at       TEXT NOT NULL,
    ready_at         TEXT,
    failed_at        TEXT,
    fail_reason      TEXT,
    fingerprint      TEXT NOT NULL,
    metadata         TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_graph_snapshots_ws_status
     ON graph_snapshots(workspace_root, status, snapshot_id DESC)`,

  `CREATE TABLE IF NOT EXISTS graph_nodes (
    snapshot_id     INTEGER NOT NULL REFERENCES graph_snapshots(snapshot_id) ON DELETE CASCADE,
    node_id         TEXT NOT NULL,
    canonical_name  TEXT NOT NULL,
    kind            TEXT NOT NULL,
    location        TEXT,
    payload         TEXT,
    PRIMARY KEY (snapshot_id, node_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_graph_nodes_ws_name
     ON graph_nodes(snapshot_id, canonical_name)`,
  `CREATE INDEX IF NOT EXISTS idx_graph_nodes_kind
     ON graph_nodes(snapshot_id, kind)`,

  `CREATE TABLE IF NOT EXISTS graph_edges (
    snapshot_id     INTEGER NOT NULL REFERENCES graph_snapshots(snapshot_id) ON DELETE CASCADE,
    edge_id         TEXT NOT NULL,
    edge_kind       TEXT NOT NULL,
    src_node_id     TEXT,
    dst_node_id     TEXT,
    confidence      REAL NOT NULL,
    derivation      TEXT NOT NULL,
    metadata        TEXT,
    PRIMARY KEY (snapshot_id, edge_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_graph_edges_src
     ON graph_edges(snapshot_id, src_node_id)`,
  `CREATE INDEX IF NOT EXISTS idx_graph_edges_dst
     ON graph_edges(snapshot_id, dst_node_id)`,
  `CREATE INDEX IF NOT EXISTS idx_graph_edges_kind
     ON graph_edges(snapshot_id, edge_kind)`,

  `CREATE TABLE IF NOT EXISTS graph_evidence (
    snapshot_id     INTEGER NOT NULL REFERENCES graph_snapshots(snapshot_id) ON DELETE CASCADE,
    evidence_id     TEXT NOT NULL,
    edge_id         TEXT,
    node_id         TEXT,
    source_kind     TEXT NOT NULL,
    location        TEXT,
    payload         TEXT,
    PRIMARY KEY (snapshot_id, evidence_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_graph_evidence_edge
     ON graph_evidence(snapshot_id, edge_id)`,
  `CREATE INDEX IF NOT EXISTS idx_graph_evidence_node
     ON graph_evidence(snapshot_id, node_id)`,

  `CREATE TABLE IF NOT EXISTS graph_observations (
    snapshot_id     INTEGER NOT NULL REFERENCES graph_snapshots(snapshot_id) ON DELETE CASCADE,
    observation_id  TEXT NOT NULL,
    node_id         TEXT,
    kind            TEXT NOT NULL,
    observed_at     TEXT NOT NULL,
    confidence      REAL NOT NULL,
    payload         TEXT,
    PRIMARY KEY (snapshot_id, observation_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_graph_observations_kind
     ON graph_observations(snapshot_id, kind)`,
]
