/**
 * intelligence/init.ts
 * Initialises the intelligence backend at startup using the embedded
 * SQLite store. Reads INTELLIGENCE_DB_PATH from env (default
 * .intelgraph/intelligence.db). No external service required.
 *
 * Call initIntelligenceBackend() once during server startup. Returns
 * true after the backend is wired into the dep singletons.
 */
import { createIntelligenceBackend } from "./backend-factory.js"
import type { LspClientForExtraction, IntelligenceBackend } from "./backend-types.js"
import { setDbFoundation, setIngestDeps, setExtractFileDeps } from "./tools/index.js"
import { loggerPort } from "../logging/logger.js"
import type { ClangdEnricher, CParserEnricher } from "./index.js"
import type { ILanguageClient } from "../lsp/ports.js"
import type { OrchestratorRunnerDeps } from "./orchestrator-runner.js"
import type { IDbFoundation } from "./contracts/db-foundation.js"
import { collectIndirectCallers } from "../tools/indirect-callers.js"
import { pluginRegistry } from "../plugins/index.js"
import { join, relative, extname } from "node:path"
import { existsSync, watch } from "node:fs"

// ── Module-level backend storage for graceful shutdown ──────────────────────
let _backend: { close: () => Promise<void> } | null = null
const log = loggerPort.child("intelligence:init")

/**
 * Gracefully shut down the intelligence backend.
 * Called when the HTTP daemon is idle or receives a termination signal.
 * Closes the SQLite database file (flushes WAL, releases locks).
 */
export async function shutdownIntelligenceBackend(): Promise<void> {
  if (!_backend) return
  const b = _backend
  _backend = null
  await b.close()
}

function resolveDefaultDbPath(): string {
  return join(".intelgraph", "intelligence.db")
}

