// file/outputs-scanner.ts
//
// PROVENANCE: cp'd from
// `instructkr-claude-code/src/utils/filePersistence/outputsScanner.ts`
// then adapted to opencode's idioms:
//
//   * dropped CLAUDE_CODE_ENVIRONMENT_KIND / `getEnvironmentKind()` —
//     opencode has no BYOC vs cloud distinction. The scanner is
//     environment-agnostic by design.
//   * dropped the Files API / TurnStartTime nominal type — replaced with
//     a plain `number` (epoch ms from `Date.now()`) so callers can use
//     `OutputsScanner.captureTurnStart()` or pass any timestamp.
//   * replaced `logForDebugging` with opencode's `Log` namespace.
//   * exported `captureTurnStart()` as a tiny helper so the API reads
//     symmetrically: capture, do work, scan-since.
//
// PURPOSE: opencode's "proactive file-state refresh" gap (gap-4).
// The Claude orchestrator uploaded modified files to a Files API; we
// have no equivalent and don't want one (notes-centric philosophy —
// see `claude-parity-ratchet/Constraints`). What we DO want is the
// pure scanner: given a turn-start timestamp and a directory, return
// every regular file under it whose mtime ≥ the timestamp. Use cases:
//
//   * Diff detection that's faster than re-running ripgrep.
//   * Cache invalidation for the read tool when an external editor
//     touches a file mid-session.
//   * Magic Docs auto-update triggers (gap-2-followup): figure out
//     which doc files need re-evaluation.
//   * Future: file-changed lifecycle hook (gap-1) batching.
//
// SECURITY: symlinks are skipped on BOTH the readdir pass and the
// stat pass. The double-check is intentional: a symlink can be
// created in the window between the two calls, so we have to test
// again at stat time.

import * as fs from "fs/promises"
import * as path from "path"
import { Log } from "@/foundation/util/log"

export namespace OutputsScanner {
  const log = Log.create({ service: "file.outputs-scanner" })

  /**
   * Epoch milliseconds — the moment a turn started. Use
   * `captureTurnStart()` at the beginning of work and pass the same
   * value to `findModifiedFiles()` afterwards.
   */
  export type TurnStartMs = number

  /**
   * Capture the current epoch-ms timestamp. Equivalent to `Date.now()`
   * but expressed as a named API call so the symmetry with
   * `findModifiedFiles(start, …)` is obvious at the call site.
   */
  export function captureTurnStart(): TurnStartMs {
    return Date.now()
  }

  /**
   * Recursively scan `dir` for regular files whose `mtimeMs ≥ since`.
   *
   * - Symlinks are skipped (security: avoid traversing out of `dir`).
   * - The directory is recursed in one `readdir({ recursive: true })`
   *   call so the syscall cost is O(1) regardless of nesting depth.
   * - `lstat` calls are issued in parallel via `Promise.all` to keep
   *   wall time bounded by the slowest filesystem call.
   * - Race-tolerant: files deleted or symlinked between the readdir
   *   and the stat are silently dropped, not raised as errors.
   * - Returns `[]` if `dir` does not exist or is unreadable, NOT a
   *   throw — the caller can scan an optional outputs directory
   *   without first checking for existence.
   */
  export async function findModifiedFiles(since: TurnStartMs, dir: string): Promise<string[]> {
    let entries: Awaited<ReturnType<typeof fs.readdir>>
    try {
      entries = await fs.readdir(dir, {
        withFileTypes: true,
        recursive: true,
      })
    } catch {
      // Directory doesn't exist or is not accessible — treat as empty.
      return []
    }

    // Filter to regular files (skip symlinks for security) and build
    // absolute paths. `entry.parentPath` is Node 20+; the fallback to
    // `entry.path` is for older runtimes.
    const filePaths: string[] = []
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      if (entry.isFile()) {
        const parentPath = getEntryParentPath(entry, dir)
        filePaths.push(path.join(parentPath, entry.name))
      }
    }

    if (filePaths.length === 0) {
      log.debug("no files in scanned directory", { dir })
      return []
    }

    // Parallel stat — wall time bounded by the slowest individual
    // filesystem call rather than the sum.
    const statResults = await Promise.all(
      filePaths.map(async (filePath) => {
        try {
          const stat = await fs.lstat(filePath)
          // Re-check symlink status: a regular file at readdir time
          // could have been replaced with a symlink before stat ran.
          if (stat.isSymbolicLink()) return null
          return { filePath, mtimeMs: stat.mtimeMs }
        } catch {
          // File deleted between readdir and stat — drop it.
          return null
        }
      }),
    )

    const modified: string[] = []
    for (const result of statResults) {
      if (result && result.mtimeMs >= since) {
        modified.push(result.filePath)
      }
    }

    log.debug("scanned outputs directory", {
      dir,
      total: filePaths.length,
      modified: modified.length,
    })

    return modified
  }

  /**
   * Same as `findModifiedFiles` but with an optional `filter` callback
   * that can drop entries after the scan. Useful for skipping ignored
   * paths (e.g. node_modules) without changing the core API.
   */
  export async function findModifiedFilesWith(
    since: TurnStartMs,
    dir: string,
    filter: (relativePath: string) => boolean,
  ): Promise<string[]> {
    const all = await findModifiedFiles(since, dir)
    return all.filter((p) => filter(path.relative(dir, p)))
  }

  // Type-narrow helpers — `entry.parentPath` is Node 20+, `entry.path`
  // is the older spelling. Both can be missing in some runtimes.
  function hasParentPath(entry: object): entry is { parentPath: string; name: string } {
    return "parentPath" in entry && typeof (entry as { parentPath: unknown }).parentPath === "string"
  }
  function hasPath(entry: object): entry is { path: string; name: string } {
    return "path" in entry && typeof (entry as { path: unknown }).path === "string"
  }
  function getEntryParentPath(entry: object, fallback: string): string {
    if (hasParentPath(entry)) return entry.parentPath
    if (hasPath(entry)) return entry.path
    return fallback
  }
}
