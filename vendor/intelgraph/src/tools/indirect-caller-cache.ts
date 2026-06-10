/**
 * indirect-caller-cache.ts — File-based cache for indirect-caller results.
 *
 * Stores computed IndirectCallerGraph results keyed by SHA-256 of the query
 * (file + line + character). Evidence file hashes are stored alongside for
 * staleness detection.
 */

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync, rmSync } from "node:fs"
import path from "node:path"

const CACHE_SCHEMA_VERSION = "2"

export interface CachedIndirectCallers {
  schemaVersion: string
  /** SHA-256 of the query params (file + line + character). */
  cacheKey: string
  /** ISO timestamp when cached. */
  cachedAt: string
  /** Evidence file hashes for staleness detection. */
  hashManifest: Record<string, string>
  /** The computed result. */
  result: any
}

function cacheDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".intelgraph-indirect-caller-cache")
}

function cacheFile(workspaceRoot: string, cacheKey: string): string {
  return path.join(cacheDir(workspaceRoot), `${cacheKey}.json`)
}

function safeName(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]+/g, "_")
}

/**
 * Compute a cache key from query parameters.
 */
export function computeCacheKey(file: string, line: number, character: number): string {
  const raw = `${file}:${line}:${character}`
  return createHash("sha256").update(raw).digest("hex")
}

/**
 * Compute a file hash for staleness detection.
 */
export function computeFileHash(filePath: string): string | null {
  try {
    const buf = readFileSync(filePath)
    return createHash("sha256").update(buf).digest("hex")
  } catch {
    return null
  }
}

/**
 * Read a cached result. Returns null if not found or stale.
 */
export function readCache(
  workspaceRoot: string,
  cacheKey: string,
  evidenceFiles: string[],
): CachedIndirectCallers | null {
  const fp = cacheFile(workspaceRoot, cacheKey)
  if (!existsSync(fp)) return null

  try {
    const parsed = JSON.parse(readFileSync(fp, "utf8")) as CachedIndirectCallers
    if (!parsed || parsed.schemaVersion !== CACHE_SCHEMA_VERSION) return null

    // Check evidence file hashes for staleness
    for (const file of evidenceFiles) {
      const currentHash = computeFileHash(file)
      const cachedHash = parsed.hashManifest[file]
      if (!currentHash || !cachedHash || currentHash !== cachedHash) {
        return null // stale
      }
    }

    return parsed
  } catch {
    return null
  }
}

/**
 * Write a result to the cache.
 */
export function writeCache(workspaceRoot: string, cacheKey: string, result: any, evidenceFiles: string[]): void {
  const dir = cacheDir(workspaceRoot)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const hashManifest: Record<string, string> = {}
  for (const file of evidenceFiles) {
    const hash = computeFileHash(file)
    if (hash) hashManifest[file] = hash
  }

  const entry: CachedIndirectCallers = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    cacheKey,
    cachedAt: new Date().toISOString(),
    hashManifest,
    result,
  }

  const fp = cacheFile(workspaceRoot, cacheKey)
  writeFileSync(fp, JSON.stringify(entry, null, 2) + "\n")
}

/**
 * Clear all cached results for a workspace.
 */
export function clearCache(workspaceRoot: string): void {
  const dir = cacheDir(workspaceRoot)
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ── IIndirectCallerCache binding ─────────────────────────────────────────────
//
// Real-implementation binding for the port declared in ./ports.ts.
// This is the filesystem-backed cache. Tests use FakeIndirectCallerCache.

import type { IIndirectCallerCache } from "./ports.js"

export const indirectCallerCache: IIndirectCallerCache = {
  computeKey: computeCacheKey,
  read: readCache,
  write: writeCache,
  clear: clearCache,
}
