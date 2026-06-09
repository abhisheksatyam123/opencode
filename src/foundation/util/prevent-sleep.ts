// util/prevent-sleep.ts
//
// Prevents the OS from sleeping while opencode is doing long-running
// work — long agent runs, big tool batches, model API calls that span
// minutes. The wrapper is a refcounted start/stop pair so multiple
// concurrent operations can hold the assertion without stomping on
// each other.
//
// PROVENANCE: ported from
// `instructkr-claude-code/src/services/preventSleep.ts` (165 LOC).
// The reference is darwin-only and uses macOS's `caffeinate -i -t N`
// command. Opencode extends the design to also support linux via
// `systemd-inhibit`, with windows deferred (would need SetThreadExecutionState
// via a native module or PowerShell shellout).
//
// Differences from the reference:
//
//   - Cross-platform: darwin uses `caffeinate`, linux uses
//     `systemd-inhibit` (gracefully no-op if not installed), win32 +
//     unknown platforms are silent no-ops
//   - Cleanup hooks routed through `CleanupRegistry` (gap-56) — one
//     `register(forceStop)` call on first spawn, no manual process.on
//     bookkeeping. The CleanupRegistry handles the
//     exit/SIGINT/SIGTERM dispatch centrally. Updated as part of
//     gap-56-followup-1 — the original prevent-sleep.ts predated the
//     centralized registry and installed its own three handlers
//   - Self-healing restart interval is preserved verbatim (4 minutes
//     for a 5-minute caffeinate timeout) so a SIGKILL'd parent never
//     leaves an orphaned caffeinate running for hours
//   - Refcount + force-stop semantics preserved verbatim
//
// Usage:
//
//   PreventSleep.start()
//   try { ... long work ... }
//   finally { PreventSleep.stop() }
//
// Or wrap automatically:
//
//   await PreventSleep.run(async () => { ... })

import { type ChildProcess, spawn } from "child_process"
import { CleanupRegistry } from "./cleanup-registry"
import { Log } from "./log"

export namespace PreventSleep {
  const log = Log.create({ service: "prevent-sleep" })

  // Power assertion timeout. Process auto-exits after this duration —
  // we restart it before expiry to maintain continuous prevention.
  // The auto-exit IS the self-healing mechanism: if our process is
  // killed with SIGKILL (no cleanup handlers run), the orphaned
  // caffeinate / systemd-inhibit will time out and stop on its own.
  const PROCESS_TIMEOUT_SECONDS = 300 // 5 minutes

  // Restart interval. Use 4 minutes so we restart well before the
  // 5-minute timeout, providing 1 minute of safety margin.
  const RESTART_INTERVAL_MS = 4 * 60 * 1000

  // Module-level state. Refcounted so multiple concurrent callers
  // can hold the assertion without stomping on each other. The
  // assertion is released when the LAST start() is matched by a stop().
  let proc: ChildProcess | null = null
  let restartTimer: ReturnType<typeof setInterval> | null = null
  let refCount = 0
  let cleanupRegistered = false

  /**
   * Increment the reference count and start preventing sleep if this
   * is the first caller. Idempotent within a single call site only —
   * each start() must be paired with a stop() (or use run() which
   * handles the pairing automatically).
   */
  export function start(): void {
    refCount++
    if (refCount === 1) {
      spawnProc()
      startRestartTimer()
    }
  }

  /**
   * Decrement the reference count. Releases the OS power assertion
   * when the count drops to zero. Calling stop() more times than
   * start() is a no-op (refCount can't go negative).
   */
  export function stop(): void {
    if (refCount > 0) {
      refCount--
    }
    if (refCount === 0) {
      stopRestartTimer()
      killProc()
    }
  }

  /**
   * Force-release the assertion regardless of refCount. Used by the
   * exit cleanup hooks to guarantee no orphaned process survives.
   * After force-stop the refCount is reset to 0; subsequent start()
   * calls behave as if from a fresh state.
   */
  export function forceStop(): void {
    refCount = 0
    stopRestartTimer()
    killProc()
  }

  /**
   * Convenience wrapper: start, run an async function, stop in a
   * finally block. The assertion is held only for the lifetime of
   * the function — even if it throws.
   */
  export async function run<T>(fn: () => Promise<T>): Promise<T> {
    start()
    try {
      return await fn()
    } finally {
      stop()
    }
  }

