// util/cleanup-registry.ts
//
// Centralized cleanup registry for graceful shutdown (parity gap-56).
//
// PROVENANCE: ported from
// `instructkr-claude-code/src/utils/cleanupRegistry.ts` (25 LOC).
// The Claude reference is a minimal Set<() => Promise<void>> with
// register/unregister/runAll. This opencode port adds:
//   - Auto-install of process exit/SIGINT/SIGTERM handlers on first
//     use (so individual modules don't have to install their own)
//   - Idempotent runAll (multi-signal can't double-fire)
//   - Sync + async cleanup function support
//   - State inspector for tests + the future debug command
//
// THE PROBLEM
// ===========
// opencode currently scatters process exit / signal handlers across
// the codebase. `util/prevent-sleep.ts:173-175` installs three of
// them (process.on "exit"|"SIGINT"|"SIGTERM") just to release the
// caffeinate subprocess. The comment in prevent-sleep.ts:21 even
// says: "opencode has no cleanupRegistry analogue."
//
// Other modules will eventually need to clean up resources at
// shutdown:
//   - mcp/index.ts: kill subprocess clients
//   - lsp/server.ts: shutdown LSP servers gracefully
//   - file/watcher.ts: close watchers + stop polling
//   - session/snapshot.ts: flush pending writes
//   - bus/index.ts: close subscriptions
//
// Without a registry, each module installs its own handlers, the
// process gets ~10 redundant signal listeners (and trips
// MaxListenersExceededWarning), and there's no guaranteed ordering
// between cleanup operations.
//
// THE FIX
// =======
// `CleanupRegistry.register(fn)` adds a cleanup function and returns
// an `unregister` function. The first call to `register()` lazily
// installs three process handlers (exit, SIGINT, SIGTERM) that all
// route to the same `runAll()` function. Subsequent calls do not
// re-install the handlers.
//
// `runAll()` is idempotent: a flag tracks whether it has already
// run, and a second call (from a second signal, or from manual
// invocation) is a no-op. This prevents double-cleanup when SIGINT
// fires + the process then runs the "exit" handler.
//
// USAGE
// =====
// ```ts
// import { CleanupRegistry } from "./util/cleanup-registry"
//
// // Module that needs cleanup
// const watcher = startFileWatcher()
// const unregister = CleanupRegistry.register(async () => {
//   await watcher.close()
// })
//
// // Later — cancel the cleanup if no longer needed
// unregister()
// ```
//
// THIS IS NOT
// ===========
// Not a process supervisor — doesn't restart on crash, doesn't
// monitor children. Pure shutdown-time hook registry.
//
// Not ordered — cleanup functions run in PARALLEL via Promise.all.
// If you need ordering, compose dependent cleanups inside one
// registered function.
//
// Not crash-safe — uncaught exceptions and SIGKILL bypass the
// registry entirely. Use this for "best effort cleanup on graceful
// shutdown", not for "must run before the process exits".

import { Log } from "./log"

/**
 * Lazy log accessor. We MUST NOT call `Log.create({...})` at module
 * top level because `log.ts` lazy-imports this file (cleanup-registry)
 * during its own init() to register a flush hook. Top-level
 * `Log.create` here would race against `log.ts`'s static export bind:
 * if cleanup-registry is the first module to be imported on the cycle
 * edge, `Log.create` is `undefined` and we throw with
 *   "TypeError: Cannot read properties of undefined (reading 'create')"
 * which surfaces as an unhandled rejection out of `log.ts:194`'s
 * dynamic import. This timed out 3 unrelated tests under full-suite
 * parallel load (config/config, plugin/auth-override, tool/registry)
 * because the rejection landed in their `await Config.get()` chain.
 *
 * Deferring `Log.create` to first use sidesteps the cycle entirely —
 * by the time `register()` or `runAll()` runs, both modules are fully
 * bound.
 */
let cachedLog: ReturnType<typeof Log.create> | undefined
function log_() {
  if (!cachedLog) cachedLog = Log.create({ service: "cleanup-registry" })
  return cachedLog
}

export namespace CleanupRegistry {
  /**
   * Cleanup function shape. May return a Promise (async cleanup) or
   * undefined (sync cleanup). Both forms are awaited in runAll.
   */
  export type CleanupFn = () => Promise<void> | void

  const cleanupFunctions = new Set<CleanupFn>()

  /**
   * True once the process exit/signal handlers have been installed.
   * Lazy install so the registry is a no-op until something actually
   * registers.
   */
  let handlersInstalled = false

