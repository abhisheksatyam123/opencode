/**
 * daemon.ts — Persistent clangd daemon management.
 *
 * Language servers can be kept alive as detached background processes. A
 * lightweight TCP bridge (bridge.ts) proxies language-server stdio to a TCP port
 * so IntelGraph can reconnect without re-spawning the server.
 *
 * State file: <root>/.intelgraph-state.json
 *   Stores the bridge PID, language-server PID, and TCP port so IntelGraph
 *   start can verify the daemon is still alive and reconnect directly.
 *
 * Lifecycle:
 *   First start  → no state file → spawn bridge+clangd → write state → connect
 *   Later starts → read state → PID alive? TCP open? → connect (fast path)
 *                             → stale?               → respawn
 */

import { createServer, createConnection } from "net"
import { readFileSync, writeFileSync, unlinkSync, openSync, closeSync, constants, statSync, existsSync } from "fs"
import { spawn } from "child_process"
import path from "path"
import { fileURLToPath } from "url"
import { createHash } from "crypto"
import { loggerPort } from "../logging/logger.js"
const log = loggerPort.child("daemon")

// ── Root normalisation ────────────────────────────────────────────────────────

/**
 * Normalise a workspace root path.
 *
 * Guards against callers passing a VCS marker directory (e.g. `.git`) instead
 * of the actual project root.  When the path ends with a known marker directory
 * name AND that path is a directory on disk, return its parent.
 *
 * This is the single source of truth for root normalisation inside intelgraph.
 * All state file, lock file, and daemon spawn paths go through this function.
 */
export function normaliseRoot(rawRoot: string): string {
  const resolved = path.resolve(rawRoot)
  const name = path.basename(resolved)
  const markerDirs = new Set([".git", ".hg", ".svn"])
  if (markerDirs.has(name)) {
    try {
      const st = statSync(resolved)
      if (st.isDirectory()) {
        log.warn("Root points inside a VCS marker dir — using parent", { rawRoot, resolved })
        return path.dirname(resolved)
      }
    } catch {
      // stat failed — leave as-is
    }
  }
  return resolved
}

// ── State file schema ─────────────────────────────────────────────────────────

export interface DaemonState {
  version: number
  /** PID of the bridge process (the one that owns the TCP server) */
  bridgePid: number
  /** PID of the language server process (child of the bridge) */
  serverPid: number
  /** TCP port the bridge is listening on */
  port: number
  /** Absolute path to the workspace root */
  root: string
  /** Language server binary path used */
  serverBin: string
  /** Language server args used */
  serverArgs: string[]
  /** ISO timestamp of when the daemon was started */
  startedAt: string
  /** HTTP JSON daemon port (absent = not running) */
  httpPort?: number
  /** PID of the HTTP JSON daemon process (absent = not running) */
  httpPid?: number
  /** Stable workspace identity derived from normalized root */
  workspaceId?: string
  /** compile_commands preflight status mirrored from cleaner */
  compileCommandsPreflight?: {
    ranAt?: string
    patchEntries?: number
    mappedPatchCount?: number
    unmatchedPatchCount?: number
    requireZeroUnmatched?: boolean
    preflightPolicy?: "reject" | "fix" | "remap"
    externalEntryCount?: number
    remappedExternalCount?: number
    removedExternalCount?: number
    preflightOk?: boolean
  }
}

const STATE_FILE = ".intelgraph-state.json"
const SPAWN_LOCK_FILE = ".intelgraph-spawn.lock"
const STATE_VERSION = 1

/**
 * Resolve the state file path. IntelGraph only uses .intelgraph-state.json.
 */
export function stateFilePath(root: string): string {
  return path.join(normaliseRoot(root), STATE_FILE)
}

export function computeWorkspaceId(root: string): string {
  const normalized = normaliseRoot(root)
  return createHash("sha256").update(normalized).digest("hex").slice(0, 12)
}

export function readState(root: string): DaemonState | null {
  const fp = stateFilePath(root)
  try {
    const text = readFileSync(fp, "utf8")
    const state = JSON.parse(text) as DaemonState
    if (state.version !== STATE_VERSION) {
      log.warn("State file version mismatch — ignoring", {
        got: state.version,
        expected: STATE_VERSION,
        path: fp,
      })
      return null
    }
    log.debug("State file read", { path: fp, port: state.port, bridgePid: state.bridgePid })
    return state
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      log.warn("Failed to read state file", { path: fp, error: err?.message })
    }
    return null
  }
}