  /**
   * Inspector for tests + debugging. Returns a snapshot of the
   * current internal state.
   */
  export function state(): { refCount: number; running: boolean; platform: NodeJS.Platform } {
    return {
      refCount,
      running: proc !== null,
      platform: process.platform,
    }
  }

  // ── Platform-specific spawn ────────────────────────────────────────────────

  /** Returns the spawn args for the current platform, or null if unsupported. */
  function spawnArgs(): { command: string; args: string[] } | null {
    if (process.platform === "darwin") {
      // -i: idle-sleep assertion only (display can still sleep)
      // -t: auto-exit timeout in seconds (self-healing)
      return { command: "caffeinate", args: ["-i", "-t", String(PROCESS_TIMEOUT_SECONDS)] }
    }
    if (process.platform === "linux") {
      // systemd-inhibit creates a power-management lock that's
      // released when the inhibitor process exits. We chain `sleep`
      // as the holder so the inhibit lasts exactly N seconds.
      // Gracefully no-ops if systemd-inhibit isn't installed
      // (the spawn 'error' handler catches ENOENT).
      return {
        command: "systemd-inhibit",
        args: [
          "--what=idle:sleep",
          "--who=opencode",
          "--why=running",
          "--mode=block",
          "sleep",
          String(PROCESS_TIMEOUT_SECONDS),
        ],
      }
    }
    // win32 + others: not supported. The wrapper is a no-op.
    return null
  }

  function spawnProc(): void {
    if (proc !== null) return // already running
    const args = spawnArgs()
    if (!args) return // unsupported platform — silent no-op

    // gap-56-followup-1: route exit cleanup through the centralized
    // CleanupRegistry instead of installing three process.on handlers
    // directly. The registry handles dispatch centrally + dedupes via
    // its internal Set, so the cleanupRegistered flag is no longer
    // needed. Register exactly once on first spawn.
    if (!cleanupRegistered) {
      cleanupRegistered = true
      CleanupRegistry.register(() => {
        forceStop()
      })
    }

    try {
      const child = spawn(args.command, args.args, { stdio: "ignore" })

      // unref so the child doesn't keep the parent alive — we want
      // opencode to exit cleanly even if the assertion is still held.
      child.unref()

      const thisProc = child
      child.on("error", (err) => {
        // ENOENT (binary missing) lands here — silently no-op so
        // a missing systemd-inhibit on a non-systemd linux box
        // doesn't crash the parent.
        log.debug("prevent-sleep spawn error", { err: err.message, command: args.command })
        if (proc === thisProc) proc = null
      })
      child.on("exit", () => {
        if (proc === thisProc) proc = null
      })

      proc = child
      log.info("prevent-sleep started", { command: args.command, timeout: PROCESS_TIMEOUT_SECONDS })
    } catch (err) {
      // Synchronous spawn failure (rare — usually surfaces via
      // 'error' event instead). Silent no-op.
      log.debug("prevent-sleep spawn threw", { err: (err as Error)?.message })
      proc = null
    }
  }

  function killProc(): void {
    if (proc === null) return
    const p = proc
    proc = null
    try {
      // SIGKILL for immediate termination — SIGTERM could be delayed
      // and the parent may already be exiting.
      p.kill("SIGKILL")
      log.debug("prevent-sleep stopped")
    } catch {
      // Process may have already exited
    }
  }

  function startRestartTimer(): void {
    if (process.platform !== "darwin" && process.platform !== "linux") return
    if (restartTimer !== null) return

    restartTimer = setInterval(() => {
      // Only restart if we still need the assertion. Skip if a
      // concurrent stop() dropped the count to zero between
      // intervals.
      if (refCount > 0) {
        log.debug("prevent-sleep restarting (interval)")
        killProc()
        spawnProc()
      }
    }, RESTART_INTERVAL_MS)

    // Don't let the timer keep the process alive
    restartTimer.unref()
  }

  function stopRestartTimer(): void {
    if (restartTimer !== null) {
      clearInterval(restartTimer)
      restartTimer = null
    }
  }
}
