/**
 * bootstrap.ts — Config parsing, CLI args, reconnect constants, and retry logic.
 * Pure config module — no side effects.
 */

import { readFileSync } from "fs"
import path from "path"
import { loggerPort } from "../logging/logger.js"
const log = loggerPort.child("bootstrap")
import { resolveConfigPath } from "./config.js"

// ── Workspace config (.intelgraph.json) ─────────────────────────────────────

/**
 * Intelligence backend query strategy.
 *   - "graph" → SQLite intelligence graph. All languages. Provides direct
 *               callers, indirect/runtime callers, dispatch chains, callback
 *               registrations, HW entities — everything the extractors found.
 *               This is the default for ALL languages.
 *   - "lsp"   → clangd LSP only. Direct call hierarchy only — no indirect
 *               callers, no runtime chains, no HW entities. Legacy mode.
 */
export type IntelligenceBackendKind = "graph" | "lsp"

export interface WorkspaceConfig {
  root?: string
  /** Generic server path. Replaces clangd (backward-compat alias). */
  server?: string
  /** Backward-compat alias for server. */
  clangd?: string
  /** Server arguments. */
  args?: string[]
  enabled?: boolean
  /**
   * Primary language of the workspace.
   * Defaults to "c" for backward compat.
   */
  language?: string
  /**
   * Intelligence backend strategy. Defaults to "graph" (SQLite intelligence
   * graph) which works for all languages and provides indirect/runtime
   * callers. Set to "lsp" to use clangd-only direct call hierarchy (C/C++).
   */
  intelligence?: IntelligenceBackendKind
  compileCommandsCleaning?: {
    preflightPolicy?: "reject" | "fix" | "remap"
  }
}

/** Resolve the effective intelligence backend for a workspace config. */
export function resolveIntelligenceBackend(ws: WorkspaceConfig): "lsp" | "graph" {
  if (ws.intelligence === "lsp") return "lsp"
  // Default: always graph — it has everything (direct + indirect + runtime)
  return "graph"
}

export function readWorkspaceConfig(dir: string): WorkspaceConfig {
  // IntelGraph reads .intelgraph.json only. See resolveConfigPath in config.ts.
  const configPath = resolveConfigPath(dir)
  try {
    const text = readFileSync(configPath, "utf8")
    const cfg = JSON.parse(text) as WorkspaceConfig
    return cfg
  } catch {
    // File missing or malformed — all fields default
    return {}
  }
}

// ── Argument parsing ──────────────────────────────────────────────────────────

export function parseArgs(argv: string[]): {
  root: string
  port: number | undefined
  httpDaemon: boolean
  httpPort: number | undefined
  serverPath: string | undefined
  serverArgs: string[] | undefined
  /** Backward-compat alias for serverPath */
  clangdPath?: string | undefined
  /** Backward-compat alias for serverArgs */
  clangdArgs?: string[] | undefined
} {
  const args = argv.slice(2) // strip "node" and script path

  let root = ""
  let port: number | undefined
  let httpDaemon = false
  let httpPort: number | undefined
  let serverPath: string | undefined
  let serverArgs: string[] | undefined

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue
    if (arg === "--http-daemon") {
      httpDaemon = true
    } else if (arg === "--http-port") {
      httpPort = parseInt(args[++i] ?? "0", 10)
    } else if (arg.startsWith("--http-port=")) {
      httpPort = parseInt(arg.slice("--http-port=".length), 10)
    } else if (arg === "--root" || arg === "-r") {
      root = args[++i] ?? ""
    } else if (arg.startsWith("--root=")) {
      root = arg.slice("--root=".length)
    } else if (arg === "--port" || arg === "-p") {
      port = parseInt(args[++i] ?? "7777", 10)
    } else if (arg.startsWith("--port=")) {
      port = parseInt(arg.slice("--port=".length), 10)
    } else if (arg === "--server") {
      serverPath = args[++i]
    } else if (arg.startsWith("--server=")) {
      serverPath = arg.slice("--server=".length)
    } else if (arg === "--server-args") {
      serverArgs = (args[++i] ?? "").split(",").filter(Boolean)
    } else if (arg.startsWith("--server-args=")) {
      serverArgs = arg.slice("--server-args=".length).split(",").filter(Boolean)
    } else if (arg === "--clangd") {
      // Backward-compat: --clangd maps to --server
      serverPath = args[++i]
    } else if (arg.startsWith("--clangd=")) {
      // Backward-compat: --clangd= maps to --server=
      serverPath = arg.slice("--clangd=".length)
    } else if (arg === "--clangd-args") {
      // Backward-compat: --clangd-args maps to --server-args
      serverArgs = (args[++i] ?? "").split(",").filter(Boolean)
    } else if (arg.startsWith("--clangd-args=")) {
      // Backward-compat: --clangd-args= maps to --server-args=
      serverArgs = arg.slice("--clangd-args=".length).split(",").filter(Boolean)
    } else if (arg === "--help" || arg === "-h") {
      printHelp()
      process.exit(0)
    }
  }

  return { root, port, httpDaemon, httpPort, serverPath, serverArgs, clangdPath: serverPath, clangdArgs: serverArgs }
}


