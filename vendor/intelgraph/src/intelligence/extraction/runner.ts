/**
 * runner.ts — ExtractorRunner.
 *
 * The orchestrator that ties plugins, services, and the FactBus together
 * for one snapshot. The runner is what `ingest-tool.ts` calls instead of
 * the legacy IExtractionAdapter.extract*() batch methods.
 *
 * Responsibilities:
 *   1. Construct the shared parsing services (one per snapshot, not per
 *      plugin) so plugins share LSP/treesitter/ripgrep state.
 *   2. Construct the FactBus that all plugins write into.
 *   3. Filter plugins by their appliesTo() workspace predicate.
 *   4. Build one ExtractionContext per plugin with auto-provenance set.
 *   5. Run plugins in parallel via Promise.allSettled — one plugin
 *      throwing does NOT abort the snapshot, only that plugin's run.
 *   6. Pump yielded facts from each plugin's async generator into the
 *      shared bus, awaiting backpressure naturally.
 *   7. Close the bus to flush any remaining buffered facts.
 *   8. Aggregate per-plugin status, timings, fact counts, and bus stats
 *      into a RunnerReport that ingest-tool turns into the user-facing
 *      IngestReport.
 *
 * What the runner deliberately does NOT do:
 *   - Snapshot lifecycle (begin/commit/fail) — that's the caller's job.
 *     The runner only writes facts; ingest-tool wraps the run() in a
 *     beginSnapshot/commitSnapshot pair.
 *   - Plugin discovery — plugins are passed in by the caller. Plugin
 *     auto-discovery from a registry/manifest comes in Problem 6.
 *   - Capability-based plugin selection — the runner runs every plugin
 *     whose appliesTo predicate matches. Capability filtering by intent
 *     comes when query intents grow capability declarations (later).
 */

import type { ILanguageClient } from "../../lsp/ports.js"
import type { GraphWriteSink } from "../db/graph-rows.js"
import type { IExtractor, WorkspaceProbe } from "./contract.js"
import type { Fact, FactKind } from "./facts.js"
import { FactBus } from "./fact-bus.js"
import type { FactBusOptions } from "./fact-bus.js"
import type { IFactBus, FactBusReport } from "../contracts/fact-bus.js"
import { ExtractionContextImpl, type ExtractionContextOptions } from "./context.js"
import { LspServiceImpl, RipgrepServiceImpl, TreeSitterServiceImpl, WorkspaceServiceImpl } from "./services/index.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ExtractorRunnerOptions {
  /** Snapshot id every fact will be associated with. */
  snapshotId: number
  /** Workspace root the plugins will operate on. */
  workspaceRoot: string
  /**
   * The LSP client for the active workspace. The runner wraps it in an
   * LspServiceImpl shared by every plugin in this run.
   */
  lsp: ILanguageClient
  /** Where the FactBus flushes batches. */
  sink: GraphWriteSink
  /** Plugins to run. Filtered by appliesTo() at runtime. */
  plugins: IExtractor[]
  /** Forwarded to the FactBus. */
  flushThreshold?: number
  /** Cancellation. Plugins should check ctx.signal.aborted on long loops. */
  signal?: AbortSignal
  /**
   * Optional log sink. If absent, plugin logs go to console.error for
   * info/warn/error and are silent for debug.
   */
  logSink?: (level: "debug" | "info" | "warn" | "error", line: string) => void
  /**
   * Optional file filter for incremental extraction. When set, only
   * files whose absolute path is in this set will be returned by
   * ctx.workspace.walkFiles(). Plugins that call walkFiles() will
   * only see the filtered subset, effectively limiting extraction to
   * changed files.
   */
  fileFilter?: Set<string>
  /**
   * Factory that creates the IFactBus for this run. Defaults to the real
   * FactBus. Tests inject a FakeFactBus factory here.
   */
  busFactory?: (opts: FactBusOptions) => IFactBus
}

export type PluginRunStatus = "success" | "error" | "skipped"

export interface PluginRunReport {
  /** Plugin metadata.name. */
  name: string
  /** Plugin metadata.version. */
  version: string
  /** Whether the plugin completed successfully, errored, or was skipped. */
  status: PluginRunStatus
  /** Facts the plugin yielded (pre-dedup). */
  factsYielded: number
  /** Wall-clock duration of the plugin's extract() loop. */
  durationMs: number
  /** Error message if status === "error". */
  errorMessage?: string
  /**
   * Reason the plugin was skipped (only set when status === "skipped").
   * Currently always "appliesTo returned false".
   */
  skipReason?: string
  /** Metrics drained from the plugin's ctx.metrics. */
  metrics?: {
    counters: Record<string, number>
    timings: Record<string, { count: number; totalMs: number; avgMs: number }>
  }
}