  /**
   * True once runAll has fired. Subsequent calls are no-ops to
   * prevent double-cleanup when multiple signals overlap (SIGINT
   * then "exit" event, for example).
   */
  let hasRun = false

  /**
   * Lazily install the process-level exit + signal handlers. Called
   * automatically on the first register() call. Subsequent calls
   * are no-ops.
   */
  function installHandlers(): void {
    if (handlersInstalled) return
    handlersInstalled = true
    process.on("exit", () => {
      // The "exit" event is synchronous — async cleanup functions
      // running here will not complete. Sync cleanups DO run.
      // Most code paths reach exit only AFTER a SIGINT/SIGTERM
      // handler has already run (and awaited) the async cleanups.
      runAllSync()
    })
    process.on("SIGINT", () => {
      // SIGINT + SIGTERM run the full async cleanup, then exit.
      // The exit listener will fire next but runAll is idempotent.
      void runAll().finally(() => {
        process.exit(130) // 128 + SIGINT (2)
      })
    })
    process.on("SIGTERM", () => {
      void runAll().finally(() => {
        process.exit(143) // 128 + SIGTERM (15)
      })
    })
  }

  /**
   * Register a cleanup function to run during graceful shutdown.
   * Auto-installs the process exit/signal handlers on first use.
   *
   * Returns an `unregister` function that removes the cleanup
   * handler. Useful for modules that want to deregister cleanup
   * when their state goes away (e.g. when a session ends mid-
   * process).
   *
   * Can be sync or async. Async cleanups are awaited in `runAll()`
   * but NOT in the synchronous "exit" handler — async work runs
   * on SIGINT/SIGTERM where there's still a chance to await.
   */
  export function register(fn: CleanupFn): () => void {
    installHandlers()
    cleanupFunctions.add(fn)
    return () => {
      cleanupFunctions.delete(fn)
    }
  }

  /**
   * Run all registered cleanup functions in parallel, awaiting any
   * Promise returns. Idempotent — multiple calls are no-ops after
   * the first.
   *
   * Errors thrown from individual cleanup functions are caught and
   * logged. One failing cleanup does NOT block the others from
   * running.
   */
  export async function runAll(): Promise<void> {
    if (hasRun) return
    hasRun = true
    const fns = Array.from(cleanupFunctions)
    log_().info("running cleanup functions", { count: fns.length })
    await Promise.all(
      fns.map(async (fn) => {
        try {
          await fn()
        } catch (e) {
          log_().info("cleanup function threw", { error: (e as Error).message })
        }
      }),
    )
  }

  /**
   * Synchronous variant invoked from the "exit" event listener.
   * Only sync cleanup functions complete here — Promise returns are
   * fire-and-forget (the process is already exiting). Tries to call
   * each fn but catches throws so one bad cleanup doesn't crash
   * the rest of the exit path.
   *
   * In practice, the SIGINT/SIGTERM handlers run runAll() FIRST and
   * await it; the "exit" listener is only the fallback for code
   * paths that reach exit without going through a signal (e.g.
   * process.exit() called directly).
   */
  function runAllSync(): void {
    if (hasRun) return
    hasRun = true
    for (const fn of cleanupFunctions) {
      try {
        const ret = fn()
        // Don't await — we're in a sync context. If fn returns a
        // Promise, the .catch swallows any rejection so the loop
        // doesn't crash; the work itself may not complete before
        // exit.
        if (ret && typeof (ret as Promise<void>).catch === "function") {
          ;(ret as Promise<void>).catch(() => {})
        }
      } catch {
        // swallow — process is exiting, can't do much
      }
    }
  }

  /**
   * Inspect the registry state. Used for tests + the future
   * `opencode debug cleanup` command.
   */
  export function state(): {
    registered: number
    handlersInstalled: boolean
    hasRun: boolean
  } {
    return {
      registered: cleanupFunctions.size,
      handlersInstalled,
      hasRun,
    }
  }

  /**
   * Test escape hatch: clear the registry + reset run-state +
   * un-install handlers. Tests should call this in beforeEach.
   *
   * Important: this does NOT call process.removeListener for the
   * exit/SIGINT/SIGTERM handlers. Bun + node forbid removing
   * listeners during their own callback, and the handlers are
   * harmless once `cleanupFunctions` is empty (they iterate over
   * nothing). Setting `handlersInstalled = false` lets the next
   * register() call re-install fresh handlers IF the test wants
   * to inspect the install path.
   */
  export function _reset(): void {
    cleanupFunctions.clear()
    hasRun = false
    handlersInstalled = false
  }
}
