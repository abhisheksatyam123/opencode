import { type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import { type SQLiteTransaction } from "drizzle-orm/sqlite-core"
export * from "drizzle-orm"
import { Context } from "@/foundation/effect/context"
import { lazy } from "@/foundation/util/lazy"
import { Log } from "@/foundation/util/log"
import { NamedError } from "@opencode-ai/util/error"
import z from "zod"
import path from "path"
import { readFileSync, readdirSync, existsSync, mkdirSync } from "fs"
import { InstanceState } from "@/foundation/effect/instance-state"
import { iife } from "@/foundation/util/iife"
import { init } from "#db"
import { vaultPath } from "@/foundation/notes-root"

declare const OPENCODE_MIGRATIONS: { sql: string; timestamp: number; name: string }[] | undefined

type GlobalChannel = typeof globalThis & { OPENCODE_CHANNEL?: unknown }

function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

const channel = (globalThis as GlobalChannel).OPENCODE_CHANNEL
const CHANNEL = typeof channel === "string" ? channel : "local"
const OPENCODE_DB = process.env["OPENCODE_DB"]
const OPENCODE_DISABLE_CHANNEL_DB = truthy("OPENCODE_DISABLE_CHANNEL_DB")
const OPENCODE_SKIP_MIGRATIONS = truthy("OPENCODE_SKIP_MIGRATIONS")

export const NotFoundError = NamedError.create(
  "NotFoundError",
  z.object({
    message: z.string(),
  }),
)

const log = lazy(() => Log.create({ service: "db" }))

export namespace Database {
  // -----------------------------------------------------------------------
  // Database files live under the vault state directory; this is path relocation only.
  //
  // The session SQLite now lives under `<vault>/state/session/` rather than
  // `<vault>/state/data/`, satisfying the migration table in
  // [[specification/contract/vault-as-sole-filesystem#migration-of-existing-paths]].
  //
  // Per-session_id splitting (`<vault>/state/session/<id>/session.db`) is
  // deferred to leaf I0.3b — the schema currently mixes session-scoped and
  // cross-session tables (Account/Project/Workspace) and ~50 Database.use
  // call sites assume a process-wide singleton; partitioning is a multi-leaf
  // refactor. Until then this remains a single DB, just relocated.
  // -----------------------------------------------------------------------

  export function getChannelPath() {
    if (["latest", "beta"].includes(CHANNEL) || OPENCODE_DISABLE_CHANNEL_DB)
      return vaultPath.state("session", "session.db")
    const safe = CHANNEL.replace(/[^a-zA-Z0-9._-]/g, "-")
    return vaultPath.state("session", `session-${safe}.db`)
  }

  export const Path = iife(() => {
    if (OPENCODE_DB) {
      if (OPENCODE_DB === ":memory:" || path.isAbsolute(OPENCODE_DB)) return OPENCODE_DB
      return vaultPath.state("session", OPENCODE_DB)
    }
    return getChannelPath()
  })

  export type Transaction = SQLiteTransaction<"sync", void>

  type Client = SQLiteBunDatabase

  type Journal = { sql: string; timestamp: number; name: string }[]

  function time(tag: string) {
    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(tag)
    if (!match) return 0
    return Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6]),
    )
  }

  function migrations(dir: string): Journal {
    const dirs = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)

    const sql = dirs
      .map((name) => {
        const file = path.join(dir, name, "migration.sql")
        if (!existsSync(file)) return
        return {
          sql: readFileSync(file, "utf-8"),
          timestamp: time(name),
          name,
        }
      })
      .filter(Boolean) as Journal

    return sql.sort((a, b) => a.timestamp - b.timestamp)
  }

  export const Client = lazy(() => {
    log().info("opening database", { path: Path })

    // Ensure the parent directory exists. With I0.3 the DB is under
    // `<vault>/state/session/` which is created on demand per
    // vault-as-sole-filesystem invariant I3 (empty vault is bootable).
    if (Path !== ":memory:") {
      mkdirSync(path.dirname(Path), { recursive: true })
    }

    const db = init(Path)

    db.run("PRAGMA journal_mode = WAL")
    db.run("PRAGMA synchronous = NORMAL")
    db.run("PRAGMA busy_timeout = 5000")
    db.run("PRAGMA cache_size = -64000")
    db.run("PRAGMA foreign_keys = ON")
    db.run("PRAGMA wal_checkpoint(PASSIVE)")

    // Apply schema migrations
    const entries =
      typeof OPENCODE_MIGRATIONS !== "undefined"
        ? OPENCODE_MIGRATIONS
        : migrations(path.join(import.meta.dirname, "../../migration"))
    if (entries.length > 0) {
      log().info("applying migrations", {
        count: entries.length,
        mode: typeof OPENCODE_MIGRATIONS !== "undefined" ? "bundled" : "dev",
      })
      if (OPENCODE_SKIP_MIGRATIONS) {
        for (const item of entries) {
          item.sql = "select 1;"
        }
      }
      migrate(db, entries)
    }

    return db
  })

  export function close() {
    Client().$client.close()
    Client.reset()
  }

  export type TxOrDb = Transaction | Client

  const ctx = Context.create<{
    tx: TxOrDb
    effects: (() => void | Promise<void>)[]
  }>("database")

  export function use<T>(callback: (trx: TxOrDb) => T): T {
    try {
      return callback(ctx.use().tx)
    } catch (err) {
      if (err instanceof Context.NotFound) {
        const effects: (() => void | Promise<void>)[] = []
        const result = ctx.provide({ effects, tx: Client() }, () => callback(Client()))
        for (const effect of effects) effect()
        return result
      }
      throw err
    }
  }

  export function effect(fn: () => any | Promise<any>) {
    const bound = InstanceState.bind(fn)
    try {
      ctx.use().effects.push(bound)
    } catch {
      bound()
    }
  }

  type NotPromise<T> = T extends Promise<any> ? never : T

  export function transaction<T>(
    callback: (tx: TxOrDb) => NotPromise<T>,
    options?: {
      behavior?: "deferred" | "immediate" | "exclusive"
    },
  ): NotPromise<T> {
    try {
      return callback(ctx.use().tx)
    } catch (err) {
      if (err instanceof Context.NotFound) {
        const effects: (() => void | Promise<void>)[] = []
        const txCallback = InstanceState.bind((tx: TxOrDb) => ctx.provide({ tx, effects }, () => callback(tx)))
        const result = Client().transaction(txCallback, { behavior: options?.behavior })
        for (const effect of effects) effect()
        return result as NotPromise<T>
      }
      throw err
    }
  }
}
