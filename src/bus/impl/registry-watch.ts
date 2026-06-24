// src/workflow/watch.ts — Stage 7 (I7.1) fs.watch lifecycle helper for
// L3 registry hot-reload.
// -------------------------------------------------------------------------
// Authoritative contract:
//   project/software/opencode/specification/contract/l3-registry.md
//     §loader-lifecycle step 7 — Watch: re-fire steps 1-6 on relevant file
//     mutation, debounced.
//   §verification cell 8 — N file mutations within debounce window → exactly
//     1 reload.
//
// Design choices:
//
//  1. **Debounce, not throttle** — operators editing a card via $EDITOR fire
//     several mutation events in quick succession (open, save, fsync rename).
//     Throttle would reload mid-edit; debounce coalesces all events within a
//     window into one final reload.
//
//  2. **Per-watcher debounce timer** — module-level Map keyed by registry kind.
//     Restarting the timer on each event guarantees the reload only fires
//     after `debounceMs` of quiet.
//
//  3. **Graceful degradation on EMFILE / EPERM / ENOENT** — fs.watch can throw
//     when descriptors are exhausted, when the OS lacks watch support
//     (containers without inotify), or when the directory has not yet been
//     created. WARN log + LoadFailed bus event + return no-op disposer; manual
//     `Registry.reload()` still works.
//
//  4. **Recursive watch by default** — vault subtrees can grow nested
//     (`atomic/workflow/phase/<name>/extras/...`). Node's `recursive: true`
//     is supported on Linux ≥ 2024 + macOS + Windows. Falls back to
//     non-recursive on older runtimes via a try/catch retry.
//
//  5. **No-op when env gate off** — `OPENCODE_HOT_RELOAD=0` disables.
//     Any other value, including unset, uses the normal watcher. Hot-reload is
//     default-enabled so mid-session vault edits reflect without process restart.
// -------------------------------------------------------------------------

import { existsSync, watch as fsWatch, type FSWatcher } from "fs"
import { Log } from "@/foundation/util/log"
import { publish } from "@/bus/impl/runtime"
import { RegistryEvent } from "@/bus/registry-events"

export namespace WatchManager {
  const log = Log.create({ service: "registry-watch" })

  /**
   * Default debounce window. 250ms covers most editor save sequences (vim
   * fsync rename, VS Code atomic write) without making operator-driven
   * reloads feel laggy.
   *
   * Verification cell 8 (N mutations within window → 1 reload) tests this
   * with synthetic event bursts; tune window via `WatchManager.start({
   * debounceMs })` if a particular registry needs faster/slower response.
   */
  export const DEFAULT_DEBOUNCE_MS = 250

  type Handle = {
    kind: RegistryEvent.RegistryKind
    watcher: FSWatcher
    timer: NodeJS.Timeout | null
    disposed: boolean
  }

  /**
   * Module-level Map of active watchers, keyed by registry kind. Lets test
   * harnesses verify watcher liveness via `WatchManager.isActive(kind)` and
   * gives the engine a single place to dispose all watchers on shutdown.
   *
   * Module state is intentional here (not per-instance) because each
   * registry kind has at most one watcher per process; sharding by session
   * would multiply file-descriptor cost without correctness benefit.
   */
  const handles = new Map<RegistryEvent.RegistryKind, Handle>()

  export interface StartOptions {
    /** Registry kind (drives bus event payloads). */
    kind: RegistryEvent.RegistryKind
    /** Vault subtree to watch (e.g. `<vault>/atomic/workflow/phase/`). */
    dir: string
    /** Callback invoked after debounce window closes. Promise-returning so
     *  we can await registry.reload() before resetting timer state. */
    onChange: () => Promise<void>
    /** Debounce window in ms. Defaults to DEFAULT_DEBOUNCE_MS. */
    debounceMs?: number
  }

  export interface Disposer {
    dispose(): void
  }

