/**
 * lifecycle.ts — Daemon management and clangd connection lifecycle.
 * Extracted from src/index.ts — pure orchestration, no side effects at import time.
 */

import { LspClient } from "../lsp/index.js"
import {
  readState,
  writeState,
  clearState,
  checkDaemonAlive,
  spawnDaemon,
  resolveBridgeScript,
  type DaemonState,
} from "../daemon/index.js"
import { cleanCompileCommands } from "../utils/compile-commands-cleaner.js"
import { configLoader } from "../config/config.js"
import { IndexTracker } from "../tracking/index.js"
import { loggerPort } from "../logging/logger.js"
import {
  retryWithBackoff,
  RECONNECT_DEBOUNCE_MS,
} from "../config/bootstrap.js"
import { startHttp } from "./server.js"
import type { BackendDeps } from "./types.js"
import { createUnifiedBackend } from "../backend/unified-backend.js"

const log = loggerPort.child("lifecycle")

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LifecycleConfig {
  root: string
  workspaceId: string
  serverPath: string
  serverArgs: string[]
  /** Language hint (defaults to "c") */
  language?: string
  wsCompileCommandsPolicy?: "reject" | "fix" | "remap"
}

// ── Daemon management ─────────────────────────────────────────────────────────

/**
 * Ensure the clangd daemon is running and return the TCP port.
 * - If a valid state file exists and the daemon is alive → reuse it.
 * - Otherwise → spawn a new daemon and write a fresh state file.
 *
 * Returns { port, isNew } where isNew=true means we just spawned clangd
 * (needs initialize handshake) and isNew=false means we're reconnecting
 * to an already-initialized clangd (skip initialize).
 */
