// vault-as-sole-filesystem garbage collection (Stage 0.5, leaf I0.5)
// -------------------------------------------------------------------------
// Authoritative contract: project/software/opencode/specification/contract/
//   vault-as-sole-filesystem.md §garbage-collection
//
// Boot sweep + opportunistic 6h interval. Six rules from the contract:
//
//   1. tmp/<sessionId>/         purge when session_id ∉ state/session/ index
//   2. cache/webfetch/          purge entries older than cfg.cache.webfetch.ttl_days (30)
//   3. cache/lsp/<projectHash>/ purge when projectHash no longer matches any tracked project
//   4. cache/federation/<src>/  purge when cfg.federation.<kind>.urls no longer references src
//   5. log/<kind>/<day>.log     purge when mtime > cfg.log.retain_days (30)
//   6. state/session/<id>/      NEVER auto-purged (user-driven via `opencode session prune`)
//
// Current scope (Stage 0.5):
//   - Rules 1 + 5 implemented (tmp by session_id, log by retain_days).
//   - Rules 2/3/4 stub via the `cachePredicates` registry — providers will
//     register predicates when those subtrees gain producers (per Provider
//     obligation P2: "every new cache/<kind>/ MUST register a GC predicate").
//   - Rule 6 enforced by absence: state/session/ is never enumerated here.
//
// Visibility: every purge logs `{ kind, path, bytes_freed }` to the engine
// log per contract. Errors collected, never thrown — engine boot survives
// GC failure.
// -------------------------------------------------------------------------

import path from "path"
import { existsSync, readdirSync, rmSync, statSync } from "fs"
import { Log } from "@/foundation/util/log"
import { vaultPath } from "@/foundation/notes-root"

export namespace Gc {
  const log = Log.create({ service: "gc" })

  // ---- Defaults (will move to atomic/policy/ in Stage 2) ----------------

  const DEFAULT_LOG_RETAIN_DAYS = 30
  const DEFAULT_WEBFETCH_TTL_DAYS = 30
  const DAY_MS = 24 * 60 * 60 * 1000

  /** 6 hour cadence per §Garbage collection. */
  export const INTERVAL_MS = 6 * 60 * 60 * 1000

  // ---- Types ------------------------------------------------------------

  export type Trigger = "boot" | "interval" | "manual"

  export interface PurgeRecord {
    kind: string
    path: string
    bytes_freed: number
  }

  export interface Stats {
    trigger: Trigger
    purged: PurgeRecord[]
    skipped: number
    errors: string[]
    /** Sum of `purged[].bytes_freed`; surfaced for tests + ops dashboards. */
    total_bytes_freed: number
  }

  /**
   * Predicate: given the basename of a `cache/<kind>/<entry>` directory,
   * return true if the entry is eligible for purge. Registered by the
   * subtree's producer code (Provider obligation P2).
   */
  export type CachePredicate = (entry: string, fullPath: string, mtime: number) => boolean

  // ---- Cache predicate registry ----------------------------------------

  const cachePredicates = new Map<string, CachePredicate>()

  /** Register a GC predicate for `cache/<kind>/`. Last writer wins. */
  export function registerCachePredicate(kind: string, predicate: CachePredicate): void {
    cachePredicates.set(kind, predicate)
  }

  /** Test helper — drop all registered predicates. */
  export function clearCachePredicates(): void {
    cachePredicates.clear()
  }

  // ---- Options ----------------------------------------------------------

  export interface Options {
    trigger?: Trigger
    /**
     * Snapshot of session ids currently live in `state/session/`. When
     * omitted, the tmp sweep skips entries (conservative — never delete
     * without proof of liveness). Boot caller injects from the Database
     * after JsonMigration completes; tests inject directly.
     */
    activeSessionIds?: Set<string> | string[]
    /** Override for log-retain (in days). Default 30. */
    logRetainDays?: number
    /** Override for webfetch ttl (in days). Default 30. */
    webfetchTtlDays?: number
    /** Override "now" (epoch ms) — used by tests for deterministic mtimes. */
    now?: number
  }