export interface RunnerReport {
  snapshotId: number
  workspaceRoot: string
  totalDurationMs: number
  pluginsRun: number
  pluginsSkipped: number
  pluginsFailed: number
  perPlugin: PluginRunReport[]
  bus: FactBusReport
  /** Warnings the runner itself emitted (e.g. plugin metadata issues). */
  warnings: string[]
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class ExtractorRunner {
  constructor(private readonly opts: ExtractorRunnerOptions) {}

  async run(): Promise<RunnerReport> {
    const runStart = Date.now()
    const warnings: string[] = []

    // ---- Shared services ----
    const lspService = new LspServiceImpl(this.opts.lsp, {
      debug: () => {}, // runner-level LSP debug is silent; plugins get their own logger
    })
    const treesitterService = new TreeSitterServiceImpl()
    const ripgrepService = new RipgrepServiceImpl(this.opts.workspaceRoot)
    const baseWorkspaceService = new WorkspaceServiceImpl(this.opts.workspaceRoot)

    // When a fileFilter is set, wrap the workspace service so walkFiles()
    // only returns files in the filter set. This enables incremental
    // extraction — plugins only see changed files.
    const workspaceService: WorkspaceService = this.opts.fileFilter
      ? new FilteredWorkspaceService(baseWorkspaceService, this.opts.fileFilter)
      : baseWorkspaceService

    // ---- Workspace probe ----
    const probe: WorkspaceProbe = {
      workspaceRoot: workspaceService.root,
      hasCompileCommands: workspaceService.hasCompileCommands,
    }

    // ---- Bus ----
    const busOpts: FactBusOptions = {
      snapshotId: this.opts.snapshotId,
      sink: this.opts.sink,
      flushThreshold: this.opts.flushThreshold,
    }
    const makebus = this.opts.busFactory ?? ((o) => new FactBus(o))
    const bus: IFactBus = makebus(busOpts)

    // ---- Filter by appliesTo ----
    type PluginEntry = { kind: "run"; plugin: IExtractor } | { kind: "skip"; plugin: IExtractor; reason: string }

    const entries: PluginEntry[] = this.opts.plugins.map((plugin) => {
      try {
        if (plugin.metadata.appliesTo && !plugin.metadata.appliesTo(probe)) {
          return { kind: "skip", plugin, reason: "appliesTo returned false" }
        }
        return { kind: "run", plugin }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        warnings.push(`[runner] plugin ${plugin.metadata.name}.appliesTo threw: ${msg}; treating as skipped`)
        return { kind: "skip", plugin, reason: `appliesTo threw: ${msg}` }
      }
    })

    // Detect duplicate plugin names — they'd cause provenance ambiguity
    const seenNames = new Set<string>()
    for (const entry of entries) {
      if (seenNames.has(entry.plugin.metadata.name)) {
        warnings.push(`[runner] duplicate plugin name: ${entry.plugin.metadata.name}`)
      }
      seenNames.add(entry.plugin.metadata.name)
    }

    // ---- Run eligible plugins in parallel ----
    const runResults: PluginRunReport[] = await Promise.all(
      entries.map((entry) => {
        if (entry.kind === "skip") {
          return Promise.resolve<PluginRunReport>({
            name: entry.plugin.metadata.name,
            version: entry.plugin.metadata.version,
            status: "skipped",
            factsYielded: 0,
            durationMs: 0,
            skipReason: entry.reason,
          })
        }
        return this.runPlugin({
          plugin: entry.plugin,
          bus,
          lspService,
          treesitterService,
          ripgrepService,
          workspaceService,
        })
      }),
    )

    // ---- Close bus (flushes remainder) ----
    try {
      await bus.close()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      warnings.push(`[runner] bus.close() failed: ${msg}`)
    }

    // ---- Aggregate ----
    let pluginsRun = 0
    let pluginsSkipped = 0
    let pluginsFailed = 0
    for (const r of runResults) {
      if (r.status === "success") pluginsRun++
      else if (r.status === "skipped") pluginsSkipped++
      else if (r.status === "error") pluginsFailed++
    }

    return {
      snapshotId: this.opts.snapshotId,
      workspaceRoot: this.opts.workspaceRoot,
      totalDurationMs: Date.now() - runStart,
      pluginsRun,
      pluginsSkipped,
      pluginsFailed,
      perPlugin: runResults,
      bus: bus.report(),
      warnings,
    }
  }

  // -------------------------------------------------------------------------
  // runPlugin — execute one plugin with full error isolation
  // -------------------------------------------------------------------------

  private async runPlugin(args: {
    plugin: IExtractor
    bus: IFactBus
    lspService: LspServiceImpl
    treesitterService: TreeSitterServiceImpl
    ripgrepService: RipgrepServiceImpl
    workspaceService: WorkspaceService
  }): Promise<PluginRunReport> {
    const { plugin, bus, lspService, treesitterService, ripgrepService, workspaceService } = args
    const start = Date.now()
    let factsYielded = 0

    const contextOpts: ExtractionContextOptions = {
      snapshotId: this.opts.snapshotId,
      workspaceRoot: this.opts.workspaceRoot,
      extractorName: plugin.metadata.name,
      lsp: lspService,
      treesitter: treesitterService,
      ripgrep: ripgrepService,
      workspace: workspaceService,
      signal: this.opts.signal,
      logSink: this.opts.logSink,
    }
    const ctx = new ExtractionContextImpl(contextOpts)

    try {
      const iter = plugin.extract(ctx)
      for await (const fact of iter) {
        if (this.opts.signal?.aborted) {
          throw new Error("[runner] aborted via signal")
        }
        factsYielded++
        await bus.emit(fact as Fact)
      }
      return {
        name: plugin.metadata.name,
        version: plugin.metadata.version,
        status: "success",
        factsYielded,
        durationMs: Date.now() - start,
        metrics: ctx._metricsImpl.snapshot(),
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      ctx.log.error("plugin extract() threw", { message })
      return {
        name: plugin.metadata.name,
        version: plugin.metadata.version,
        status: "error",
        factsYielded,
        durationMs: Date.now() - start,
        errorMessage: message,
        metrics: ctx._metricsImpl.snapshot(),
      }
    }
  }
}

// ---------------------------------------------------------------------------
// FilteredWorkspaceService — wraps a WorkspaceService to only return files
// in a given set. Used by the runner for incremental extraction.
// ---------------------------------------------------------------------------

import type { WorkspaceService, WalkFilesOptions } from "./services/workspace-service.js"

class FilteredWorkspaceService implements WorkspaceService {
  constructor(
    private readonly inner: WorkspaceServiceImpl,
    private readonly allowedFiles: Set<string>,
  ) {}

  get root(): string {
    return this.inner.root
  }
  get hasCompileCommands(): boolean {
    return this.inner.hasCompileCommands
  }

  async walkFiles(opts?: WalkFilesOptions): Promise<string[]> {
    const allFiles = await this.inner.walkFiles(opts)
    return allFiles.filter((f) => this.allowedFiles.has(f))
  }

  readFile(filePath: string): string | undefined {
    return this.inner.readFile(filePath)
  }

  compileCommands() {
    return this.inner.compileCommands()
  }
}

// ---------------------------------------------------------------------------
// Convenience: aggregate report → existing IngestReport shape
// ---------------------------------------------------------------------------

/**
 * Map a RunnerReport to the legacy IngestReport shape used by
 * ingest-tool. This keeps the user-facing report stable while the
 * underlying pipeline changes.
 *
 * Note: type/field/runtime/log/timer counters are not yet populated by
 * the new pipeline (those facts are emitted but not yet serialized to
 * storage tables — see Problem 3 for IGraphStore extensions). For now they
 * are mirrored from the bus's by-kind counts.
 */
export function runnerReportToIngestCounts(report: RunnerReport): {
  symbols: number
  types: number
  fields: number
  edges: number
  runtimeCallers: number
  participantsMaterialized: number
  logs: number
  timerTriggers: number
} {
  const k: Record<FactKind, number> = report.bus.byKind
  return {
    symbols: k.symbol ?? 0,
    types: k.type ?? 0,
    fields: k["aggregate-field"] ?? 0,
    edges: k.edge ?? 0,
    runtimeCallers: 0, // produced by runtime caller phase, not the runner
    participantsMaterialized: 0, // ditto — runtime-caller phase owns participant materialization
    logs: 0,
    timerTriggers: 0,
  }
}