export async function getOrStartDaemon(
  config: LifecycleConfig,
): Promise<{ port: number; isNew: boolean }> {
  const { root, workspaceId, serverPath, serverArgs, language, wsCompileCommandsPolicy } = config
  const state = readState(root)

  if (state) {
    log.info("Found existing daemon state — checking liveness", {
      port: state.port,
      bridgePid: state.bridgePid,
      serverPid: state.serverPid,
      httpPort: state.httpPort,
      httpPid: state.httpPid,
      startedAt: state.startedAt,
    })
    const alive = await checkDaemonAlive(state, root)
    if (alive) {
      log.info("Reusing existing language server daemon", { port: state.port, bridgePid: state.bridgePid })
      return { port: state.port, isNew: false }
    }
    // Only clear state if httpPort is not present (otherwise we'd lose the HTTP daemon info)
    if (!state.httpPort) {
      log.warn("Daemon is stale — clearing state and respawning", {
        staleBridgePid: state.bridgePid,
        stalePort: state.port,
      })
      clearState(root)
    } else {
      log.info("Bridge is stale but HTTP daemon is alive — preserving httpPort and spawning new bridge", {
        httpPort: state.httpPort,
        httpPid: state.httpPid,
      })
    }
  } else {
    log.info("No existing daemon state — spawning fresh language server daemon", { root })
  }

  // ── Clean compile_commands.json before spawning (C/C++ only) ──────────────────────────
  // Only run for C/C++ codebases by default (other languages don't use compile_commands)
  const isCLanguage = language === "c" || language === "cpp" || !language // default to c for backward compat
  const existingCfg = configLoader.readConfig(root)
  const cleaningConfig = existingCfg.compileCommandsCleaning ?? {}
  if (isCLanguage && cleaningConfig.enabled !== false) {
    // Default: enabled unless explicitly disabled
    try {
      const result = await cleanCompileCommands(root, {
        enabled: true,
        removeTests: cleaningConfig.removeTests ?? false,
        cleanFlags: cleaningConfig.cleanFlags ?? true,
        requireZeroUnmatched: cleaningConfig.requireZeroUnmatched ?? false,
        preflightPolicy: cleaningConfig.preflightPolicy ?? wsCompileCommandsPolicy ?? "remap",
        lastCleanedHash: cleaningConfig.lastCleanedHash,
        lastCleanedAt: cleaningConfig.lastCleanedAt,
      })

      // Mirror preflight status into daemon state for runtime visibility.
      const stateForPreflight = readState(root)
      if (stateForPreflight) {
        writeState(root, {
          ...stateForPreflight,
          workspaceId,
          compileCommandsPreflight: {
            ranAt: result.stats.ranAt,
            patchEntries: result.stats.patchEntries,
            mappedPatchCount: result.stats.mappedPatchCount,
            unmatchedPatchCount: result.stats.unmatchedPatchCount,
            requireZeroUnmatched: cleaningConfig.requireZeroUnmatched ?? false,
            preflightPolicy: result.stats.preflightPolicy,
            externalEntryCount: result.stats.externalEntryCount,
            remappedExternalCount: result.stats.remappedExternalCount,
            removedExternalCount: result.stats.removedExternalCount,
            preflightOk: result.preflightOk,
          },
        })
      }

      if (!result.preflightOk) {
        log.error("compile_commands preflight failed: unmatched patch files remain", {
          unmatchedPatchCount: result.stats.unmatchedPatchCount,
          externalEntryCount: result.stats.externalEntryCount,
          preflightPolicy: result.stats.preflightPolicy,
          report: `${root}/patch_unmatched.txt`,
        })
        throw new Error("compile_commands preflight failed (unmatched patch files)")
      }

      if (result.cleaned) {
        log.info("compile_commands.json cleaned successfully", result.stats as unknown as Record<string, unknown>)
        // Persist the new hash so next run can skip cleaning if unchanged.
        configLoader.writeConfig(root, {
          ...existingCfg,
          compileCommandsCleaning: {
            ...cleaningConfig,
            lastCleanedHash: result.stats.newHash,
            lastCleanedAt: result.stats.cleanedAt,
          },
        })
      }
    } catch (err) {
      log.error("Failed to clean compile_commands.json", err instanceof Error ? err : { raw: String(err) })
      throw err
    }
  } else {
    log.info("compile_commands.json cleaning disabled in config", { root })
  }

  // ── Spawn new daemon ─────────────────────────────────────────────────────

  const bridgeScript = resolveBridgeScript()
  log.info("Resolved bridge script", { bridgeScript })

  const newState: DaemonState = await spawnDaemon({
    root,
    serverBin: serverPath,
    serverArgs,
    bridgeScript,
  })

  log.info("New daemon started", {
    port: newState.port,
    bridgePid: newState.bridgePid,
    serverPid: newState.serverPid,
    httpPort: newState.httpPort,
    httpPid: newState.httpPid,
    startedAt: newState.startedAt,
  })
  return { port: newState.port, isNew: true }
}

// ── Connection management ─────────────────────────────────────────────────────

/**
 * Connect (or reconnect) to the language server daemon.
 * Handles the case where the TCP connection drops (e.g. bridge restarted).
 *
 * @param config       Lifecycle config (root, server path/args, etc.)
 * @param tracker      Index readiness tracker
 * @param onReconnect  Called when a new client is established after a drop
 * @param retryFn      Retry-with-backoff function (injected for testability)
 */
export async function connectToClangd(
  config: LifecycleConfig,
  tracker: IndexTracker,
  onReconnect: (newClient: LspClient) => void,
  retryFn: typeof retryWithBackoff,
): Promise<LspClient> {
  const { root } = config
  const { port: daemonPort, isNew } = await getOrStartDaemon(config)

  log.info("Connecting to language server daemon via TCP", { daemonPort, isNew, root })
  // skipInit=true when reconnecting to an already-initialized language server instance
  const client = await LspClient.createFromSocket(daemonPort, root, tracker, !isNew)
  if (!isNew) {
    tracker.markReady()
    log.info("Marked index as ready (reconnected to warm daemon)", { daemonPort })
  } else {
    log.info("LSP initialize handshake sent to fresh daemon", { daemonPort })
  }
  log.info("Connected to language server daemon successfully", { daemonPort, isNew })

  // Watch for connection drops — reconnect automatically with backoff.
  // IMPORTANT: debounce the reconnect by RECONNECT_DEBOUNCE_MS.
  // Without this, a reconnect storm occurs: the bridge destroys the old
  // socket when a new connection arrives, which fires onClose on the old
  // client, which immediately triggers another connectToClangd, which
  // causes the bridge to destroy the current socket, and so on infinitely.
  client.onConnectionClose(() => {
    log.warn("Connection to clangd daemon dropped — scheduling reconnect", { daemonPort })

    // Debounce: wait before reconnecting so the bridge has time to settle
    const reconnectP = new Promise<void>((r) => setTimeout(r, RECONNECT_DEBOUNCE_MS))
      .then(() => retryFn("connectToClangd", () => connectToClangd(config, tracker, onReconnect, retryFn)))
      .then((c) => {
        log.info("Reconnected to clangd daemon successfully after drop")
        onReconnect(c)
        return c
      })
      .catch((err) => {
        // retryWithBackoff with maxAttempts=0 never rejects, but guard anyway
        log.error("Reconnect loop exited unexpectedly — this should not happen", err)
        throw err
      })

    // Suppress unhandled rejection — caller manages state via onReconnect
    reconnectP.catch(() => {})
  })

  return client
}

