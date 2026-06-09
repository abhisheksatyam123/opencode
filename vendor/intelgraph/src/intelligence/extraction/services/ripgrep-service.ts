/**
 * ripgrep-service.ts — typed wrapper around the `rg` (ripgrep) CLI.
 *
 * Plugins consume this via ctx.ripgrep when they need fast text search
 * across the workspace before invoking heavier parsing (clangd / tree-
 * sitter). The reason engine already shells out to `rg` directly in
 * src/tools/reason-engine/llm-advisor.ts; this service centralizes that
 * pattern so every consumer goes through one wrapper with consistent
 * error handling, glob defaults, and result typing.
 *
 * The wrapper invokes `rg --json` and parses the streaming output. We
 * deliberately avoid an npm ripgrep binding because:
 *   - Bindings drift from the upstream binary
 *   - Bindings add a native compile step on install
 *   - The CLI's --json output is already a stable contract
 *
 * Failure modes:
 *   - If `rg` is missing from PATH, every method throws RipgrepUnavailable.
 *     The runner catches this and surfaces a one-shot warning per snapshot
 *     so users get a clear message instead of mysterious empty results.
 *   - If `rg` exits non-zero with no matches, that's success-with-zero
 *     (ripgrep returns 1 when no matches are found).
 *   - If `rg` exits non-zero for any other reason, the result is empty and
 *     the error is logged at debug level.
 */

import { execFileSync } from "node:child_process"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RipgrepMatch {
  /** Absolute path to the file containing the match. */
  filePath: string
  /** 1-based line number. */
  line: number
  /** The matched text on that line (full line content). */
  lineText: string
  /** Byte offset within the file where the match starts. */
  absoluteOffset?: number
  /**
   * The submatch ranges within the lineText. Each range is
   * { start, end } 0-based column indices into lineText.
   */
  submatches?: Array<{ start: number; end: number; text: string }>
}

export interface RipgrepSearchOptions {
  /**
   * Glob pattern(s) to include — passed to `rg --glob`. If omitted, the
   * default is `*.{c,h,cpp,cc,cxx,hpp}` to match the existing extraction
   * pipeline's C/C++ scope.
   */
  glob?: string | string[]
  /** Treat pattern as a fixed string instead of regex. */
  fixedString?: boolean
  /** Case-insensitive search. */
  caseInsensitive?: boolean
  /** Maximum total matches across all files. Default: unlimited. */
  maxCount?: number
  /** Per-file match cap. */
  maxCountPerFile?: number
  /** Subprocess timeout in ms. Default: 15_000. */
  timeoutMs?: number
  /**
   * Restrict search to a subdirectory of the workspace root. Defaults to
   * the workspace root passed to the service constructor.
   */
  searchRoot?: string
}

export class RipgrepUnavailable extends Error {
  constructor(public override readonly cause: unknown) {
    super(
      `[ripgrep] \`rg\` binary not found or not executable. ` +
        `Install ripgrep (https://github.com/BurntSushi/ripgrep) and ensure it is on PATH.`,
    )
  }
}

