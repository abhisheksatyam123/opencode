/**
 * client.ts — SQLite + Drizzle client factory.
 *
 * One function opens a better-sqlite3 Database at a given path (or
 * `:memory:` for tests) and wraps it in a Drizzle BetterSQLite3Database
 * handle that the foundation, graph store, and lookup all share.
 *
 * Path semantics:
 *   - `:memory:` — ephemeral in-memory db (tests)
 *   - absolute path — exact file location
 *   - relative path — resolved against process.cwd()
 *   - missing parent directories are created automatically
 */

import { createRequire } from "node:module"
import type BetterSqlite3 from "better-sqlite3"
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import { mkdirSync } from "node:fs"
import { dirname, isAbsolute, resolve } from "node:path"
import * as schema from "./schema.js"

const requireModule = createRequire(import.meta.url)

export interface OpenSqliteOptions {
  /**
   * Path to the sqlite database file, or ":memory:" for an ephemeral
   * in-memory db. Relative paths are resolved against process.cwd().
   */
  path: string
  /**
   * If true, opens the database read-only. The db file must already
   * exist. Defaults to false.
   */
  readonly?: boolean
  /**
   * Log every SQL statement to console.error. Useful during plugin
   * development; off by default.
   */
  verbose?: boolean
}

export interface SqliteClient {
  /** The Drizzle handle consumers use for queries. */
  readonly db: BetterSQLite3Database<typeof schema>
  /** The underlying raw better-sqlite3 database, for lifecycle calls. */
  readonly raw: BetterSqlite3.Database
  /** Close the database. Idempotent. */
  close(): void
}

function isBunRuntime(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
}

export function openSqlite(opts: OpenSqliteOptions): SqliteClient {
  const isMemory = opts.path === ":memory:"
  const resolvedPath = isMemory ? ":memory:" : isAbsolute(opts.path) ? opts.path : resolve(process.cwd(), opts.path)

  if (!isMemory) {
    // Create parent directory on first use so the caller doesn't have
    // to remember (.intelgraph/intelligence.db requires the .intelgraph/
    // dir to exist first).
    try {
      mkdirSync(dirname(resolvedPath), { recursive: true })
    } catch {
      // already exists or unwritable — better-sqlite3 will surface the
      // real error when it tries to open the file
    }
  }

  const raw = isBunRuntime()
    ? (() => {
        const { Database } = requireModule("bun:sqlite") as typeof import("bun:sqlite")
        return new Database(
          resolvedPath,
          opts.readonly ? { readonly: true } : undefined,
        ) as unknown as BetterSqlite3.Database
      })()
    : (() => {
        const BetterSqlite3 = requireModule("better-sqlite3") as new (
          path: string,
          options?: { readonly?: boolean; verbose?: (message?: unknown, ...optionalParams: unknown[]) => void },
        ) => BetterSqlite3.Database
        return new BetterSqlite3(resolvedPath, {
          readonly: opts.readonly ?? false,
          verbose: opts.verbose ? console.error : undefined,
        })
      })()

  // Sensible defaults for a persistent workspace db. Bun's SQLite driver uses
  // exec() for PRAGMA statements; better-sqlite3 exposes pragma().
  const applyPragma = (statement: string) => {
    const candidate = raw as unknown as { pragma?: (sql: string) => unknown; exec?: (sql: string) => unknown }
    if (typeof candidate.pragma === "function") candidate.pragma(statement)
    else if (typeof candidate.exec === "function") candidate.exec(`PRAGMA ${statement}`)
  }
  if (!isMemory && !opts.readonly) {
    applyPragma("journal_mode = WAL")
    applyPragma("synchronous = NORMAL")
    applyPragma("foreign_keys = ON")
  } else if (isMemory) {
    applyPragma("foreign_keys = ON")
  }

  const db = isBunRuntime()
    ? (() => {
        const { drizzle } = requireModule("drizzle-orm/bun-sqlite") as typeof import("drizzle-orm/bun-sqlite")
        return drizzle({ client: raw as never, schema }) as unknown as BetterSQLite3Database<typeof schema>
      })()
    : (() => {
        const { drizzle } = requireModule("drizzle-orm/better-sqlite3") as { drizzle: (...args: unknown[]) => unknown }
        return drizzle(raw, { schema }) as BetterSQLite3Database<typeof schema>
      })()

  let closed = false
  return {
    db,
    raw,
    close() {
      if (closed) return
      closed = true
      raw.close()
    },
  }
}
