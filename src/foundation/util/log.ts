import path from "path"
import fs from "fs/promises"
import { createWriteStream, type WriteStream } from "fs"
import { vaultPath } from "@/foundation/notes-root"
import z from "zod"
import { BufferedWriter } from "./buffered-writer"
import { DebugFilter } from "./debug-filter"
import { Glob } from "./glob"

// gap-50-followup-1: avoid the cleanup-registry static import to
// prevent a circular dependency. cleanup-registry.ts itself calls
// Log.create() at module load time; if we import it eagerly here,
// the load order resolves Log to undefined before its namespace is
// populated. The runtime require() inside init() lands AFTER both
// modules have finished loading their static exports, so the
// reference is always defined.
type CleanupRegistryModule = typeof import("./cleanup-registry")

export namespace Log {
  export const Level = z.enum(["DEBUG", "INFO", "WARN", "ERROR"]).meta({ ref: "LogLevel", description: "Log level" })
  export type Level = z.infer<typeof Level>

  const levelPriority: Record<Level, number> = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
  }

  let level: Level = "INFO"

  // gap-55-followup-1: OPENCODE_DEBUG-driven category filter.
  // Read once at init() time (or lazily on first emit). When set,
  // DEBUG and INFO emits are dropped unless the logger's `service`
  // tag is in the filter's allow set. WARN and ERROR always pass
  // through — error logs should never be silently dropped.
  //
  // Examples:
  //   OPENCODE_DEBUG=lsp,mcp     → only show lsp + mcp DEBUG/INFO
  //   OPENCODE_DEBUG=!session    → hide session DEBUG/INFO
  //   OPENCODE_DEBUG unset       → no filtering (existing behavior)
  let debugFilter: DebugFilter.Config | null | undefined = undefined

  function getDebugFilter(): DebugFilter.Config | null {
    // Lazy-init: caches the parsed filter on first access. The
    // env var is read once and cached for the process lifetime so
    // hot-path log emits don't pay the parse cost repeatedly.
    // Tests can call _resetDebugFilter() to force a fresh read.
    if (debugFilter === undefined) {
      debugFilter = DebugFilter.parse(process.env.OPENCODE_DEBUG)
    }
    return debugFilter
  }

  /**
   * Test escape hatch: clear the cached debug filter so the next
   * emit re-reads OPENCODE_DEBUG. Tests should call this in
   * beforeEach when manipulating the env var.
   */
  export function _resetDebugFilter(): void {
    debugFilter = undefined
    DebugFilter._resetCache()
  }

  function shouldLog(input: Level): boolean {
    return levelPriority[input] >= levelPriority[level]
  }

  /**
   * Check whether a logger with the given service tag should emit
   * at the given level. Combines the level filter with the
   * category filter.
   *
   * - WARN and ERROR always pass through (regardless of category)
   * - DEBUG and INFO consult the OPENCODE_DEBUG filter when set
   * - When the filter is null (unset), only the level check applies
   */
  function shouldEmit(input: Level, service: string | undefined): boolean {
    if (!shouldLog(input)) return false
    // WARN and ERROR bypass the category filter — error logs should
    // never be silently dropped by accidental category filtering.
    if (input === "WARN" || input === "ERROR") return true
    const filter = getDebugFilter()
    if (!filter) return true
    // Use the structured service tag as the category. Skip the
    // regex-based extraction from message text — opencode's
    // logger always has a service tag, so it's both faster and
    // more accurate than parsing message prefixes.
    const categories = service ? [service.toLowerCase()] : []
    return DebugFilter.shouldShowCategories(categories, filter)
  }

  export type Logger = {
    debug(message?: any, extra?: Record<string, any>): void
    info(message?: any, extra?: Record<string, any>): void
    error(message?: any, extra?: Record<string, any>): void
    warn(message?: any, extra?: Record<string, any>): void
    tag(key: string, value: string): Logger
    clone(): Logger
    time(
      message: string,
      extra?: Record<string, any>,
    ): {
      stop(): void
      [Symbol.dispose](): void
    }
  }

  const loggers = new Map<string, Logger>()

  export const Default = create({ service: "default" })

  export interface Options {
    print: boolean
    dev?: boolean
    level?: Level
  }

  let logpath = ""
  export function file() {
    return logpath
  }
  let mirrorToStderr = true
  let write = (msg: any) => {
    process.stderr.write(msg)
    return msg.length
  }

  /**
   * Test escape hatch: replace the write sink with a custom function.
   * Used by tests that need to capture log output without going
   * through process.stderr (which bun:test may intercept). Returns
   * a restore function that swaps the original write back.
   *
   * Production code should not call this.
   */
  export function _setWriter(fn: (msg: any) => any): () => void {
    const original = write
    write = fn
    return () => {
      write = original
    }
  }

  // gap-50-followup-1: BufferedWriter handle for the file sink. Held
  // at module scope so flushOnExit() can drain it during shutdown.
  // null when not in file mode (print mode or pre-init).
  let fileWriter: BufferedWriter.Writer | null = null
  let fileStream: WriteStream | null = null
  let cleanupRegistered = false

  function buildWriter() {
    return (msg: any) => {
      if (mirrorToStderr) process.stderr.write(msg)
      if (fileWriter) {
        fileWriter.write(msg)
      } else if (!mirrorToStderr) {
        process.stderr.write(msg)
      }
      return msg.length
    }
  }

  export async function init(options: Options) {
    if (options.level) level = options.level
    const logDir = vaultPath.logDir("global")
    await fs.mkdir(logDir, { recursive: true })
    cleanup(logDir)
    mirrorToStderr = options.print
    const dev = options.dev ?? path.basename(logpath) === "dev.log"
    const nextLogPath = path.join(
      vaultPath.logDir("global"),
      dev ? "dev.log" : new Date().toISOString().split(".")[0].replace(/:/g, "") + ".log",
    )
    // Re-initializing the same file sink is common in tests. Keep the
    // existing writer to avoid truncation races across parallel suites.
    if (fileWriter && fileStream && logpath === nextLogPath) {
      write = buildWriter()
      return
    }
    flushFileWriter()
    fileWriter = null
    if (fileStream) {
      fileStream.end()
      fileStream = null
    }
    logpath = nextLogPath
    await fs.truncate(logpath).catch(() => {})
    const stream = createWriteStream(logpath, { flags: "a" })
    fileStream = stream
    // gap-50-followup-1: route file writes through BufferedWriter so
    // many small log lines batch into one stream.write call. Cuts
    // syscall count dramatically for high-volume logging without
    // changing the logger API. The writer's deferred-overflow path
    // means write() never blocks the caller — even if the underlying
    // stream is slow, the agent loop continues at full speed.
    //
    // CAPS: 100 lines OR 4KB OR 100ms — whichever comes first. The
    // 100ms time-based flush ensures DEBUG/INFO lines are flushed
    // promptly enough for tail -f workflows even during quiet
    // periods.
    fileWriter = BufferedWriter.create({
      writeFn: (content) => {
        stream.write(content)
      },
      flushIntervalMs: 100,
      maxBufferSize: 100,
      maxBufferBytes: 4096,
    })
    write = buildWriter()
    // gap-50-followup-1: drain pending file writes on graceful
    // shutdown so the last few log lines actually land on disk.
    // Without this, a fast SIGINT during a busy log burst would
    // lose up to ~100 buffered lines (the maxBufferSize cap) or
    // ~100ms worth of unflushed time-based writes.
    //
    // Lazy import() to avoid the circular import — see the comment
    // at the top of this file. By the time init() runs, both
    // modules have loaded their static exports, so the dynamic
    // import is safe and resolves immediately from the module
    // cache.
    if (!cleanupRegistered) {
      const cleanupRegistryModule: CleanupRegistryModule = await import("./cleanup-registry")
      cleanupRegistryModule.CleanupRegistry.register(() => {
        flushFileWriter()
      })
      cleanupRegistered = true
    }
  }

  /**
   * Drain any buffered file writes synchronously. Called by the
   * gap-56 CleanupRegistry on graceful shutdown so the last few
   * log lines actually land on disk.
   *
   * In print mode (no fileWriter), this is a no-op.
   */
  export function flushFileWriter(): void {
    if (fileWriter) {
      fileWriter.flush()
    }
  }

  async function cleanup(dir: string) {
    const files = await Glob.scan("????-??-??T??????.log", {
      cwd: dir,
      absolute: true,
      include: "file",
    })
    if (files.length <= 5) return

    const filesToDelete = files.slice(0, -10)
    await Promise.all(filesToDelete.map((file) => fs.unlink(file).catch(() => {})))
  }

  function formatError(error: Error, depth = 0): string {
    const result = error.message
    return error.cause instanceof Error && depth < 10
      ? result + " Caused by: " + formatError(error.cause, depth + 1)
      : result
  }

  let last = Date.now()
  export function create(tags?: Record<string, any>) {
    tags = tags || {}

    const service = tags["service"]
    if (service && typeof service === "string") {
      const cached = loggers.get(service)
      if (cached) {
        return cached
      }
    }

    function build(message: any, extra?: Record<string, any>) {
      const prefix = Object.entries({
        ...tags,
        ...extra,
      })
        .filter(([_, value]) => value !== undefined && value !== null)
        .map(([key, value]) => {
          const prefix = `${key}=`
          if (value instanceof Error) return prefix + formatError(value)
          if (typeof value === "object") return prefix + JSON.stringify(value)
          return prefix + value
        })
        .join(" ")
      const next = new Date()
      const diff = next.getTime() - last
      last = next.getTime()
      return [next.toISOString().split(".")[0], "+" + diff + "ms", prefix, message].filter(Boolean).join(" ") + "\n"
    }
    // gap-55-followup-1: capture the service tag for category filtering
    const loggerService = typeof tags["service"] === "string" ? tags["service"] : undefined

    const result: Logger = {
      debug(message?: any, extra?: Record<string, any>) {
        if (shouldEmit("DEBUG", loggerService)) {
          write("DEBUG " + build(message, extra))
        }
      },
      info(message?: any, extra?: Record<string, any>) {
        if (shouldEmit("INFO", loggerService)) {
          write("INFO  " + build(message, extra))
        }
      },
      error(message?: any, extra?: Record<string, any>) {
        if (shouldEmit("ERROR", loggerService)) {
          write("ERROR " + build(message, extra))
        }
      },
      warn(message?: any, extra?: Record<string, any>) {
        if (shouldEmit("WARN", loggerService)) {
          write("WARN  " + build(message, extra))
        }
      },
      tag(key: string, value: string) {
        if (tags) tags[key] = value
        return result
      },
      clone() {
        return Log.create({ ...tags })
      },
      time(message: string, extra?: Record<string, any>) {
        const now = Date.now()
        result.info(message, { status: "started", ...extra })
        function stop() {
          result.info(message, {
            status: "completed",
            duration: Date.now() - now,
            ...extra,
          })
        }
        return {
          stop,
          [Symbol.dispose]() {
            stop()
          },
        }
      },
    }

    if (service && typeof service === "string") {
      loggers.set(service, result)
    }

    return result
  }
}