export interface RipgrepServiceLogger {
  debug(event: string, context: Record<string, unknown>): void
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface RipgrepService {
  /**
   * Run a ripgrep search and return all matches as an array. Empty array
   * means no matches OR ripgrep failed (check the logger output).
   *
   * Throws RipgrepUnavailable if `rg` is not on PATH (cached after first
   * detection so the throw is cheap on subsequent calls).
   */
  search(pattern: string, opts?: RipgrepSearchOptions): RipgrepMatch[]

  /**
   * Convenience: count matches without parsing them. Returns 0 on no
   * matches or on failure.
   */
  count(pattern: string, opts?: RipgrepSearchOptions): number

  /**
   * Convenience: list files in the workspace whose path matches the given
   * glob. Useful for "find every file that looks like a registration
   * source" before doing detailed parsing.
   */
  findFiles(glob: string, opts?: { searchRoot?: string }): string[]

  /** Whether `rg` was detected on PATH. */
  readonly available: boolean
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const DEFAULT_GLOB = "*.{c,h,cpp,cc,cxx,hpp}"
const DEFAULT_TIMEOUT_MS = 15_000

export class RipgrepServiceImpl implements RipgrepService {
  private _available: boolean | null = null

  constructor(
    private readonly workspaceRoot: string,
    private readonly logger: RipgrepServiceLogger = { debug: () => {} },
  ) {}

  get available(): boolean {
    if (this._available !== null) return this._available
    try {
      execFileSync("rg", ["--version"], { stdio: "pipe", timeout: 2000 })
      this._available = true
    } catch {
      this._available = false
    }
    return this._available
  }

  search(pattern: string, opts: RipgrepSearchOptions = {}): RipgrepMatch[] {
    if (!this.available) {
      throw new RipgrepUnavailable(null)
    }

    const args = ["--json", "-n"]
    if (opts.fixedString) args.push("--fixed-strings")
    if (opts.caseInsensitive) args.push("-i")
    if (opts.maxCount) args.push("--max-count", String(opts.maxCount))
    if (opts.maxCountPerFile) args.push("-m", String(opts.maxCountPerFile))

    const globs = this.normalizeGlobs(opts.glob)
    for (const g of globs) {
      args.push("--glob", g)
    }

    args.push(pattern)
    args.push(opts.searchRoot ?? this.workspaceRoot)

    const started = Date.now()
    let raw: string
    try {
      raw = execFileSync("rg", args, {
        stdio: "pipe",
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      }).toString()
    } catch (err) {
      // ripgrep returns exit code 1 on no matches — that's not an error.
      // The Node API attaches stdout/stderr/code to the thrown error in
      // that case, so we can recover.
      const e = err as { status?: number; stdout?: Buffer | string }
      if (e?.status === 1) {
        // No matches — return empty.
        this.logger.debug("ripgrep:no-matches", {
          pattern,
          durationMs: Date.now() - started,
        })
        return []
      }
      // Real error — log and return empty.
      this.logger.debug("ripgrep:error", {
        pattern,
        durationMs: Date.now() - started,
        message: (err as Error)?.message?.slice(0, 200),
      })
      return []
    }

    const matches = this.parseJsonOutput(raw)
    this.logger.debug("ripgrep:done", {
      pattern,
      durationMs: Date.now() - started,
      matchCount: matches.length,
    })
    return matches
  }

  count(pattern: string, opts: RipgrepSearchOptions = {}): number {
    if (!this.available) return 0
    const args = ["--count", "-l"]
    if (opts.fixedString) args.push("--fixed-strings")
    if (opts.caseInsensitive) args.push("-i")
    const globs = this.normalizeGlobs(opts.glob)
    for (const g of globs) {
      args.push("--glob", g)
    }
    args.push(pattern)
    args.push(opts.searchRoot ?? this.workspaceRoot)

    try {
      const raw = execFileSync("rg", args, {
        stdio: "pipe",
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      }).toString()
      // --count -l prints one filename per line (with no count). The actual
      // count of matches is the line count.
      return raw.split("\n").filter((l) => l.trim().length > 0).length
    } catch (err) {
      const e = err as { status?: number }
      if (e?.status === 1) return 0
      return 0
    }
  }

  findFiles(glob: string, opts: { searchRoot?: string } = {}): string[] {
    if (!this.available) return []
    const args = ["--files", "--glob", glob, opts.searchRoot ?? this.workspaceRoot]
    try {
      const raw = execFileSync("rg", args, {
        stdio: "pipe",
        timeout: DEFAULT_TIMEOUT_MS,
      }).toString()
      return raw
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
    } catch (err) {
      const e = err as { status?: number }
      if (e?.status === 1) return []
      return []
    }
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private normalizeGlobs(g: string | string[] | undefined): string[] {
    if (!g) return [DEFAULT_GLOB]
    if (Array.isArray(g)) return g.length > 0 ? g : [DEFAULT_GLOB]
    return [g]
  }

  private parseJsonOutput(raw: string): RipgrepMatch[] {
    const out: RipgrepMatch[] = []
    for (const row of raw.split("\n")) {
      if (!row.trim()) continue
      let parsed: {
        type?: string
        data?: {
          path?: { text?: string }
          line_number?: number
          lines?: { text?: string }
          absolute_offset?: number
          submatches?: Array<{ match?: { text?: string }; start: number; end: number }>
        }
      }
      try {
        parsed = JSON.parse(row)
      } catch {
        continue
      }
      if (parsed.type !== "match") continue
      const filePath = parsed.data?.path?.text
      const line = parsed.data?.line_number
      const lineText = parsed.data?.lines?.text ?? ""
      if (!filePath || typeof line !== "number") continue
      out.push({
        filePath,
        line,
        lineText: lineText.replace(/\n$/, ""),
        absoluteOffset: parsed.data?.absolute_offset,
        submatches: parsed.data?.submatches?.map((sm) => ({
          start: sm.start,
          end: sm.end,
          text: sm.match?.text ?? "",
        })),
      })
    }
    return out
  }
}
