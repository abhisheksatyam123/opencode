import type { IIndirectCallerIngestion } from "../../contracts/indirect-caller-ingestion.js"
import type {
  RuntimeCallerInput,
  RuntimeCallerBatch,
  LinkReport,
} from "../../contracts/indirect-caller-ingestion.js"
import type { IngestReport, RuntimeCallerRow } from "../../contracts/common.js"
import { runtimeRows, type GraphWriteSink } from "../graph-rows.js"

export interface SymbolFinder {
  hasSymbol(snapshotId: number, name: string): Promise<boolean>
}

export class IndirectCallerIngestionService implements IIndirectCallerIngestion {
  constructor(
    private finder: SymbolFinder,
    private sink?: GraphWriteSink,
  ) {}

  async parseRuntimeCallers(input: RuntimeCallerInput): Promise<RuntimeCallerBatch> {
    // If records are provided directly (e.g. from wlan-targets.ts ground truth), use them
    if (input.records && input.records.length > 0) {
      return { rows: input.records }
    }

    // Otherwise return empty — real parsing from artifacts is a future extension
    return { rows: [] }
  }

  async linkToSymbols(snapshotId: number, batch: RuntimeCallerBatch): Promise<LinkReport> {
    if (batch.rows.length === 0) {
      return { linked: [], unresolved: [], warnings: [] }
    }

    // Look up each targetApi in the symbol table to verify it exists in this snapshot
    const linked: RuntimeCallerRow[] = []
    const unresolved: RuntimeCallerRow[] = []
    const warnings: string[] = []

    for (const row of batch.rows) {
      const ok = await this.finder.hasSymbol(snapshotId, row.targetApi)
      if (ok) {
        linked.push(row)
      } else {
        unresolved.push(row)
        warnings.push(`symbol not found in snapshot ${snapshotId}: ${row.targetApi}`)
      }
    }

    return { linked, unresolved, warnings }
  }

  async persistRuntimeChains(snapshotId: number, linked: LinkReport): Promise<IngestReport> {
    const nodeMap = new Map<string, ReturnType<typeof runtimeRows>["nodes"][number]>()
    const edgeMap = new Map<string, ReturnType<typeof runtimeRows>["edges"][number]>()
    const observationMap = new Map<string, ReturnType<typeof runtimeRows>["observation"]>()
    const evidenceMap = new Map<string, NonNullable<ReturnType<typeof runtimeRows>["evidence"]>>()

    for (const row of linked.linked) {
      const materialized = runtimeRows(snapshotId, row)
      for (const node of materialized.nodes) {
        nodeMap.set(node.node_id, node)
      }
      for (const edge of materialized.edges) {
        edgeMap.set(edge.edge_id, edge)
      }
      observationMap.set(materialized.observation.observation_id, materialized.observation)
      if (materialized.evidence) {
        evidenceMap.set(materialized.evidence.evidence_id, materialized.evidence)
      }
    }

    const nodes = [...nodeMap.values()]
    const edges = [...edgeMap.values()]
    const observations = [...observationMap.values()]
    const evidence = [...evidenceMap.values()]

    if (this.sink) {
      await this.sink.write({
        nodes,
        edges,
        evidence,
        observations,
      })
    }

    const participantsMaterialized = linked.linked.reduce(
      (sum, row) => sum + (row.participants?.length ?? 0),
      0,
    )

    const report: IngestReport = {
      snapshotId,
      inserted: {
        symbols: 0,
        types: 0,
        fields: 0,
        edges: edges.length,
        runtimeCallers: linked.linked.length,
        participantsMaterialized,
        logs: 0,
        timerTriggers: 0,
      },
      warnings: [],
    }

    if (linked.warnings.length > 0) {
      report.warnings.push(...linked.warnings)
    }

    return report
  }
}