export function writeState(root: string, state: DaemonState): void {
  const fp = stateFilePath(root)
  writeFileSync(fp, JSON.stringify(state, null, 2), "utf8")
  log.info("State file written", {
    path: fp,
    port: state.port,
    bridgePid: state.bridgePid,
    serverPid: state.serverPid,
    httpPort: state.httpPort,
    httpPid: state.httpPid,
  })
}

export function clearState(root: string): void {
  const fp = stateFilePath(root)
  try {
    unlinkSync(fp)
    log.info("Stale state file removed", { path: fp })
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      log.warn("Failed to remove state file", { path: fp, error: err?.message })
    }
  }
}

// ── Spawn lock file (atomic spawn coordination) ──────────────────────────────

/**
 * Spawn lock path. IntelGraph only uses .intelgraph-spawn.lock.
 */
function spawnLockPath(root: string): string {
  return path.join(normaliseRoot(root), SPAWN_LOCK_FILE)
}

function readSpawnLockOwnerPid(root: string): number | null {
  const lp = spawnLockPath(root)
  try {
    const txt = readFileSync(lp, "utf8")
    const first = txt.split(/\r?\n/)[0]?.trim()
    const pid = first ? Number(first) : NaN
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/**
 * Acquire spawn lock using atomic O_CREAT | O_EXCL.
 * Returns true if lock acquired, false if another process holds it.
 */
export function tryAcquireSpawnLock(root: string): boolean {
  const lp = spawnLockPath(root)
  try {
    const fd = openSync(lp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`, "utf8")
    closeSync(fd)
    log.info("Spawn lock acquired", { path: lp, pid: process.pid })
    return true
  } catch (err: any) {
    if (err.code === "EEXIST") {
      log.info("Spawn lock already held by another process", { path: lp })
      return false
    }
    log.error("Failed to acquire spawn lock", err)
    return false
  }
}

/**
 * Release spawn lock.
 */
export function releaseSpawnLock(root: string): void {
  const lp = spawnLockPath(root)
  try {
    const ownerPid = readSpawnLockOwnerPid(root)
    if (ownerPid && ownerPid !== process.pid) {
      log.warn("Refusing to release spawn lock owned by another PID", {
        path: lp,
        ownerPid,
        pid: process.pid,
      })
      return
    }
    unlinkSync(lp)
    log.info("Spawn lock released", { path: lp, pid: process.pid })
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      log.warn("Failed to release spawn lock", { path: lp, error: err?.message })
    }
  }
}

/**
 * Wait for spawn lock to be released (poll with backoff).
 * Returns true if lock was released within timeout, false otherwise.
 */
export async function waitForSpawnLockRelease(root: string, timeoutMs = 30_000): Promise<boolean> {
  const lp = spawnLockPath(root)
  const deadline = Date.now() + timeoutMs
  let delay = 100
  let polls = 0

  while (Date.now() < deadline) {
    polls++
    try {
      readFileSync(lp, "utf8")

      // Detect and clean stale lock if owner process is gone.
      const ownerPid = readSpawnLockOwnerPid(root)
      if (ownerPid && !isProcessAlive(ownerPid)) {
        log.warn("Detected stale spawn lock owner; removing stale lock", {
          path: lp,
          ownerPid,
        })
        try {
          unlinkSync(lp)
          return true
        } catch {
          // another process may have raced; continue polling
        }
      }

      // Lock file still exists — wait
      await new Promise((r) => setTimeout(r, delay))
      delay = Math.min(delay * 1.5, 2000)
    } catch {
      // Lock file gone
      log.info("Spawn lock released by holder", { path: lp, polls, elapsedMs: timeoutMs - (deadline - Date.now()) })
      return true
    }
  }

  log.warn("Spawn lock wait timed out", { path: lp, timeoutMs, polls })
  return false
}

// ── Liveness checks ───────────────────────────────────────────────────────────

/** Returns true if a process with the given PID is alive. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    log.debug("Process liveness check: alive", { pid })
    return true
  } catch {
    log.debug("Process liveness check: dead", { pid })
    return false
  }
}

/** Returns true if a TCP server is accepting connections on the given port. */
export function isTcpPortOpen(port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" })
    const timer = setTimeout(() => {
      socket.destroy()
      log.debug("TCP port check: timeout", { port, timeoutMs })
      resolve(false)
    }, timeoutMs)
    socket.on("connect", () => {
      clearTimeout(timer)
      socket.destroy()
      log.debug("TCP port check: open", { port })
      resolve(true)
    })
    socket.on("error", (err) => {
      clearTimeout(timer)
      log.debug("TCP port check: closed", { port, error: err instanceof Error ? err.message : String(err) })
      resolve(false)
    })
  })
}

/**
 * Full liveness check: root matches, bridge PID alive, AND TCP port responding.
 * Returns true only if all three checks pass.
 */
export async function checkDaemonAlive(state: DaemonState, expectedRoot?: string): Promise<boolean> {
  if (expectedRoot && state.root !== expectedRoot) {
    log.warn("Daemon root mismatch — respawning", { stateRoot: state.root, expectedRoot })
    return false
  }
  // If bridgePid is 0, the bridge hasn't been spawned yet (HTTP daemon wrote state first).
  // This is OK — we'll spawn the bridge and it will update the state.
  if (state.bridgePid === 0) {
    log.info("Bridge not yet spawned (bridgePid=0) — will spawn now", {
      httpPort: state.httpPort,
      httpPid: state.httpPid,
    })
    return false
  }
  if (!isProcessAlive(state.bridgePid)) {
    log.warn("Bridge process is not alive", { bridgePid: state.bridgePid })
    return false
  }
  const tcpOpen = await isTcpPortOpen(state.port)
  if (!tcpOpen) {
    log.warn("TCP port is not responding", { port: state.port, bridgePid: state.bridgePid })
    return false
  }
  log.info("Daemon liveness check passed", { bridgePid: state.bridgePid, port: state.port })
  return true
}

// ── Free port allocation ──────────────────────────────────────────────────────

/** Binds to port 0 to get an OS-assigned free port, then releases it. */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      if (!addr || typeof addr === "string") {
        server.close()
        return reject(new Error("Could not determine free port"))
      }
      const port = addr.port
      server.close(() => resolve(port))
    })
    server.on("error", reject)
  })
}

// ── Daemon spawn ──────────────────────────────────────────────────────────────

export interface SpawnDaemonOptions {
  root: string
  serverBin: string
  serverArgs: string[]
  /** Path to the compiled bridge script (dist/bridge.js) */
  bridgeScript: string
}

/**
 * Spawns the clangd TCP bridge as a detached process and writes the state file.
 * Returns the TCP port the bridge is listening on.
 *
 * The bridge process is detached and unref'd so it can outlive short-lived clients.
 */
export async function spawnDaemon(opts: SpawnDaemonOptions): Promise<DaemonState> {
  // Normalise root first — guards against .git being passed as root
  const root = normaliseRoot(opts.root)
  if (root !== opts.root) {
    log.warn("spawnDaemon: root normalised", { original: opts.root, normalised: root })
  }

  const port = await findFreePort()

  log.info("Spawning language server bridge daemon", {
    port,
    bridgeScript: opts.bridgeScript,
    serverBin: opts.serverBin,
    serverArgs: opts.serverArgs,
    root,
  })

  const bridgeLog = path.join(root, "intelgraph-bridge.log")

  const bridgeArgs = [
    opts.bridgeScript,
    "--port",
    String(port),
    "--root",
    root,
    "--server",
    opts.serverBin,
    opts.serverArgs.length > 0 ? "--server-args" : null,
    opts.serverArgs.length > 0 ? opts.serverArgs.join(",") : null,
    "--log",
    bridgeLog,
  ].filter((v) => v !== null) as string[]

  // Spawn bridge as a detached process with stdio ignored so it becomes a
  // true daemon — it can outlive the requesting process.
  const bridge = spawn(process.execPath, bridgeArgs, {
    detached: true,
    stdio: "ignore",
    cwd: root,
  })

  if (!bridge.pid) {
    throw new Error("Failed to spawn bridge process (no PID assigned)")
  }

  // Listen for unexpected bridge death while we're still running.
  // This cleans up the stale state file so the next spawn check doesn't
  // think the daemon is alive and skip respawning.
  bridge.on("exit", (code, signal) => {
    log.warn("Bridge process exited while parent still running — clearing stale state", {
      bridgePid: bridge.pid,
      code,
      signal,
      port,
      root,
    })
    clearState(root)
  })

  // Detach from the bridge so our process exit doesn't kill it
  bridge.unref()

  log.info("Bridge process spawned (detached)", {
    bridgePid: bridge.pid,
    port,
    bridgeLog,
  })

  // Wait for the bridge to start listening (poll TCP port)
  log.info("Waiting for bridge to start listening…", { port, timeoutMs: 10_000 })
  const ready = await waitForPort(port, 10_000)
  if (!ready) {
    throw new Error(`Bridge did not start listening on port ${port} within 10 seconds`)
  }

  log.info("Bridge is ready and accepting connections", { port, bridgePid: bridge.pid })

  // We don't know clangd's PID from here (it's a grandchild), so we store 0.
  // The bridge writes its own PID to the state file once the language server is up.
  // We read it back after the bridge is ready.
  // IMPORTANT: Also preserve httpPort/httpPid if they exist (HTTP daemon may have written them first).
  const stateAfter = readState(root)
  const serverPid = stateAfter?.serverPid ?? 0

  log.debug("spawnDaemon: read existing state before writing", {
    stateAfter,
    httpPortFromState: stateAfter?.httpPort,
    httpPidFromState: stateAfter?.httpPid,
  })

  const state: DaemonState = {
    version: STATE_VERSION,
    bridgePid: bridge.pid,
    serverPid,
    port,
    root,
    serverBin: opts.serverBin,
    serverArgs: opts.serverArgs,
    startedAt: new Date().toISOString(),
    // Preserve httpPort and httpPid if they were written by the HTTP daemon
    httpPort: stateAfter?.httpPort,
    httpPid: stateAfter?.httpPid,
  }

  writeState(root, state)
  log.info("Daemon state written", {
    port,
    bridgePid: bridge.pid,
    serverPid,
    httpPort: state.httpPort,
    httpPid: state.httpPid,
  })
  return state
}

/** Polls a TCP port until it accepts connections or the timeout expires. */
export async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const open = await isTcpPortOpen(port, 500)
    if (open) return true
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

/** Resolve the path to the bridge script relative to this file's location. */
export function resolveBridgeScript(): string {
  // In production (dist/): bridge.js is next to index.js
  // In development (src/): bridge.ts is next to index.ts — Bun runs it directly
  const thisFile = fileURLToPath(import.meta.url)
  const thisDir = path.dirname(thisFile)

  // Try dist/bridge.js first (production build)
  const distBridge = path.join(thisDir, "bridge.js")
  try {
    readFileSync(distBridge)
    return distBridge
  } catch {
    // Fall back to src/bridge.ts (dev mode with Bun)
    return path.join(thisDir, "../bridge/index.ts")
  }
}

// ── HTTP JSON daemon spawn ────────────────────────────────────────────────────

export interface SpawnHttpDaemonOptions {
  root: string
  serverBin: string
  serverArgs: string[]
  /** Path to the compiled bridge script (dist/bridge.js) — index.js is derived from it */
  bridgeScript: string
}

/**
 * Spawns the IntelGraph HTTP JSON server as a detached daemon.
 * Picks a free port automatically via the OS, writes it to the state file,
 * and returns when the HTTP port is confirmed open (max 15s).
 *
 * Uses a lock file to prevent race conditions when multiple proxies start simultaneously.
 *
 * The daemon runs: index.js --http-daemon --http-port <N> --root <root> ...
 * It is detached and unref'd so it outlives the stdio proxy process.
 */
export async function spawnHttpDaemon(opts: SpawnHttpDaemonOptions): Promise<{ httpPort: number; httpPid: number }> {
  // Normalise root first — guards against .git being passed as root
  const root = normaliseRoot(opts.root)
  if (root !== opts.root) {
    log.warn("spawnHttpDaemon: root normalised", { original: opts.root, normalised: root })
  }

  log.info("spawnHttpDaemon: attempting to acquire spawn lock", { root })

  // Try to acquire spawn lock
  if (!tryAcquireSpawnLock(root)) {
    log.info("Another process is spawning HTTP daemon — waiting for lock release", { root })
    const released = await waitForSpawnLockRelease(root, 30_000)

    if (!released) {
      // Lock holder may have crashed — force-remove stale lock and try again
      log.warn("Spawn lock timed out — removing stale lock and retrying", { root })
      releaseSpawnLock(root)

      if (!tryAcquireSpawnLock(root)) {
        throw new Error("Failed to acquire spawn lock after stale lock removal")
      }
    } else {
      // Lock was released — check if daemon is now running
      const state = readState(root)
      if (state?.httpPort && state.httpPid && (await isTcpPortOpen(state.httpPort))) {
        log.info("HTTP daemon was spawned by another process — reusing", {
          httpPort: state.httpPort,
          httpPid: state.httpPid,
        })
        return { httpPort: state.httpPort, httpPid: state.httpPid }
      }

      // Daemon not running — acquire lock and spawn
      if (!tryAcquireSpawnLock(root)) {
        throw new Error("Failed to acquire spawn lock after wait")
      }
    }
  }

  try {
    const httpPort = await findFreePort()
    log.info("Allocated free port for HTTP daemon", { httpPort })

    // index.js lives next to bridge.js in dist/
    const indexScript = opts.bridgeScript.replace(/bridge\.(js|ts)$/, (_, ext) =>
      ext === "ts" ? "index.ts" : "index.js",
    )

    const args = [
      indexScript,
      "--http-daemon",
      "--http-port",
      String(httpPort),
      "--root",
      root,
      "--server",
      opts.serverBin,
    ]
    if (opts.serverArgs.length) {
      args.push("--server-args", opts.serverArgs.join(","))
    }

    log.info("Spawning HTTP JSON daemon process (detached)", {
      httpPort,
      indexScript,
      serverBin: opts.serverBin,
      serverArgs: opts.serverArgs,
      root,
    })

    const daemon = spawn(process.execPath, args, {
      detached: true,
      stdio: "ignore",
      cwd: root,
    })

    if (!daemon.pid) throw new Error("Failed to spawn HTTP JSON daemon (no PID)")

    // Listen for unexpected HTTP daemon death while proxy is still running.
    // Clears httpPort/httpPid from state so the next proxy doesn't think the daemon is alive.
    const httpDaemonPid = daemon.pid
    daemon.on("exit", (code, signal) => {
      log.warn("HTTP daemon exited while proxy still running — clearing HTTP state", {
        httpPid: httpDaemonPid,
        code,
        signal,
        httpPort,
        root,
      })
      const currentState = readState(root)
      if (currentState && currentState.httpPid === httpDaemonPid) {
        const { httpPort: _hp, httpPid: _hpid, ...rest } = currentState
        writeState(root, rest)
      }
    })

    daemon.unref()

    log.info("HTTP JSON daemon process spawned", { httpPid: daemon.pid, httpPort })

    log.info("Waiting for HTTP daemon to start accepting connections…", { httpPort, timeoutMs: 15_000 })
    const ready = await waitForPort(httpPort, 15_000)
    if (!ready) throw new Error(`HTTP JSON daemon did not start on port ${httpPort} within 15s`)

    log.info("HTTP JSON daemon is ready", { httpPort, httpPid: daemon.pid })
    return { httpPort, httpPid: daemon.pid }
  } finally {
    // Always release lock when done (success or failure)
    releaseSpawnLock(root)
  }
}

// ── IDaemonManager binding ────────────────────────────────────────────────────
//
// Real-implementation binding for the IDaemonManager port. Consumers
// depend on the interface from `./ports.js`; this is the concrete that
// the composition root wires up. Tests use `FakeDaemonManager` from
// `./fakes/` instead.

import type { IDaemonManager } from "./ports.js"

export const daemonManager: IDaemonManager = {
  readState,
  writeState,
  clearState,
  checkDaemonAlive,
  spawnDaemon,
  spawnHttpDaemon,
}