export async function initIntelligenceBackend(
  enrichers?: {
    clangdEnricher?: ClangdEnricher
    cParserEnricher?: CParserEnricher
  },
  lspClient?: LspClientForExtraction,
  wireExternalDeps?: (deps: OrchestratorRunnerDeps, db: IDbFoundation) => void,
): Promise<boolean> {
  // Resolve the SQLite DB path. INTELLIGENCE_DB_PATH wins; otherwise
  // use .intelgraph/intelligence.db.
  const sqliteDbPath = process.env.INTELLIGENCE_DB_PATH ?? resolveDefaultDbPath()

  const noopEnricher = {
    source: "clangd" as const,
    enrich: async () => ({
      attempts: [{ source: "clangd" as const, status: "failed" as const }],
      persistedRows: 0,
    }),
  }
  const noopCParser = {
    source: "c_parser" as const,
    enrich: async () => ({
      attempts: [{ source: "c_parser" as const, status: "failed" as const }],
      persistedRows: 0,
    }),
  }
  const resolvedEnrichers = {
    clangdEnricher: enrichers?.clangdEnricher ?? noopEnricher,
    cParserEnricher: enrichers?.cParserEnricher ?? noopCParser,
  }

  log.info("intelligence backend: initialising embedded SQLite store", {
    dbPath: sqliteDbPath,
  })

  const backend: IntelligenceBackend = await createIntelligenceBackend(sqliteDbPath, resolvedEnrichers, lspClient)
  // initSchema runs inside createIntelligenceBackend; runMigrations is a
  // no-op alias today, called for forward compatibility.
  await backend.db.runMigrations()

  // Store backend for graceful shutdown on daemon idle/exit
  _backend = backend

  setDbFoundation(backend.db)

  // Wire the external tool-layer singletons. The caller (composition root)
  // supplies the setter callback so this module stays free of tools/ imports.
  wireExternalDeps?.(backend.deps, backend.db)

  // Build an indirect caller resolver closure only when a real language
  // client is available — it needs prepareCallHierarchy and references in
  // addition to the three methods declared in LspClientForExtraction.
  const fullLspClient = lspClient as ILanguageClient | undefined
  const indirectCallerResolver =
    fullLspClient && typeof (fullLspClient as { prepareCallHierarchy?: unknown }).prepareCallHierarchy === "function"
      ? async (sym: { name: string; file?: string; line?: number }) => {
          if (!sym.file || !sym.line) return null
          try {
            return await collectIndirectCallers(fullLspClient, {
              file: sym.file,
              line: sym.line,
              character: 1,
              resolve: true,
            })
          } catch {
            return null
          }
        }
      : undefined

  // The runner needs a full ILanguageClient. If the caller passed a narrow
  // LspClientForExtraction (no openFile/prepareCallHierarchy/etc.), wrap
  // it with no-op stubs so the LspService doesn't crash on first use. In
  // production the caller passes the real LspClient and this shim is unused.
  const lspForRunner: ILanguageClient =
    fullLspClient ??
    (lspClient as unknown as ILanguageClient | undefined) ??
    ({
      root: "",
      indexTracker: {} as never,
      openFile: async () => false,
      getDiagnostics: () => new Map<string, unknown[]>(),
      hover: async () => null,
      definition: async () => [],
      declaration: async () => [],
      typeDefinition: async () => [],
      references: async () => [],
      implementation: async () => [],
      documentHighlight: async () => [],
      documentSymbol: async () => [],
      workspaceSymbol: async () => [],
      foldingRange: async () => [],
      signatureHelp: async () => null,
      prepareRename: async () => null,
      rename: async () => null,
      formatting: async () => [],
      rangeFormatting: async () => [],
      inlayHints: async () => [],
      prepareCallHierarchy: async () => [],
      incomingCalls: async () => [],
      outgoingCalls: async () => [],
      prepareTypeHierarchy: async () => [],
      supertypes: async () => [],
      subtypes: async () => [],
      codeAction: async () => [],
      semanticTokensFull: async () => null,
      serverInfo: async () => null,
      shutdown: async () => {},
    } as unknown as ILanguageClient)

  const ingestDeps = {
    db: backend.db,
    lsp: lspForRunner,
    sink: backend.sink,
    plugins: pluginRegistry.listExtractors(),
    projection: backend.deps.persistence.graphProjection,
    ingestion: backend.ingestion,
    indirectCallerResolver,
  }
  setIngestDeps(ingestDeps)
  setExtractFileDeps(ingestDeps)

  log.info("intelligence backend: initialised", { dbPath: sqliteDbPath })

  // ── Auto-extract if no ready snapshot exists ─────────────────────────
  // For TS/Rust workspaces, clangd can't index the files, so the only
  // way to populate the intelligence graph is to run the extractors
  // (ts-core, rust-core) explicitly.
  //
  // Preferred workflow: run `npm run extract` (or `npx tsx src/bin/extract.ts`)
  // before starting the daemon. The CLI builds .intelgraph/intelligence.db
  // in one shot, and the daemon reads it instantly.
  //
  // Fallback: if no snapshot exists at startup, kick off extraction in the
  // background so the daemon is responsive immediately. Queries return
  // not_found until extraction completes.
  const workspaceRoot = process.cwd()
  try {
    const existingSnapshot = await backend.db.getLatestReadySnapshot(workspaceRoot)

    if (!existingSnapshot) {
      log.info(
        "intelligence backend: no ready snapshot — starting background extraction (run `npm run extract` to pre-build)",
        { workspaceRoot },
      )

      // Fire-and-forget: don't block daemon init
      void (async () => {
        try {
          const { ExtractorRunner } = await import("./extraction/runner.js")
          const ref = await backend.db.beginSnapshot({
            workspaceRoot,
            compileDbHash: "auto-extract",
            parserVersion: "0.1.0",
          })
          const extractRunner = new ExtractorRunner({
            snapshotId: ref.snapshotId,
            workspaceRoot,
            lsp: lspForRunner,
            sink: backend.sink,
            plugins: pluginRegistry.listExtractors(),
            flushThreshold: 2000,
          })
          const report = await extractRunner.run()
          await backend.db.commitSnapshot(ref.snapshotId)

          let totalFacts = 0
          for (const p of report.perPlugin) {
            const counters = p.metrics?.counters ?? {}
            for (const v of Object.values(counters)) {
              if (typeof v === "number") totalFacts += v
            }
          }
          log.info("intelligence backend: background extraction complete", {
            snapshotId: ref.snapshotId,
            pluginsRun: report.pluginsRun,
            totalFacts,
          })
        } catch (err) {
          log.warn("intelligence backend: background extraction failed", {
            error: String(err),
          })
        }
      })()
    } else {
      log.info("intelligence backend: existing snapshot found, skipping extraction", {
        snapshotId: existingSnapshot.snapshotId,
      })
    }
  } catch (err) {
    log.warn("intelligence backend: snapshot check failed — continuing without extraction", {
      error: String(err),
    })
  }

  // ── File watcher for incremental re-extraction ────────────────────────
  // Watches the workspace for source file changes (TS/JS/Rust) and
  // re-extracts just the changed file. Runs in the daemon process so
  // there's no cold start — re-extraction takes ~100-200ms per file.
  // Same as clangd's textDocument/didSave re-indexing.
  const WATCHED_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs", ".rs"])
  const SKIP_PATTERNS = ["node_modules", "dist", "build", ".git", "target", ".intelgraph"]

  const pendingExtracts = new Map<string, ReturnType<typeof setTimeout>>()

  function shouldWatch(filePath: string): boolean {
    const ext = extname(filePath)
    if (!WATCHED_EXTS.has(ext)) return false
    for (const skip of SKIP_PATTERNS) {
      if (filePath.includes(`/${skip}/`) || filePath.includes(`\\${skip}\\`)) return false
    }
    return true
  }

  async function extractSingleFile(absPath: string): Promise<void> {
    try {
      const snapshot = await backend.db.getLatestReadySnapshot(workspaceRoot)
      if (!snapshot) return

      const relPath = relative(workspaceRoot, absPath)
      if (typeof backend.sink.purgeFile === "function") {
        await backend.sink.purgeFile(snapshot.snapshotId, relPath)
      }

      const { ExtractorRunner } = await import("./extraction/runner.js")
      const runner = new ExtractorRunner({
        snapshotId: snapshot.snapshotId,
        workspaceRoot,
        lsp: lspForRunner,
        sink: backend.sink,
        plugins: pluginRegistry.listExtractors(),
        flushThreshold: 500,
        fileFilter: new Set([absPath]),
      })
      const report = await runner.run()
      const facts = report.perPlugin.reduce((n, p) => n + p.factsYielded, 0)
      if (facts > 0) {
        log.info("intelligence: incremental re-extract", { file: relPath, facts, ms: report.totalDurationMs })
      }
    } catch (err) {
      log.warn("intelligence: incremental re-extract failed", {
        file: absPath,
        error: String(err),
      })
    }
  }

  if (process.env.INTELGRAPH_NO_WATCH === "1") {
    log.info("intelligence: file watcher disabled via INTELGRAPH_NO_WATCH=1")
  } else {
    try {
      const watcher = watch(workspaceRoot, { recursive: true }, (_event, filename) => {
        if (!filename || !shouldWatch(filename)) return
        const absPath = join(workspaceRoot, filename)

        // Debounce: if the same file changes multiple times quickly (e.g.
        // formatter runs after save), only extract once after 300ms of quiet.
        const existing = pendingExtracts.get(absPath)
        if (existing) clearTimeout(existing)
        pendingExtracts.set(
          absPath,
          setTimeout(() => {
            pendingExtracts.delete(absPath)
            void extractSingleFile(absPath)
          }, 300),
        )
      })

      // Handle async errors (e.g. ENOSPC inotify exhaustion on very large
      // trees). Without this listener, the error becomes an uncaught
      // exception and kills the daemon.
      watcher.on("error", (err) => {
        log.warn("intelligence: file watcher error — incremental re-extraction disabled", {
          error: String(err),
        })
        try {
          watcher.close()
        } catch {
          /* ignore */
        }
        for (const timer of pendingExtracts.values()) clearTimeout(timer)
        pendingExtracts.clear()
      })

      // Clean up watcher on shutdown
      const origClose = _backend?.close
      if (_backend && origClose) {
        _backend.close = async () => {
          watcher.close()
          for (const timer of pendingExtracts.values()) clearTimeout(timer)
          pendingExtracts.clear()
          await origClose.call(_backend)
        }
      }

      log.info("intelligence: file watcher active — saves trigger incremental re-extraction")
    } catch {
      // fs.watch with recursive may not be supported on all platforms
      log.info("intelligence: file watcher not available — use `npm run extract` for updates")
    }
  }

  return true
}
