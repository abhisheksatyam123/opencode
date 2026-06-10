/**
 * ingest-tool.ts
 * IntelGraph tool that triggers the full extraction + ingest pipeline for a workspace.
 *
 * Flow (post Step 7 of the plugin extractor infrastructure rollout):
 *   beginSnapshot
 *     → ExtractorRunner.run() (drives all IExtractor plugins,
 *       facts pass through FactBus → GraphWriteSink)
 *     → (optional) runtime caller ingestion via the indirect caller
 *       resolver, iterating function symbols captured by the sink
 *       decorator
 *     → commitSnapshot
 *     → syncFromAuthoritative
 *     → return summary
 *
 * The legacy IExtractionAdapter.extractSymbols/Types/Edges/materializeSnapshot
 * pipeline is no longer called from here. The clangd-core plugin under
 * src/plugins/clangd-core/ is the equivalent of what ClangdExtractionAdapter
 * used to do, plus everything else any future plugin does, all driven by
 * the runner.
 */
import { z } from "zod"
import type { IDbFoundation } from "../contracts/db-foundation.js"
import type { IIndirectCallerIngestion } from "../contracts/indirect-caller-ingestion.js"
import type { RuntimeCallerRow, SymbolRow, SourceLocation } from "../contracts/common.js"
import type { GraphProjectionRepository } from "../contracts/orchestrator.js"
import type { IndirectCallerGraph } from "../../tools/indirect-callers.js"
import type { ILanguageClient } from "../../lsp/ports.js"
import type { GraphNodeRow, GraphWriteBatch, GraphWriteSink } from "../db/graph-rows.js"
import type { IExtractor } from "../extraction/contract.js"
import { ExtractorRunner, type RunnerReport } from "../extraction/runner.js"
import { loggerPort } from "../../logging/logger.js"

const _log = loggerPort.child("ingest-tool")

// ---------------------------------------------------------------------------
// Dep singleton
// ---------------------------------------------------------------------------

/**
 * Inputs the executor needs to construct an ExtractorRunner per snapshot.
 *
 * `lsp`, `sink`, and `plugins` are the runner's ingredients. We don't store
 * a pre-built runner because the runner needs per-snapshot state
 * (snapshotId, workspaceRoot) that is only known when executeIngestTool
 * runs. The runner is constructed inline.
 *
 * `runnerFactory` is an optional override for tests so they can substitute
 * a stub runner without having to mock the four services that a real
 * runner would build.
 */
export interface IngestDeps {
  db: IDbFoundation
  /** Full LSP client. Used by the runner's LspService. */
  lsp: ILanguageClient
  /** Where the FactBus flushes batches. */
  sink: GraphWriteSink
  /** Plugins to run. Defaults to BUILT_IN_EXTRACTORS in prod init. */
  plugins: IExtractor[]
  /** Optional test override for runner construction. */
  runnerFactory?: (opts: { snapshotId: number; workspaceRoot: string; sink: GraphWriteSink }) => ExtractorRunner
  projection: GraphProjectionRepository
  ingestion?: IIndirectCallerIngestion
  indirectCallerResolver?: (sym: { name: string; file?: string; line?: number }) => Promise<IndirectCallerGraph | null>
}

let INGEST_DEPS: IngestDeps | null = null

export function setIngestDeps(deps: IngestDeps | null): void {
  INGEST_DEPS = deps
}

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

export const ingestInputSchema = z.object({
  workspaceRoot: z
    .string()
    .optional()
    .describe("Absolute path to workspace root (defaults to WLAN_WORKSPACE_ROOT when omitted/empty)"),
  compileDbHash: z.string().optional().describe("Hash of compile_commands.json (auto-computed if omitted)"),
  parserVersion: z.string().optional().describe("Parser version string (default: 1.0.0)"),
  fileLimit: z.number().int().positive().optional().describe("Max files to extract (default: 200)"),
  syncProjection: z.boolean().optional().describe("Sync projection after ingest (default: true)"),
  maxRuntimeTargets: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Max function symbols to resolve indirect callers for (default: 200)"),
})

