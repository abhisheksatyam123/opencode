import { isAbsolute, join } from "node:path"
import { collectIndirectCallers } from "@intelgraph/tools/indirect-callers.js"
import {
  indirectCallersFromGraph,
  inferRuntimeCallersFromTextReferences,
  mergeIndirectCallers,
  textReferenceLocations,
  uriToPath,
} from "./registration-inference"
import {
  type IntelGraphLspIncomingCall,
  type IntelGraphLspLike,
  type IntelGraphLspLocation,
  type IntelGraphLspSymbolMatch,
} from "../resolver/dynamic-resolver"
import type { IntelGraphNodeKind } from "../../contract"

export type IntelGraphLspLayerLike = {
  workspaceSymbol(query: string): Promise<unknown[]>
  incomingCalls(filePath: string, line: number, character: number): Promise<unknown[]>
  references(filePath: string, line: number, character: number): Promise<unknown[]>
}

type IntelGraphIndirectLayerLike = IntelGraphLspLayerLike & {
  root?: string
  openFile?(filePath: string, text: string): Promise<boolean>
  prepareCallHierarchy?(filePath: string, line: number, character: number): Promise<unknown[]>
  definition?(filePath: string, line: number, character: number): Promise<unknown[]>
  outgoingCalls?(filePath: string, line: number, character: number): Promise<unknown[]>
  documentSymbol?(filePath: string): Promise<unknown[]>
  hover?(filePath: string, line: number, character: number): Promise<unknown>
}

export function intelGraphLspLikeFromLayer(layer: IntelGraphLspLayerLike): IntelGraphLspLike {
  return {
    async workspaceSymbol(request) {
      const rows = await layer.workspaceSymbol(request.query)
      return rows
        .slice(0, request.limit)
        .map(symbolMatchFromLsp)
        .filter((match): match is IntelGraphLspSymbolMatch => Boolean(match))
    },
    async incomingCalls(request) {
      return (await layer.incomingCalls(
        request.file,
        toZeroBased(request.line),
        toZeroBased(request.character ?? 1),
      )) as IntelGraphLspIncomingCall[]
    },
    async textReferences(request) {
      const indirectLayer = layer as IntelGraphIndirectLayerLike
      if (!indirectLayer.root) return []
      const targetFile = isAbsolute(request.file) ? request.file : join(indirectLayer.root, request.file)
      return textReferenceLocations(indirectLayer.root, request.symbol, targetFile, request.limit).slice(
        0,
        request.limit,
      )
    },
    async references(request) {
      return (await layer.references(
        request.file,
        toZeroBased(request.line),
        toZeroBased(request.character ?? 1),
      )) as IntelGraphLspLocation[]
    },
    async indirectCallers(request) {
      const indirectLayer = layer as IntelGraphIndirectLayerLike
      if (!supportsIndirectCallers(indirectLayer)) return []
      const graph = await collectIndirectCallers(withReferenceFallback(indirectLayer) as any, {
        file: request.file,
        line: request.line,
        character: request.character ?? 1,
        maxNodes: request.limit,
        resolve: true,
      })
      const graphCallers = indirectCallersFromGraph(graph, indirectLayer.root)
      return mergeIndirectCallers(graphCallers, inferRuntimeCallersFromTextReferences(indirectLayer.root, request))
    },
  }
}

function symbolMatchFromLsp(input: unknown): IntelGraphLspSymbolMatch | undefined {
  const row = object(input)
  const location = object(row.location)
  const range = object(location.range)
  const start = object(range.start)
  const uri = typeof location.uri === "string" ? location.uri : typeof row.uri === "string" ? row.uri : undefined
  const name = typeof row.name === "string" ? row.name : typeof row.symbol === "string" ? row.symbol : undefined
  if (!name) return undefined
  const line = numberFrom(start.line)
  const character = numberFrom(start.character)
  return {
    id: typeof row.id === "string" ? row.id : undefined,
    symbol: name,
    label: name,
    kind: symbolKind(row.kind),
    file: uriToPath(uri),
    line: line === undefined ? undefined : line + 1,
    character: character === undefined ? undefined : character + 1,
    language: "c",
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

function numberFrom(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function toZeroBased(value: number) {
  return Math.max(0, Math.trunc(value) - 1)
}

function symbolKind(kind: unknown): IntelGraphNodeKind {
  if (typeof kind === "string" && kind.trim()) return kind as IntelGraphNodeKind
  if (kind === 5) return "function"
  if (kind === 6) return "function"
  if (kind === 8) return "struct_field"
  if (kind === 12) return "function"
  if (kind === 23) return "struct_field"
  return "function"
}

function withReferenceFallback(layer: IntelGraphIndirectLayerLike): IntelGraphIndirectLayerLike {
  const baseReferences = layer.references.bind(layer)
  const basePrepare = layer.prepareCallHierarchy?.bind(layer)
  const wrapped = Object.create(layer) as IntelGraphIndirectLayerLike
  wrapped.references = async (filePath: string, line: number, character: number) => {
    const direct = await baseReferences(filePath, line, character)
    if (direct.length > 1) return direct
    const seedItems = await basePrepare?.(filePath, line, character).catch(() => [])
    const seed = object(seedItems?.[0])
    const symbol = typeof seed.name === "string" ? seed.name.trim() : ""
    if (!symbol || !layer.root) return direct
    const fallback = textReferenceLocations(layer.root, symbol, filePath)
    return fallback.length ? dedupeLocations([...(direct as IntelGraphLspLocation[]), ...fallback]) : direct
  }
  return wrapped
}

function dedupeLocations(locations: IntelGraphLspLocation[]): IntelGraphLspLocation[] {
  const seen = new Set<string>()
  return locations.filter((location) => {
    const key = `${location.uri ?? ""}:${location.range?.start?.line ?? ""}:${location.range?.start?.character ?? ""}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function supportsIndirectCallers(layer: IntelGraphIndirectLayerLike) {
  return (
    typeof layer.root === "string" &&
    typeof layer.openFile === "function" &&
    typeof layer.prepareCallHierarchy === "function" &&
    typeof layer.definition === "function" &&
    typeof layer.outgoingCalls === "function" &&
    typeof layer.documentSymbol === "function" &&
    typeof layer.hover === "function"
  )
}
