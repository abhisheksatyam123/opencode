// util/binary.ts
//
// Cached binary-on-PATH probe (parity gap-21 + gap-21-followup-1).
//
// PROVENANCE: cp'd from
// `instructkr-claude-code/src/utils/binaryCheck.ts` then adapted.
// Originally exported only `Binary.has(cmd): Promise<boolean>`. The
// followup-1 iteration extended the API with `Binary.path(cmd):
// string | null` (the new sync primitive that returns the resolved
// path) and made `has()` a derived wrapper so the cache stores the
// path itself, not just an existence boolean.
//
// PURPOSE: opencode probes for optional binaries (gopls, rust-analyzer,
// pylsp, ripgrep, fd, fzf, ast-grep, ...) at LSP startup, in shell
// command resolution, and in build helpers. Without a cache, every
// probe shells out to PATH lookup; with this cache the second-and-
// later probes are O(1).
//
// API surface:
//   * `Binary.path(cmd): string | null`     — sync, returns the
//     resolved path or null. The new primitive (gap-21-followup-1).
//   * `Binary.has(cmd): Promise<boolean>`   — async wrapper around
//     `path()`, kept for the original gap-21 contract.
//   * `Binary.clearCache()`                 — wipe cache, used by
//     tests and by callers that just installed a binary.
//   * `Binary.cacheSnapshot()`              — defensive copy for
//     debugging. Now returns `Map<string, string | null>` to
//     reflect the path-cache change.
//
// `Binary.path()` is intentionally case-sensitive on Linux/macOS and
// case-insensitive on Windows — `Bun.which` already handles the
// platform-specific behaviour, this module just memoizes the result.

import { Log } from "./log"

export namespace Binary {
  const log = Log.create({ service: "util.binary" })

  // Process-lived cache. Stores the resolved path string for found
  // binaries and `null` for confirmed-not-found. The two states
  // (`undefined` from `cache.get()` vs explicit `null`) are how
  // `path()` distinguishes "never probed" from "probed and missing".
  const cache = new Map<string, string | null>()

  /**
   * Resolve `command` to its absolute path on PATH, returning `null`
   * if the binary is not found. Result is memoized — the second call
   * for the same command is O(1) and shares the cache with `has()`.
   *
   * Edge cases:
   *   * empty / whitespace-only `command` → returns null (does not
   *     consult PATH and does not pollute the cache)
   *   * leading/trailing whitespace is trimmed before lookup; the
   *     cache key is the trimmed form
   *   * `Bun.which` returning undefined is normalized to null
   *
   * The path is whatever `Bun.which` returns — typically an absolute
   * path on Linux/macOS, with platform-specific quirks on Windows
   * (e.g. case-insensitive matching, .EXE suffix handling).
   *
   * Synchronous because `Bun.which` itself is sync; this lets sync
   * call sites like `Shell.preferred()` migrate without rippling
   * async/await through the codebase.
   */
  export function path(command: string): string | null {
    if (!command || !command.trim()) {
      log.debug("empty command provided", { command })
      return null
    }

    const trimmed = command.trim()
    const cached = cache.get(trimmed)
    if (cached !== undefined) {
      return cached
    }

    let resolved: string | null = null
    try {
      const found = Bun.which(trimmed)
      resolved = found ?? null
    } catch {
      resolved = null
    }

    cache.set(trimmed, resolved)
    log.debug("probed binary", { command: trimmed, exists: resolved !== null })
    return resolved
  }

  /**
   * Check whether `command` is installed and resolvable on PATH.
   * Derived from `path()` so both share the same cache.
   *
   * Async wrapper preserved for the original gap-21 contract; new
   * call sites should prefer the sync `path()` primitive when they
   * just need a boolean check (`Binary.path(cmd) !== null`).
   */
  export async function has(command: string): Promise<boolean> {
    return path(command) !== null
  }

  /**
   * Clear the cache. Useful for tests that need a fresh probe, or
   * for callers that just installed a binary and want subsequent
   * probes to re-check PATH.
   */
  export function clearCache(): void {
    cache.clear()
  }

  /**
   * Snapshot of the cache for debugging. Returns a copy — mutations
   * to the returned Map do not affect the underlying cache. The
   * value is the resolved path string for found binaries, `null`
   * for confirmed-not-found.
   */
  export function cacheSnapshot(): Map<string, string | null> {
    return new Map(cache)
  }
}