  // ---- Helpers ----------------------------------------------------------

  function dirSizeBytes(dir: string): number {
    let total = 0
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return 0
    }
    for (const name of entries) {
      const full = path.join(dir, name)
      try {
        const s = statSync(full)
        if (s.isFile()) total += s.size
        else if (s.isDirectory()) total += dirSizeBytes(full)
      } catch {
        // entry vanished mid-walk; ignore.
      }
    }
    return total
  }

  function rmTree(target: string, stats: Stats, kind: string): void {
    try {
      const bytes = dirSizeBytes(target)
      rmSync(target, { recursive: true, force: true })
      stats.purged.push({ kind, path: target, bytes_freed: bytes })
      stats.total_bytes_freed += bytes
      log.info("purged", { kind, path: target, bytes_freed: bytes })
    } catch (e) {
      stats.errors.push(`rm ${kind} ${target} — ${(e as Error).message}`)
    }
  }

  function rmFile(target: string, stats: Stats, kind: string): void {
    try {
      const s = statSync(target)
      const bytes = s.size
      rmSync(target, { force: true })
      stats.purged.push({ kind, path: target, bytes_freed: bytes })
      stats.total_bytes_freed += bytes
      log.info("purged", { kind, path: target, bytes_freed: bytes })
    } catch (e) {
      stats.errors.push(`rm ${kind} ${target} — ${(e as Error).message}`)
    }
  }

  // ---- Sweepers ---------------------------------------------------------

  /**
   * Rule 1: `tmp/<sessionId>/` purged when session_id ∉ active set.
   * Conservative: when caller does NOT supply `activeSessionIds`, the sweep
   * is skipped entirely (we never delete without proof of liveness).
   */
  function sweepTmp(stats: Stats, opts: Options): void {
    const root = vaultPath.tmpRoot()
    if (!existsSync(root)) return
    if (!opts.activeSessionIds) {
      log.info("skip tmp sweep — no activeSessionIds provided")
      return
    }
    const live = opts.activeSessionIds instanceof Set ? opts.activeSessionIds : new Set(opts.activeSessionIds)

    let entries: string[]
    try {
      entries = readdirSync(root)
    } catch (e) {
      stats.errors.push(`readdir tmp/ — ${(e as Error).message}`)
      return
    }
    for (const sid of entries) {
      if (live.has(sid)) {
        stats.skipped++
        continue
      }
      rmTree(path.join(root, sid), stats, "tmp")
    }
  }

  /**
   * Rule 5: `log/<kind>/<day>.log` purged when mtime older than retainDays.
   * Walks every `log/<kind>/` subdir; only files matching `*.log` are touched.
   */
  function sweepLog(stats: Stats, opts: Options): void {
    const root = path.join(vaultPath.root(), "log")
    if (!existsSync(root)) return

    const retainDays = opts.logRetainDays ?? DEFAULT_LOG_RETAIN_DAYS
    const now = opts.now ?? Date.now()
    const cutoff = now - retainDays * DAY_MS

    let kinds: string[]
    try {
      kinds = readdirSync(root)
    } catch (e) {
      stats.errors.push(`readdir log/ — ${(e as Error).message}`)
      return
    }

    for (const kind of kinds) {
      const kindDir = path.join(root, kind)
      let files: string[]
      try {
        const s = statSync(kindDir)
        if (!s.isDirectory()) continue
        files = readdirSync(kindDir)
      } catch (e) {
        stats.errors.push(`readdir log/${kind}/ — ${(e as Error).message}`)
        continue
      }
      for (const name of files) {
        if (!name.endsWith(".log")) continue
        const full = path.join(kindDir, name)
        try {
          const s = statSync(full)
          if (!s.isFile()) continue
          if (s.mtimeMs < cutoff) {
            rmFile(full, stats, "log")
          } else {
            stats.skipped++
          }
        } catch (e) {
          stats.errors.push(`stat log/${kind}/${name} — ${(e as Error).message}`)
        }
      }
    }
  }

  /**
   * Rules 2-4: `cache/<kind>/<entry>/` — delegated to predicates registered
   * via `registerCachePredicate`. A `cache/<kind>/` subtree without a
   * predicate is left alone (operator runs `opencode vault prune <kind>`
   * manually per Provider obligation P2).
   */
  function sweepCache(stats: Stats, opts: Options): void {
    const root = path.join(vaultPath.root(), "cache")
    if (!existsSync(root)) return

    let kinds: string[]
    try {
      kinds = readdirSync(root)
    } catch (e) {
      stats.errors.push(`readdir cache/ — ${(e as Error).message}`)
      return
    }

    for (const kind of kinds) {
      const predicate = cachePredicates.get(kind)
      if (!predicate) continue

      const kindDir = path.join(root, kind)
      let entries: string[]
      try {
        const s = statSync(kindDir)
        if (!s.isDirectory()) continue
        entries = readdirSync(kindDir)
      } catch (e) {
        stats.errors.push(`readdir cache/${kind}/ — ${(e as Error).message}`)
        continue
      }
      for (const name of entries) {
        const full = path.join(kindDir, name)
        let mtimeMs = 0
        let isFile = false
        try {
          const s = statSync(full)
          mtimeMs = s.mtimeMs
          isFile = s.isFile()
        } catch (e) {
          stats.errors.push(`stat cache/${kind}/${name} — ${(e as Error).message}`)
          continue
        }
        let evict = false
        try {
          evict = predicate(name, full, mtimeMs)
        } catch (e) {
          stats.errors.push(`predicate cache/${kind} — ${(e as Error).message}`)
          continue
        }
        if (!evict) {
          stats.skipped++
          continue
        }
        if (isFile) rmFile(full, stats, `cache/${kind}`)
        else rmTree(full, stats, `cache/${kind}`)
      }
    }

    // Surface `webfetchTtlDays` to predicates that look it up via closure.
    void opts.webfetchTtlDays
    void DEFAULT_WEBFETCH_TTL_DAYS
  }

  // ---- Public API -------------------------------------------------------

  /**
   * Run all GC sweepers. Synchronous, fast, never throws. Returns counters
   * + non-fatal errors. Engine boot survives GC failure unconditionally.
   */
  export function run(opts: Options = {}): Stats {
    const trigger: Trigger = opts.trigger ?? "manual"
    const stats: Stats = {
      trigger,
      purged: [],
      skipped: 0,
      errors: [],
      total_bytes_freed: 0,
    }

    sweepTmp(stats, opts)
    sweepLog(stats, opts)
    sweepCache(stats, opts)

    if (stats.purged.length > 0 || stats.errors.length > 0) {
      log.info("gc complete", {
        trigger,
        purged: stats.purged.length,
        bytes_freed: stats.total_bytes_freed,
        skipped: stats.skipped,
        errors: stats.errors.length,
      })
    }
    return stats
  }

  // ---- Interval scheduler ----------------------------------------------

  let timer: ReturnType<typeof setInterval> | null = null

  /**
   * Start the 6h opportunistic GC. Idempotent — starting twice replaces
   * the prior interval. Engine calls this once after boot Gc.run completes.
   * The provider for `activeSessionIds` is invoked on each tick so the
   * snapshot stays fresh.
   */
  export function startInterval(provider: () => Options): void {
    stopInterval()
    timer = setInterval(() => {
      try {
        run({ ...provider(), trigger: "interval" })
      } catch (e) {
        log.error("interval tick failed", { e: (e as Error).message })
      }
    }, INTERVAL_MS)
    // Don't keep the event loop alive solely for GC.
    timer?.unref?.()
  }

  export function stopInterval(): void {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }
}
