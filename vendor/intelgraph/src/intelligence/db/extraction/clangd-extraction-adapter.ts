import { readdir } from "fs/promises"
import { join, extname } from "path"
import type { IExtractionAdapter } from "../../contracts/extraction-adapter.js"
import type {
  ExtractionInput,
  SymbolBatch,
  TypeBatch,
  EdgeBatch,
  ExtractionBatches,
} from "../../contracts/extraction-adapter.js"
import type { IngestReport, SymbolRow, EdgeRow } from "../../contracts/common.js"
import {
  edgeRow,
  evidenceRow,
  symbolNode,
  type GraphWriteSink,
} from "../graph-rows.js"

// ---------------------------------------------------------------------------
// Clangd LSP client interface (minimal surface we need)
// ---------------------------------------------------------------------------

export interface ClangdLspClient {
  documentSymbol(filePath: string): Promise<Array<Record<string, unknown>>>
  incomingCalls(filePath: string, line: number, character: number): Promise<Array<Record<string, unknown>>>
  outgoingCalls(filePath: string, line: number, character: number): Promise<Array<Record<string, unknown>>>
}

// ---------------------------------------------------------------------------
// C file discovery
// ---------------------------------------------------------------------------

const C_EXTS = new Set([".c", ".h", ".cpp", ".cc", ".cxx", ".hpp"])
function isWlanProcRoot(dir: string): boolean {
  const normalized = dir.replace(/\\/g, "/")
  return normalized === "/wlan_proc" || normalized.endsWith("/wlan_proc") || normalized.includes("/wlan_proc/")
}

function isLikelyBuildArtifactPath(filePath: string): boolean {
  const p = filePath.replace(/\\/g, "/").toLowerCase()
  const markers = [
    "/build/",
    "/config/bsp/",
    "/core/debugtools/",
    "/core/power/",
    "/core/services/",
  ]
  return markers.some((m) => p.includes(m))
}

function rankFilePath(filePath: string): number {
  const p = filePath.replace(/\\/g, "/").toLowerCase()
  const hasWlan = p.includes("/wlan/")
  const isSrc = p.includes("/src/")
  const isBuild = isLikelyBuildArtifactPath(p)
  if (hasWlan && isSrc && !isBuild) return 0
  if (hasWlan && !isBuild) return 1
  if (!isBuild) return 2
  return 3
}

function prioritizeWlanProcFiles(files: string[]): string[] {
  return [...files].sort((a, b) => {
    const rankDiff = rankFilePath(a) - rankFilePath(b)
    if (rankDiff !== 0) return rankDiff
    return a.localeCompare(b)
  })
}

async function collectFiles(dir: string, limit = 500): Promise<string[]> {
  const out: string[] = []
  const wlanProcMode = isWlanProcRoot(dir)
  const traversalLimit = wlanProcMode ? Math.max(limit * 50, 2000) : limit
  async function walk(d: string) {
    if (out.length >= traversalLimit) return
    const entries = await readdir(d, { withFileTypes: true })
    for (const e of entries) {
      if (out.length >= traversalLimit) break
      const full = join(d, e.name)
      if (e.isDirectory() && !e.name.startsWith(".")) {
        await walk(full)
      } else if (e.isFile() && C_EXTS.has(extname(e.name))) {
        out.push(full)
      }
    }
  }
  await walk(dir)
  const prioritized = wlanProcMode ? prioritizeWlanProcFiles(out) : out
  return prioritized.slice(0, limit)
}

// ---------------------------------------------------------------------------
// Symbol kind mapping from LSP SymbolKind numbers
// ---------------------------------------------------------------------------

function mapKind(k: number): SymbolRow["kind"] {
  switch (k) {
    case 12: return "function"
    case 23: return "struct"
    case 10: return "enum"
    case 26: return "typedef"
    case 13: return "field"
    case 14: return "param"
    default: return "function"
  }
}

// ---------------------------------------------------------------------------
// ClangdExtractionAdapter
// ---------------------------------------------------------------------------

export class ClangdExtractionAdapter implements IExtractionAdapter {
  constructor(
    private lsp: ClangdLspClient,
    private sink?: GraphWriteSink,
  ) {}

  async extractSymbols(input: ExtractionInput): Promise<SymbolBatch> {
    const files = input.files ?? await collectFiles(input.workspaceRoot, input.fileLimit ?? 200)
    const symbols: SymbolRow[] = []

    for (const file of files) {
      try {
        const raw = await this.lsp.documentSymbol(file)
        for (const s of raw) {
          const loc = (s.location as Record<string, unknown> | undefined)
          const range = (s.range as Record<string, unknown> | undefined) ??
                        (loc?.range as Record<string, unknown> | undefined)
          const start = range?.start as Record<string, unknown> | undefined
          symbols.push({
            kind: mapKind((s.kind as number) ?? 12),
            name: String(s.name ?? ""),
            qualifiedName: s.containerName ? `${s.containerName}::${s.name}` : undefined,
            location: {
              filePath: file,
              line: ((start?.line as number) ?? 0) + 1,
              column: ((start?.character as number) ?? 0) + 1,
            },
          })
        }
      } catch {
        // skip files that fail to parse
      }
    }

    return { symbols }
  }

  async extractTypes(input: ExtractionInput): Promise<TypeBatch> {
    // Types are derived from struct/union/enum symbols
    const { symbols } = await this.extractSymbols(input)
    const types = symbols
      .filter((s) => s.kind === "struct" || s.kind === "enum" || s.kind === "typedef")
      .map((s) => ({
        kind: s.kind as "struct" | "enum" | "typedef",
        spelling: s.name,
        symbolName: s.name,
      }))
    return { types, fields: [] }
  }

  async extractEdges(input: ExtractionInput): Promise<EdgeBatch> {
    const { symbols } = await this.extractSymbols(input)
    const edges: EdgeRow[] = []

    for (const sym of symbols) {
      if (sym.kind !== "function" || !sym.location) continue
      try {
        const calls = await this.lsp.outgoingCalls(
          sym.location.filePath,
          sym.location.line - 1,
          (sym.location.column ?? 1) - 1,
        )
        for (const call of calls) {
          const item = (call.to ?? call) as Record<string, unknown>
          const name = String(item.name ?? "")
          if (!name) continue
          edges.push({
            edgeKind: "calls",
            srcSymbolName: sym.name,
            dstSymbolName: name,
            confidence: 1.0,
            derivation: "clangd",
            evidence: {
              sourceKind: "clangd_response",
              location: sym.location,
            },
          })
        }
      } catch {
        // skip
      }
    }

    return { edges }
  }

  async materializeSnapshot(snapshotId: number, batches: ExtractionBatches): Promise<IngestReport> {
    const nodes = batches.symbolBatch.symbols.map((row) => symbolNode(snapshotId, row))
    const edges = batches.edgeBatch.edges.map((row) => edgeRow(snapshotId, row))
    const evidence = batches.edgeBatch.edges
      .map((row, i) => evidenceRow(snapshotId, edges[i]!.edge_id, row.evidence))
      .filter((row): row is NonNullable<typeof row> => Boolean(row))

    if (this.sink) {
      await this.sink.write({
        nodes,
        edges,
        evidence,
        observations: [],
      })
    }

    return {
      snapshotId,
      inserted: {
        symbols: nodes.length,
        types: batches.typeBatch.types.length,
        fields: batches.typeBatch.fields.length,
        edges: edges.length,
        runtimeCallers: 0,
        participantsMaterialized: 0,
        logs: 0,
        timerTriggers: 0,
      },
      warnings: this.sink ? [] : ["materializeSnapshot ran without graph sink"],
    }
  }
}