  /**
   * Start watching `dir` for any *.md mutation. Returns a disposer; call
   * `.dispose()` to stop the watcher (idempotent).
   *
   * Failure modes:
   *   - dir doesn't exist → returns no-op disposer + WARN log (registry will
   *     create dir on first seed; caller should re-invoke `start()` after).
   *   - fs.watch throws → publishes `registry.load_failed` + returns no-op
   *     disposer.
   *   - already-active watcher for this kind → disposes the old, starts new.
   */
  export function start(opts: StartOptions): Disposer {
    const { kind, dir, onChange, debounceMs = DEFAULT_DEBOUNCE_MS } = opts

    if (process.env["OPENCODE_HOT_RELOAD"] === "0") {
      // Env gate off — return no-op disposer. Manual reload() still works.
      return { dispose: () => {} }
    }

    // Replace any existing watcher for this kind (idempotent re-start).
    stop(kind)

    if (!existsSync(dir)) {
      log.warn("watch.dir.missing", {
        kind,
        dir,
        message: "vault subtree does not exist; watcher not started.",
      })
      return { dispose: () => {} }
    }

    let watcher: FSWatcher
    try {
      watcher = fsWatch(dir, { recursive: true, persistent: false })
    } catch (err) {
      // Recursive may not be supported on this runtime — retry without.
      try {
        watcher = fsWatch(dir, { persistent: false })
      } catch (err2) {
        const detail = err2 instanceof Error ? err2.message : String(err2)
        const reason = detail.includes("EMFILE")
          ? "fs.watch.emfile"
          : detail.includes("EPERM")
            ? "fs.watch.eperm"
            : "fs.watch.unknown"
        log.warn("watch.start.failed", { kind, dir, reason, detail })
        // Publish degradation event so subscribers know hot-reload is off.
        publish(RegistryEvent.LoadFailed, { kind, reason, detail }).catch(() => {})
        return { dispose: () => {} }
      }
    }

    const handle: Handle = {
      kind,
      watcher,
      timer: null,
      disposed: false,
    }
    handles.set(kind, handle)

    const fire = () => {
      if (handle.disposed) return
      handle.timer = null
      onChange().catch((err) => {
        log.warn("watch.onChange.threw", {
          kind,
          err: err instanceof Error ? err.message : String(err),
        })
      })
    }

    watcher.on("change", (_eventType, filename) => {
      if (handle.disposed) return
      // Filter to *.md mutations only — non-card files (test artefacts,
      // editor swap files, .DS_Store) are noise.
      if (filename && typeof filename === "string" && !filename.endsWith(".md")) return

      // Restart debounce timer on each event — coalesces bursts.
      if (handle.timer) clearTimeout(handle.timer)
      handle.timer = setTimeout(fire, debounceMs)
      // Don't keep the event loop alive on the timer alone.
      handle.timer.unref?.()
    })

    watcher.on("error", (err) => {
      log.warn("watch.error", {
        kind,
        err: err instanceof Error ? err.message : String(err),
      })
    })

    return {
      dispose: () => stop(kind),
    }
  }

  /** Stop watcher for a specific kind. Idempotent. */
  export function stop(kind: RegistryEvent.RegistryKind): void {
    const handle = handles.get(kind)
    if (!handle) return
    handle.disposed = true
    if (handle.timer) {
      clearTimeout(handle.timer)
      handle.timer = null
    }
    try {
      handle.watcher.close()
    } catch {
      // Already closed — ignore.
    }
    handles.delete(kind)
  }

  /** Stop all active watchers. Engine-shutdown helper. */
  export function stopAll(): void {
    for (const kind of [...handles.keys()]) stop(kind)
  }

  /** Test-only: is a watcher currently active for this kind? */
  export function isActive(kind: RegistryEvent.RegistryKind): boolean {
    return handles.has(kind)
  }

  /** Test-only: list all active kinds. */
  export function activeKinds(): ReadonlyArray<RegistryEvent.RegistryKind> {
    return Object.freeze([...handles.keys()])
  }
}