export function printHelp(): void {
  process.stderr.write(`
intelgraph — plugin-based code intelligence graph (clangd + tree-sitter) over HTTP JSON API

Configuration is read from .intelgraph.json at the working directory. All CLI flags
are optional and override the config file.

Usage:
  intelgraph [options]

Options:
  --root <path>         Workspace root (default: value in workspace config, then process.cwd()).
  --port <number>       HTTP port (default: 7777).
  --server <path>       Path to language server binary (default: "clangd" from PATH).
  --server-args <args>  Extra args for language server, comma-separated.
  --clangd <path>       (Deprecated alias for --server)
  --clangd-args <args>  (Deprecated alias for --server-args)

HTTP JSON API:
  POST /api/query       Intelligence query (see API docs for request schema).
  GET  /api/health      Health check.
  GET  /api/graph       Graph snapshot.
  GET  /api/graph/diff  Graph diff (?from=N&to=M).
  GET  /api/file        File content (?path=...).

.intelgraph.json (place at project root, all fields optional):
  {
    "root":     "/path/to/project",
    "server":   "/usr/local/bin/clangd-20",
    "language": "c",
    "args":     ["--background-index", "--query-driver=/usr/bin/arm-none-eabi-gcc", "--log=error"],
    "enabled":  true
  }

Examples:
  # Zero-config: reads workspace config, starts HTTP API on port 7777
  intelgraph

  # Explicit port
  intelgraph --port 8080

  # Explicit root override
  intelgraph --root /workspace/myproject --port 7777
`)
}

// ── Reconnect with exponential backoff ───────────────────────────────────────

export const RECONNECT_BASE_DELAY_MS = 2_000
export const RECONNECT_MAX_DELAY_MS = 30_000
export const RECONNECT_MAX_ATTEMPTS = 0 // 0 = retry forever
// Minimum delay before scheduling a reconnect after a connection drop.
// This prevents a reconnect storm: when the bridge destroys the old socket
// upon receiving a new connection, the onClose fires on the old client and
// would immediately trigger another connectToClangd — which in turn causes
// the bridge to destroy the current socket, and so on infinitely.
export const RECONNECT_DEBOUNCE_MS = 1_000

export async function retryWithBackoff<T>(
  label: string,
  fn: () => Promise<T>,
  maxAttempts = RECONNECT_MAX_ATTEMPTS,
): Promise<T> {
  let attempt = 0
  let delay = RECONNECT_BASE_DELAY_MS
  while (true) {
    attempt++
    try {
      log.info(`[reconnect] Attempt ${attempt} for "${label}"`)
      const result = await fn()
      log.info(`[reconnect] "${label}" succeeded on attempt ${attempt}`)
      return result
    } catch (err: any) {
      const willRetry = maxAttempts === 0 || attempt < maxAttempts
      log.warn(`[reconnect] Attempt ${attempt} failed for "${label}": ${err?.message ?? err}`, {
        attempt,
        delay,
        willRetry,
        maxAttempts,
      })
      if (!willRetry) throw err
      log.info(`[reconnect] Waiting ${delay}ms before retry…`)
      await new Promise((r) => setTimeout(r, delay))
      delay = Math.min(delay * 2, RECONNECT_MAX_DELAY_MS)
    }
  }
}
