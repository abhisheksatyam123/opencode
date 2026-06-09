import { createHash } from "node:crypto"
import type { IIndirectCallerCache } from "../ports.js"
import type { CachedIndirectCallers } from "../indirect-caller-cache.js"

interface FakeEntry {
  entry: CachedIndirectCallers
  /** Simulated per-file hashes at write time, keyed by file path. */
  fileHashes: Record<string, string>
}

/**
 * In-memory IIndirectCallerCache. Staleness is decided from a mock
 * file-hash map: if any evidence file's hash in `mockHashes` differs
 * from the hash recorded at write time, `read()` returns null.
 *
 * Tests that want to simulate a "fresh" cache leave `mockHashes` empty
 * and pass the same `evidenceFiles` list to both write() and read().
 * Tests that want to simulate "stale" can call `invalidate(file)` to
 * bump the hash.
 */
export class FakeIndirectCallerCache implements IIndirectCallerCache {
  private store = new Map<string, FakeEntry>()
  private mockHashes = new Map<string, string>()
  readonly calls: Array<{ kind: string; workspaceRoot?: string; cacheKey?: string }> = []

  computeKey(file: string, line: number, character: number): string {
    return createHash("sha256").update(`${file}:${line}:${character}`).digest("hex")
  }

  read(workspaceRoot: string, cacheKey: string, evidenceFiles: string[]): CachedIndirectCallers | null {
    this.calls.push({ kind: "read", workspaceRoot, cacheKey })
    const key = `${workspaceRoot}::${cacheKey}`
    const entry = this.store.get(key)
    if (!entry) return null

    for (const file of evidenceFiles) {
      const current = this.mockHashes.get(file) ?? entry.fileHashes[file]
      const recorded = entry.fileHashes[file]
      if (!current || !recorded || current !== recorded) return null
    }
    return entry.entry
  }

  write(workspaceRoot: string, cacheKey: string, result: unknown, evidenceFiles: string[]): void {
    this.calls.push({ kind: "write", workspaceRoot, cacheKey })
    const key = `${workspaceRoot}::${cacheKey}`
    const fileHashes: Record<string, string> = {}
    for (const file of evidenceFiles) {
      // Generate a deterministic synthetic hash based on the file path at write time.
      fileHashes[file] = this.mockHashes.get(file) ?? createHash("sha256").update(file).digest("hex")
      // Lock the current value as the "write-time" hash.
      this.mockHashes.set(file, fileHashes[file])
    }
    this.store.set(key, {
      entry: {
        schemaVersion: "2",
        cacheKey,
        cachedAt: new Date().toISOString(),
        hashManifest: fileHashes,
        result,
      },
      fileHashes,
    })
  }

  clear(workspaceRoot: string): void {
    this.calls.push({ kind: "clear", workspaceRoot })
    for (const key of this.store.keys()) {
      if (key.startsWith(`${workspaceRoot}::`)) this.store.delete(key)
    }
  }

  // ---- Test hooks (not part of IIndirectCallerCache) ----

  /** Simulate a file changing by changing its mock hash. Causes future `read()`s to return null for cached entries that depended on this file. */
  invalidate(file: string): void {
    this.mockHashes.set(file, createHash("sha256").update(`${file}:${Date.now()}:${Math.random()}`).digest("hex"))
  }
}