// ── Lazy client factory ───────────────────────────────────────────────────────

/**
 * Build a getClient() function that lazily connects on first call and
 * waits for any in-flight reconnect before returning.
 *
 * @param getState   Returns current { currentClient, reconnectPromise }
 * @param connectFn  Called to establish a new connection
 * @param setState   Patches { currentClient, reconnectPromise }
 */
export function makeGetClient(
  getState: () => { currentClient: LspClient | null; reconnectPromise: Promise<LspClient> | null },
  connectFn: () => Promise<LspClient>,
  setState: (patch: { currentClient?: LspClient | null; reconnectPromise?: Promise<LspClient> | null }) => void,
): () => Promise<LspClient> {
  return (): Promise<LspClient> => {
    const { currentClient, reconnectPromise } = getState()

    if (reconnectPromise) {
      log.debug("getClient: reconnect in progress — waiting for it")
      return reconnectPromise
    }
    if (currentClient) return Promise.resolve(currentClient)

    // Lazy initialization: if client is null (HTTP daemon mode), connect now
    log.info("Lazy-initializing clangd client (first tool call in HTTP daemon mode)")
    const p = connectFn()
      .then((c) => {
        setState({ currentClient: c, reconnectPromise: null })
        return c
      })
      .catch((err) => {
        setState({ reconnectPromise: null })
        throw err
      })
    setState({ reconnectPromise: p })
    return p
  }
}

// ── Transport startup helpers ─────────────────────────────────────────────────

/**
 * Register this process as the HTTP JSON daemon in the state file, then start
 * the HTTP server. Called when --http-daemon flag is set.
 */
export async function startAsHttpDaemon(
  getClient: () => Promise<LspClient>,
  tracker: IndexTracker,
  httpPort: number,
  root: string,
  workspaceId: string,
  serverPath: string,
  serverArgs: string[],
  language?: string,
  onGracefulShutdown?: () => Promise<void>,
): Promise<void> {
  log.info("Starting HTTP JSON daemon", { httpPort, root, pid: process.pid })

  // Write (or update) the state file so other processes can discover this daemon.
  // Merge with any existing state to preserve bridgePid/serverPid if present.
  const existingState = readState(root)
  writeState(root, {
    version: 1,
    bridgePid: existingState?.bridgePid ?? 0,
    serverPid: existingState?.serverPid ?? 0,
    port: existingState?.port ?? 0,
    root,
    workspaceId,
    serverBin: serverPath,
    serverArgs,
    startedAt: existingState?.startedAt ?? new Date().toISOString(),
    httpPort,
    httpPid: process.pid,
    compileCommandsPreflight: existingState?.compileCommandsPreflight,
  })
  log.info("State file written for HTTP daemon", { httpPort, httpPid: process.pid, root })

  const backend = createUnifiedBackend(getClient, tracker)
  const deps: BackendDeps = { getClient, tracker, backend, onGracefulShutdown }
  await startHttp(deps, httpPort)
  log.info("HTTP API daemon ready", { url: `http://127.0.0.1:${httpPort}/`, httpPort })
}
