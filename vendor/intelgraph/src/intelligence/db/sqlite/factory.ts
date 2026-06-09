/**
 * factory.ts — composition root for the SQLite storage trio.
 *
 * Opens a better-sqlite3 database and wires up the three concrete
 * implementations that share the same handle: SqliteDbFoundation (snapshot
 * lifecycle), SqliteGraphStore (node/edge write sink + SymbolFinder), and
 * SqliteDbLookup (read path for the orchestrator).
 *
 * Why this exists: consumers used to `new SqliteDbFoundation(...)`
 * directly in every CLI entrypoint and in backend-factory.ts. That
 * scattered instantiation made it easy for a new consumer to forget one
 * of the three components or pass the wrong handle. Funneling through
 * this factory gives us:
 *   1. A single place where the SQLite trio is constructed.
 *   2. A contract-first gate: the CI lint step forbids bare
 *      `new SqliteDbFoundation()` anywhere except this file and tests.
 *   3. An obvious place to hang future cross-cutting concerns (WAL
 *      pragmas, connection pooling, metrics).
 */

import { openSqlite, type SqliteClient, type OpenSqliteOptions } from "./client.js"
import { SqliteDbFoundation } from "./foundation.js"
import { SqliteGraphStore } from "./graph-store.js"
import { SqliteDbLookup } from "./db-lookup.js"

export interface SqliteStoreConfig extends OpenSqliteOptions {}

export interface SqliteStore {
  /** Raw client handle. Only exposed for ad-hoc reads in CLI tools; new code should prefer the typed ports. */
  readonly client: SqliteClient
  readonly foundation: SqliteDbFoundation
  readonly sink: SqliteGraphStore
  readonly lookup: SqliteDbLookup
  /** Closes the underlying SQLite handle. Idempotent. */
  close(): void
}

/**
 * Construct the SQLite storage trio from a single configuration.
 *
 * The caller owns the lifecycle — call `close()` on the returned store
 * when done. Does NOT call `initSchema()`; consumers that need a fresh
 * schema should invoke `store.foundation.initSchema()` themselves.
 */
export function createSqliteStore(cfg: SqliteStoreConfig): SqliteStore {
  const client = openSqlite(cfg)
  const foundation = new SqliteDbFoundation(client.db, client.raw)
  const sink = new SqliteGraphStore(client.db)
  const lookup = new SqliteDbLookup(client.db, client.raw)
  return {
    client,
    foundation,
    sink,
    lookup,
    close: () => client.close(),
  }
}
