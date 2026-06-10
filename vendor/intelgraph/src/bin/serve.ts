#!/usr/bin/env node
/**
 * serve.ts — Standalone HTTP JSON API server for IntelGraph.
 *
 * Starts IntelGraph as a pure JSON API server.
 *
 * Usage:
 *   intelgraph-serve [workspace] [--port=<n>] [--help]
 *
 *   workspace     Workspace root (default: cwd)
 *   --port=<n>    Port to listen on (default: 7777)
 *   --help / -h   Show usage
 *
 * Exit codes:
 *   0  — success / help printed
 *   1  — fatal startup error
 *   2  — bad arguments
 */

import { resolve } from "node:path"
import { readWorkspaceConfig } from "../config/bootstrap.js"
import { normaliseRoot } from "../daemon/index.js"
import { initLogger, log } from "../logging/logger.js"
import { IndexTracker } from "../tracking/index.js"
import { initIntelligenceBackend, shutdownIntelligenceBackend } from "../intelligence/init.js"
import { createUnifiedBackend } from "../backend/unified-backend.js"
import { startHttp } from "../core/server.js"
import type { BackendDeps } from "../core/types.js"

// ── Usage ───────────────────────────────────────────────────────────────────

const USAGE = `\
intelgraph-serve — IntelGraph HTTP JSON API server

Usage:
  intelgraph-serve [workspace] [--port=<n>] [--help]

Options:
  workspace     Workspace root directory (default: current working directory)
  --port=<n>    Port to listen on (default: 7777)
  --help, -h    Show this help message

Examples:
  intelgraph-serve
  intelgraph-serve /path/to/project
  intelgraph-serve /path/to/project --port=8080
`

// ── Argument parsing ─────────────────────────────────────────────────────────

interface CliArgs {
  root: string | null
  port: number
  help: boolean
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2)
  let root: string | null = null
  let port = 7777
  let help = false

  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      help = true
    } else if (arg.startsWith("--port=")) {
      const raw = arg.slice("--port=".length)
      const n = parseInt(raw, 10)
      if (isNaN(n) || n < 1 || n > 65535) {
        console.error(`Error: invalid port value: ${raw}`)
        process.exit(2)
      }
      port = n
    } else if (!arg.startsWith("--")) {
      root = resolve(arg)
    } else {
      console.error(`Error: unknown flag: ${arg}`)
      process.exit(2)
    }
  }

  return { root, port, help }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cli = parseArgs(process.argv)

  if (cli.help) {
    process.stdout.write(USAGE)
    process.exit(0)
  }

  const cwd = process.cwd()

  // ── Initialize logger first ───────────────────────────────────────────────
  initLogger({ component: "intelgraph-serve" })

  // ── Read workspace config ─────────────────────────────────────────────────
  const ws = readWorkspaceConfig(cwd)

  // ── Resolve workspace root ────────────────────────────────────────────────
  const root = normaliseRoot(cli.root ?? ws.root ?? cwd)

  log("INFO", "intelgraph-serve starting", {
    pid: process.pid,
    cwd,
    root,
    port: cli.port,
  })

  // ── Shared state ──────────────────────────────────────────────────────────
  const tracker = new IndexTracker()

  // ── Lazy LSP client ───────────────────────────────────────────────────────
  // Returns empty arrays until a real LSP client connects. This lets the
  // intelligence backend initialise before any LSP server is available.
  const lazyLspClient = {
    documentSymbol: (_filePath: string) => Promise.resolve([]),
    incomingCalls: (_filePath: string, _line: number, _char: number) => Promise.resolve([]),
    outgoingCalls: (_filePath: string, _line: number, _char: number) => Promise.resolve([]),
  }

  // ── Intelligence backend ──────────────────────────────────────────────────
  await initIntelligenceBackend(undefined, lazyLspClient).catch((err) =>
    log("WARN", "intelligence backend init failed — continuing without it", {
      err: String(err),
    }),
  )

  // ── Unified backend + deps ────────────────────────────────────────────────
  // getClient is a no-op stub — serve mode does not manage an LSP connection.
  const getClient = () => Promise.reject(new Error("No LSP client in serve mode"))
  const backend = createUnifiedBackend(getClient, tracker)

  const deps: BackendDeps = {
    getClient,
    tracker,
    backend,
    workspaceRoot: root,
    onGracefulShutdown: shutdownIntelligenceBackend,
  }

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  const shutdown = async (signal: string): Promise<void> => {
    log("INFO", "Shutdown signal received", { signal, pid: process.pid })
    if (deps.onGracefulShutdown) {
      try {
        await deps.onGracefulShutdown()
      } catch (err) {
        log("WARN", "Error during graceful shutdown", {
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }
    process.exit(0)
  }
  process.on("SIGINT", () => {
    void shutdown("SIGINT")
  })
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM")
  })

  // ── Start HTTP server ─────────────────────────────────────────────────────
  await startHttp(deps, cli.port)
  log("INFO", "HTTP API server ready", {
    url: `http://localhost:${cli.port}`,
    port: cli.port,
  })
}

main().catch((err) => {
  console.error("Fatal error in intelgraph-serve:", err instanceof Error ? err.message : String(err))
  process.exit(1)
})