// ---------------------------------------------------------------------------
// Function symbol capture sink (decorator over the real sink)
// ---------------------------------------------------------------------------

/**
 * Wraps a GraphWriteSink to also capture every function symbol that
 * passes through. The runtime caller phase needs the list of function
 * symbols to iterate; previously the IExtractionAdapter returned a
 * SymbolBatch containing them inline, but the new pipeline streams facts
 * through the bus and discards them after flushing. This decorator is the
 * cheapest way to get the list back without changing the bus's contract.
 *
 * Once Problem 2 lands and the runtime caller phase becomes its own
 * plugin, this decorator goes away — the new plugin will yield runtime
 * caller facts directly and there will be no need to round-trip through
 * function symbols.
 */
class FunctionSymbolCaptureSink implements GraphWriteSink {
  constructor(private readonly inner: GraphWriteSink) {}

  public readonly functionSymbols: SymbolRow[] = []

  async write(batch: GraphWriteBatch): Promise<void> {
    for (const node of batch.nodes) {
      if (this.isFunctionNode(node)) {
        this.functionSymbols.push(this.toSymbolRow(node))
      }
    }
    await this.inner.write(batch)
  }

  private isFunctionNode(node: GraphNodeRow): boolean {
    return node.kind === "function"
  }

  private toSymbolRow(node: GraphNodeRow): SymbolRow {
    const location: SourceLocation | undefined = node.location
      ? {
          filePath: node.location.filePath,
          line: node.location.line,
          column: node.location.column,
        }
      : undefined
    return {
      kind: "function",
      name: node.canonical_name,
      location,
    }
  }
}

// ---------------------------------------------------------------------------
// Graph → RuntimeCallerRow conversion
// ---------------------------------------------------------------------------

/**
 * Convert an IndirectCallerGraph to RuntimeCallerRow[] records for a given
 * target symbol.  One row is emitted per IndirectCallerNode that has at
 * least an enclosing-function name and a file location.
 */
