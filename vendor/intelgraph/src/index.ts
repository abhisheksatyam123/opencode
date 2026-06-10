#!/usr/bin/env node
/**
 * index.ts — Entry point for intelgraph.
 *
 * Configuration is read from a workspace-level `.intelgraph.json` file (or the
 * `.intelgraph.json` located at the working directory (i.e. the project
 * root when launched). CLI flags override the file config; all fields are optional.
 *
 * .intelgraph.json schema:
 *   {
 *     "root":    "/path/to/project",   // workspace root (default: process.cwd())
 *     "clangd":  "/usr/bin/clangd-20", // clangd binary  (default: "clangd" from PATH)
 *     "args":    ["--query-driver=…"],  // extra clangd args (default: built-in set)
 *     "enabled": true                  // set false to disable this server (default: true)
 *   }
 *
 * CLI flags (override the workspace config):
 *   --root <path>         Workspace root (where compile_commands.json lives).
 *   --port <number>       HTTP port (default: 7777).
 *   --server <path>       Path to language server binary.
 *   --server-args <args>  Extra args for language server, comma-separated.
 *
 * The server always starts an HTTP JSON API on the given port.
 * Use `src/bin/serve.ts` (npm run serve) for a standalone HTTP server.
 */

import { LspClient } from "./lsp/index.js"
import { startHttp } from "./core/server.js"
import { initLogger, log, logError, getLogFile } from "./logging/logger.js"
import { initIntelligenceBackend, shutdownIntelligenceBackend } from "./intelligence/init.js"
import { IndexTracker } from "./tracking/index.js"
import { normaliseRoot, computeWorkspaceId } from "./daemon/index.js"
import { parseArgs, readWorkspaceConfig, retryWithBackoff, resolveIntelligenceBackend } from "./config/bootstrap.js"
import { connectToClangd, makeGetClient, startAsHttpDaemon, type LifecycleConfig } from "./core/lifecycle.js"
import { createUnifiedBackend } from "./backend/unified-backend.js"
import type { BackendDeps } from "./core/types.js"

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cwd = process.cwd()
  const cli = parseArgs(process.argv)
  const ws = readWorkspaceConfig(cwd)

  // Respect the enabled flag in the workspace config
  if (ws.enabled === false) {
    process.stderr.write("[intelgraph] Disabled by workspace config (.intelgraph.json)\n")
    process.exit(0)
  }

  // Merge precedence: CLI flag > .intelgraph.json > default (cwd / system language server)
  // normaliseRoot strips VCS marker dirs (.git etc.) so state files always land
  // in the real project root, not inside .git/.
  const root = normaliseRoot(cli.root || ws.root || cwd)
  const workspaceId = computeWorkspaceId(root)
  const serverPath = cli.serverPath || ws.server || ws.clangd || "clangd"
  const serverArgs = cli.serverArgs || ws.args || []
  const language = ws.language ?? "c" // default to c for backward compat
  const intelligenceBackend = resolveIntelligenceBackend(ws)
  const port = cli.port ?? 7777

  // ── Initialize logger FIRST so all subsequent messages go to the log file ──
  initLogger({ component: "intelgraph" })

  // ── Shared state (declared early so the lazy LSP proxy can close over it) ───
  const tracker = new IndexTracker()
  const lifecycleConfig: LifecycleConfig = {
    root,
    workspaceId,
    serverPath,
    serverArgs,
    language,
    wsCompileCommandsPolicy: ws.compileCommandsCleaning?.preflightPolicy,
  }

  let currentClient: LspClient | null = null
  let reconnectPromise: Promise<LspClient> | null = null

  // Lazy LSP proxy: delegates each call to currentClient at call time.
  // This lets the intelligence backend be initialised before clangd connects —
  // the real client is injected when the first ingest tool call arrives.
  const lazyLspClient = {
    documentSymbol: (filePath: string) =>
      currentClient ? currentClient.documentSymbol(filePath) : Promise.resolve([]),
    incomingCalls: (filePath: string, line: number, char: number) =>
      currentClient ? currentClient.incomingCalls(filePath, line, char) : Promise.resolve([]),
    outgoingCalls: (filePath: string, line: number, char: number) =>
      currentClient ? currentClient.outgoingCalls(filePath, line, char) : Promise.resolve([]),
  }

  // Register workspace intelligence config so tools can route by backend kind
  const { setWorkspaceIntelligenceConfig, setIntelligenceDeps } = await import("./tools/index.js")
  setWorkspaceIntelligenceConfig(ws, intelligenceBackend)
  log("INFO", "intelligence backend kind resolved", { language, backend: intelligenceBackend })

  // Await intelligence init so the ingest/query tools are ready before the
  // HTTP server starts accepting tool calls. Failure is non-fatal.
  // The wireExternalDeps callback wires intelligence deps into tools singletons
  // here (the composition root) so intelligence/init.ts stays free of tools/ imports.
  await initIntelligenceBackend(undefined, lazyLspClient, (deps) => {
    setIntelligenceDeps(deps)
  }).catch((err) => log("WARN", "intelligence backend init failed — continuing without it", { err: String(err) }))

  log("INFO", "intelgraph starting", {
    pid: process.pid,
    cwd,
    root,
    workspaceId,
    mode: `http (port ${port})`,
    serverBin: serverPath,
    serverArgs,
    language,
    logFile: getLogFile(),
    wsConfigFound: Object.keys(ws).length > 0,
    cliFlags: {
      port: cli.port,
      httpDaemon: cli.httpDaemon,
      httpPort: cli.httpPort,
    },
  })

  // ── Global uncaught error handlers ─────────────────────────────────────────
  process.on("uncaughtException", (err) => {
    logError("UNCAUGHT EXCEPTION — server will exit", err)
    process.exit(1)
  })
  process.on("unhandledRejection", (reason) => {
    logError("UNHANDLED PROMISE REJECTION — continuing", reason instanceof Error ? reason : new Error(String(reason)))
    // Don't exit — log and continue
  })

  const getClient = makeGetClient(
    () => ({ currentClient, reconnectPromise }),
    () =>
      connectToClangd(
        lifecycleConfig,
        tracker,
        (newClient) => {
          currentClient = newClient
          reconnectPromise = null
        },
        retryWithBackoff,
      ),
    (patch) => {
      if ("currentClient" in patch) currentClient = patch.currentClient ?? null
      if ("reconnectPromise" in patch) reconnectPromise = patch.reconnectPromise ?? null
    },
  )

  // ── Graceful shutdown ───────────────────────────────────────────────────────
  // NOTE: We do NOT kill clangd or the bridge on shutdown. They are detached
  // daemons that should keep running so the next server start can reuse
  // the warm index. Only the JSON-RPC connection is closed.
  const shutdown = async (signal: string) => {
    log("INFO", "Shutdown signal received — disconnecting (daemon stays alive)", {
      signal,
      pid: process.pid,
    })
    if (currentClient) {
      currentClient.disconnect()
    }
    process.exit(0)
  }
  process.on("SIGINT", () => shutdown("SIGINT"))
  process.on("SIGTERM", () => shutdown("SIGTERM"))

  // ── Start HTTP API server ───────────────────────────────────────────────────

  if (cli.httpDaemon) {
    // ── HTTP daemon mode (spawned detached by lifecycle) ──────────────────────
    await startAsHttpDaemon(
      getClient,
      tracker,
      cli.httpPort ?? port,
      root,
      workspaceId,
      serverPath,
      serverArgs,
      language,
      shutdownIntelligenceBackend,
    )
  } else {
    // ── Direct HTTP mode ──────────────────────────────────────────────────────
    log("INFO", "Starting HTTP API server", { port, root })
    // Establish initial clangd connection
    currentClient = await connectToClangd(
      lifecycleConfig,
      tracker,
      (newClient) => {
        currentClient = newClient
        reconnectPromise = null
      },
      retryWithBackoff,
    )
    const backend = createUnifiedBackend(getClient, tracker)
    const deps: BackendDeps = {
      getClient,
      tracker,
      backend,
      workspaceRoot: root,
      onGracefulShutdown: shutdownIntelligenceBackend,
    }
    await startHttp(deps, port)
    log("INFO", "HTTP API server ready", { url: `http://localhost:${port}/`, port })
  }
}

main().catch((err) => {
  logError("Fatal error in main()", err)
  process.exit(1)
})
