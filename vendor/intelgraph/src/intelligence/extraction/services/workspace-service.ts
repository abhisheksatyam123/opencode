/**
 * workspace-service.ts — workspace metadata and file traversal exposed via
 * ctx.workspace.
 *
 * Plugins use this to:
 *   - Walk the workspace looking for source files matching extensions
 *   - Read file contents (with an in-snapshot cache)
 *   - Discover compile_commands.json and read its entries
 *   - Apply project-specific file ranking (currently lifts the WLAN-aware
 *     rank from clangd-extraction-adapter.ts; will be made fully pluggable
 *     in Problem 2 when WLAN-specific knowledge moves out of src/)
 *
 * Why workspace-service is a service rather than free functions: each
 * snapshot has its own cache and its own ranking decisions. Putting state
 * on a per-snapshot service instance avoids global mutable state and lets
 * the runner construct one workspace service per ingest.
 */

import { existsSync, readFileSync, statSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { extname, join, resolve } from "node:path"

// ---------------------------------------------------------------------------
// File walking
// ---------------------------------------------------------------------------

const DEFAULT_C_EXTENSIONS = new Set([".c", ".h", ".cpp", ".cc", ".cxx", ".hpp"])

export interface WalkFilesOptions {
  /** Allowed file extensions (with leading dot). Defaults to C/C++ set. */
  extensions?: readonly string[]
  /** Max files returned. Defaults to 500. */
  limit?: number
  /**
   * Optional ranker. Lower returned numbers come first. Defaults to a
   * stable lexicographic order.
   */
  rank?: (filePath: string) => number
  /**
   * Subdirectory of the workspace root to start from. Defaults to the
   * workspace root.
   */
  startDir?: string
  /**
   * Skip directories whose name starts with a "." (the default), or pass
   * a custom predicate.
   */
  skipDir?: (dirName: string) => boolean
}

// ---------------------------------------------------------------------------
// Compile commands
// ---------------------------------------------------------------------------

export interface CompileCommandEntry {
  directory: string
  file: string
  command?: string
  arguments?: string[]
  output?: string
}

// ---------------------------------------------------------------------------
// Public service interface
// ---------------------------------------------------------------------------

export interface WorkspaceService {
  /** Absolute path to the workspace root. */
  readonly root: string

  /** True iff `${root}/compile_commands.json` exists. */
  readonly hasCompileCommands: boolean

  /**
   * Walk the workspace looking for source files. Honors the rank function
   * if provided; otherwise returns files in lexicographic order. Always
   * caps the result at the limit.
   */
  walkFiles(opts?: WalkFilesOptions): Promise<string[]>

  /**
   * Read a file with an in-service cache. The cache is bounded — large
   * files are passed through but not memoized. Returns undefined if the
   * file is unreadable.
   */
  readFile(filePath: string): string | undefined

  /**
   * Read and parse compile_commands.json. Returns an empty array if the
   * file is missing or malformed. Cached after first read.
   */
  compileCommands(): CompileCommandEntry[]
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const READ_CACHE_MAX_BYTES = 256 * 1024 // 256 KiB per file gets memoized

export class WorkspaceServiceImpl implements WorkspaceService {
  private readonly absoluteRoot: string
  private readonly readCache = new Map<string, string>()
  private compileCommandsCache: CompileCommandEntry[] | null = null

  constructor(workspaceRoot: string) {
    this.absoluteRoot = resolve(workspaceRoot)
  }

  get root(): string {
    return this.absoluteRoot
  }

  get hasCompileCommands(): boolean {
    return existsSync(join(this.absoluteRoot, "compile_commands.json"))
  }

  async walkFiles(opts: WalkFilesOptions = {}): Promise<string[]> {
    const exts = new Set(opts.extensions ?? DEFAULT_C_EXTENSIONS)
    const limit = opts.limit ?? 500
    const startDir = opts.startDir ?? this.absoluteRoot
    const skipDir = opts.skipDir ?? ((name: string) => name.startsWith("."))

    const out: string[] = []
    // Use a generous traversal cap to allow ranking to surface preferred
    // files; we slice to `limit` after sorting. The cap is bounded so
    // pathologically deep trees don't run forever.
    const traversalCap = Math.max(limit * 4, 2000)

    const walk = async (d: string): Promise<void> => {
      if (out.length >= traversalCap) return
      let entries
      try {
        entries = await readdir(d, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (out.length >= traversalCap) break
        const full = join(d, e.name)
        if (e.isDirectory()) {
          if (skipDir(e.name)) continue
          await walk(full)
        } else if (e.isFile() && exts.has(extname(e.name))) {
          out.push(full)
        }
      }
    }

    await walk(startDir)

    // Apply ranker (or stable lexicographic). Lower rank = earlier.
    if (opts.rank) {
      const ranker = opts.rank
      out.sort((a, b) => {
        const diff = ranker(a) - ranker(b)
        if (diff !== 0) return diff
        return a.localeCompare(b)
      })
    } else {
      out.sort((a, b) => a.localeCompare(b))
    }

    return out.slice(0, limit)
  }

  readFile(filePath: string): string | undefined {
    const cached = this.readCache.get(filePath)
    if (cached !== undefined) return cached
    let stat
    try {
      stat = statSync(filePath)
    } catch {
      return undefined
    }
    if (!stat.isFile()) return undefined
    let text: string
    try {
      text = readFileSync(filePath, "utf8")
    } catch {
      return undefined
    }
    if (stat.size <= READ_CACHE_MAX_BYTES) {
      this.readCache.set(filePath, text)
    }
    return text
  }

  compileCommands(): CompileCommandEntry[] {
    if (this.compileCommandsCache !== null) return this.compileCommandsCache
    const path = join(this.absoluteRoot, "compile_commands.json")
    if (!existsSync(path)) {
      this.compileCommandsCache = []
      return this.compileCommandsCache
    }
    try {
      const raw = readFileSync(path, "utf8")
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        this.compileCommandsCache = parsed as CompileCommandEntry[]
      } else {
        this.compileCommandsCache = []
      }
    } catch {
      this.compileCommandsCache = []
    }
    return this.compileCommandsCache
  }
}