function graphNodesToRuntimeCallerRows(targetApi: string, graph: IndirectCallerGraph): RuntimeCallerRow[] {
  const rows: RuntimeCallerRow[] = []

  for (const node of graph.nodes) {
    if (!node.name || !node.file) continue

    const chain = node.resolvedChain

    // Build dispatchChain from the mediated path stages
    const dispatchChain: string[] = []
    if (node.classification?.registrationApi) {
      dispatchChain.push(node.classification.registrationApi)
    }
    if (chain?.store.containerType) {
      dispatchChain.push(chain.store.containerType)
    }
    if (chain?.dispatch.dispatchFunction) {
      dispatchChain.push(chain.dispatch.dispatchFunction)
    }

    // Derive runtimeTrigger from resolved chain trigger or fall back to classification
    const runtimeTrigger =
      chain?.trigger.triggerKind ?? chain?.trigger.triggerKey ?? node.classification?.patternName ?? "unknown"

    // Confidence: scale confidenceScore (1–5) to 0–1, or use 0.5 as fallback
    const confidence = chain ? Math.min(chain.confidenceScore / 5.0, 1.0) : 0.5

    rows.push({
      targetApi,
      immediateInvoker: node.name,
      dispatchChain,
      dispatchSite: {
        filePath: node.file,
        line: node.line,
      },
      runtimeTrigger,
      confidence,
    })
  }

  return rows
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export async function executeIngestTool(args: z.infer<typeof ingestInputSchema>): Promise<string> {
  if (!INGEST_DEPS) {
    return "intelligence_ingest: intelligence backend not initialized."
  }
  const { db: DB_FOUNDATION, projection: GRAPH_PROJECTION } = INGEST_DEPS

  const lines: string[] = []
  const start = performance.now()
  const root = args.workspaceRoot?.trim() || process.env.WLAN_WORKSPACE_ROOT?.trim()
  if (!root) {
    return "intelligence_ingest: workspaceRoot missing. Provide workspaceRoot or set WLAN_WORKSPACE_ROOT."
  }

  let snapshotId = -1

  try {
    const meta = await DB_FOUNDATION.beginSnapshot({
      workspaceRoot: root,
      compileDbHash: args.compileDbHash ?? "auto",
      parserVersion: args.parserVersion ?? "1.0.0",
    })
    snapshotId = meta.snapshotId
    lines.push(`Snapshot started: id=${snapshotId}`)

    // Wrap the real sink to also capture function symbols for the
    // runtime caller phase below.
    const captureSink = new FunctionSymbolCaptureSink(INGEST_DEPS.sink)

    // Construct the runner — either via the test override factory or
    // from the production ingredients on INGEST_DEPS.
    const runner = INGEST_DEPS.runnerFactory
      ? INGEST_DEPS.runnerFactory({
          snapshotId,
          workspaceRoot: root,
          sink: captureSink,
        })
      : new ExtractorRunner({
          snapshotId,
          workspaceRoot: root,
          lsp: INGEST_DEPS.lsp,
          sink: captureSink,
          plugins: INGEST_DEPS.plugins,
        })

    const runReport: RunnerReport = await runner.run()
    const counts = runReport.bus.byKind
    lines.push(`Extracted: symbols=${counts.symbol ?? 0} types=${counts.type ?? 0} edges=${counts.edge ?? 0}`)
    lines.push(`Persisted: symbols=${counts.symbol ?? 0} types=${counts.type ?? 0} edges=${counts.edge ?? 0}`)
    if (runReport.pluginsFailed > 0) {
      lines.push(
        `Plugins failed: ${runReport.pluginsFailed} (${runReport.perPlugin
          .filter((p) => p.status === "error")
          .map((p) => `${p.name}: ${p.errorMessage}`)
          .join("; ")})`,
      )
    }
    if (runReport.warnings.length > 0) {
      lines.push(`Runner warnings (${runReport.warnings.length}):`)
      for (const w of runReport.warnings) lines.push(`- ${w}`)
    }

    // Phase 2: Runtime caller ingestion via C-parser + clangd indirect caller resolution
    // Only run if an indirect caller resolver is available
    if (INGEST_DEPS.ingestion && INGEST_DEPS.indirectCallerResolver) {
      const functionSymbols = captureSink.functionSymbols.slice(0, args.maxRuntimeTargets ?? 200)

      let runtimeInserted = 0
      for (const sym of functionSymbols) {
        try {
          const graph = await INGEST_DEPS.indirectCallerResolver(sym)
          if (!graph || graph.nodes.length === 0) continue

          const records = graphNodesToRuntimeCallerRows(sym.name, graph)
          if (records.length === 0) continue

          const batch = await INGEST_DEPS.ingestion.parseRuntimeCallers({ workspaceRoot: root, records })
          const linked = await INGEST_DEPS.ingestion.linkToSymbols(snapshotId, batch)
          const runtimeReport = await INGEST_DEPS.ingestion.persistRuntimeChains(snapshotId, linked)
          runtimeInserted += runtimeReport.inserted.runtimeCallers ?? 0
        } catch (err) {
          _log.warn(`runtime caller resolution failed for ${sym.name}`, {
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      if (runtimeInserted > 0) {
        lines.push(`Runtime callers inserted: ${runtimeInserted}`)
      }
    }

    await DB_FOUNDATION.commitSnapshot(snapshotId)
    lines.push(`Snapshot committed: id=${snapshotId} status=ready`)

    if (args.syncProjection !== false && GRAPH_PROJECTION) {
      const res = await GRAPH_PROJECTION.syncFromAuthoritative(snapshotId)
      lines.push(`Projection synced: nodes=${res.nodesUpserted} edges=${res.edgesUpserted}`)
    }

    lines.push(`Done in ${(performance.now() - start).toFixed(1)}ms`)
    return lines.join("\n")
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (snapshotId > 0) {
      await DB_FOUNDATION.failSnapshot(snapshotId, msg)
    }
    return `intelligence_ingest: failed: ${msg}`
  }
}
