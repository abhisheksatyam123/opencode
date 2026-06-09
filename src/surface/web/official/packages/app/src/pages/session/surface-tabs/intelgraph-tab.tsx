import { For, Match, Show, Switch, createEffect, createMemo, on } from "solid-js"
import { createStore } from "solid-js/store"
import { showToast } from "@opencode-ai/ui/toast"
import { useFile } from "@/context/file"
import { useSessionLayout } from "@/pages/session/session-layout"
import { useSurfaceSessionBridge } from "@/surface/session-provider"
import { diagnosticError, emitDiagnosticLog } from "@/utils/diagnostic-log"
import type {
  SurfaceBridge,
  SurfaceIntelGraphDirection,
  SurfaceIntelGraphEdge,
  SurfaceIntelGraphNode,
  SurfaceIntelGraphRelations,
  SurfaceIntelGraphV1RelationKind,
  SurfaceIntelGraphV1RelationResult,
} from "@/surface/ports"
import {
  RELATION_EDGE_FAMILY_PALETTE,
  adaptV1RelationResult,
  fallbackNode,
  mergedRelationLevel,
  flattenRelations,
  rebaseSurfaceIntelGraphRelationsRoot,
  isApiSymbolNode,
  isRegistrationRelation,
  nodeDefinitionLocation,
  nodeLabel,
  relationEdgeFamilyColor,
  relationEdgeFamilyKey,
  relationEdgeFamilyPaletteIndex,
  relationErrorMessage,
  relationLayoutScores,
  relationLoadingIdsAfterCompletion,
  relationMissMessage,
  relationNodeSortKey,
  relationPresentationEdgeGroupKey,
  pruneOrphanIntelGraphRelationState,
  resolveIntelGraphVisualYOverlaps,
  stableEdgeKey,
  symbolLocation,
  withRelationRequestTimeout,
} from "./intelgraph-relations-model"

// ─── Layout constants ────────────────────────────────────────────────────────
const RELATION_STARTUP_DEPTH = 1
const RELATION_EXPANSION_DEPTH = 1
const VISIBLE_NODE_CAP = 200
const NODE_MIN_W = 150
const NODE_MAX_W = 320
const NODE_CHAR_W = 7
const NODE_H = 40
const ROW_GAP = 44
const COL_GAP = 180
const PAD_X = 64
const PAD_Y = 56
const CANVAS_MIN_ZOOM = 0.35
const CANVAS_MAX_ZOOM = 1.8
const CANVAS_ZOOM_STEP = 0.15
const CANVAS_FIT_PADDING = 48
const CANVAS_MINIMAP_W = 180
const CANVAS_MINIMAP_H = 120
const RELATION_VISUAL_MIN_ROW_GAP = 1
type IntelGraphCanvasDetailLevel = "compact" | "normal" | "detailed"
// Orthogonal routing: how far outside the box the elbow exits before turning.
const ELBOW_STUB = 20
const DEFINITION_CONTEXT_LINES = 12
const DEFINITION_LINE_HEIGHT_PX = 24

// ─── Types ───────────────────────────────────────────────────────────────────
type RelationCacheKey = `${SurfaceIntelGraphDirection}:${number}`
type RelationExpansionCache = Record<string, Partial<Record<RelationCacheKey, SurfaceIntelGraphRelations>>>

type GraphStore = {
  rootId: string
  focusId: string
  selectedId: string
  nodes: Record<string, SurfaceIntelGraphNode>
  edges: Record<string, SurfaceIntelGraphEdge>
  levels: Record<string, number>
  loadingIds: Set<string>
  error: string
  truncationNotice: string
  lastSelectedByRoot: Record<string, string>
  relationCache: RelationExpansionCache
}

type MergeOptions = {
  rootId: string
  targetId: string
  direction: SurfaceIntelGraphDirection
  targetLevel: number
  reset: boolean
}

type ViewportAnchor = {
  nodeId: string
  centerOffsetX: number
  centerOffsetY: number
}

type RelationLayoutNode = {
  visualId: string
  semanticId: string
  node: SurfaceIntelGraphNode
  level: number
  xLevel: number
  yLevel: number
  yBand: readonly [number, number]
  yBandStart: number
  yBandEnd: number
  lane: number
  duplicateLabel: boolean
  duplicateCount: number
  duplicateColor: string | undefined
  subtitle: string
  width: number
  x: number
  y: number
}

type RelationPositionedEdge = {
  edge: SurfaceIntelGraphEdge
  src: RelationLayoutNode
  dst: RelationLayoutNode
  familyKey: string
  paletteIndex: number
  color: string
}

type RelationLayoutEdge = RelationPositionedEdge & {
  edges: SurfaceIntelGraphEdge[]
  sources: RelationLayoutNode[]
  destinations: RelationLayoutNode[]
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────
function definitionScrollTop(line: number) {
  return Math.max(0, (line - DEFINITION_CONTEXT_LINES) * DEFINITION_LINE_HEIGHT_PX)
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function lineLooksLikeComment(text: string) {
  const trimmed = text.trim()
  return trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")
}

function lineStartsControlStatement(text: string) {
  return /^\s*(?:if|for|while|switch|return)\b/.test(text)
}

function hasSymbolCallShape(lines: string[], index: number, symbol: string) {
  const sameLine = lines[index] ?? ""
  if (new RegExp(`\\b${escapeRegExp(symbol)}\\s*\\(`).test(sameLine)) return true
  for (let lookahead = index + 1; lookahead <= Math.min(lines.length - 1, index + 3); lookahead++) {
    const probe = (lines[lookahead] ?? "").trim()
    if (!probe) continue
    if (probe.startsWith("(")) return true
    if (probe.startsWith("{")) return false
    if (probe.endsWith(";")) return false
  }
  return false
}

function lineStartsFunctionDefinition(lines: string[], index: number, symbol: string) {
  const text = lines[index] ?? ""
  if (lineLooksLikeComment(text)) return false
  if (!new RegExp(`\\b${escapeRegExp(symbol)}\\b`).test(text)) return false
  if (lineStartsControlStatement(text)) return false
  if (!hasSymbolCallShape(lines, index, symbol)) return false

  let sawSignature = false
  for (let cursor = index; cursor <= Math.min(lines.length - 1, index + 40); cursor++) {
    const probe = lines[cursor] ?? ""
    if (!probe.trim()) continue
    if (lineLooksLikeComment(probe)) continue
    if (probe.includes("(")) sawSignature = true
    if (!sawSignature) continue

    const openBrace = probe.indexOf("{")
    const semicolon = probe.indexOf(";")
    if (openBrace >= 0 && (semicolon < 0 || openBrace < semicolon)) return true
    if (semicolon >= 0 && (openBrace < 0 || semicolon < openBrace)) return false
  }
  return false
}

function resolvedDefinitionLineFromText(source: string | undefined, symbol: string, hintLine?: number) {
  if (!source || !symbol) return hintLine
  const lines = source.split(/\r?\n/)
  const candidates: number[] = []
  for (let index = 0; index < lines.length; index++) {
    if (!lineStartsFunctionDefinition(lines, index, symbol)) continue
    candidates.push(index + 1)
  }
  if (candidates.length === 0) return hintLine
  if (!hintLine || hintLine <= 0) return candidates[0]
  return candidates.reduce(
    (best, line) => (Math.abs(line - hintLine) < Math.abs(best - hintLine) ? line : best),
    candidates[0],
  )
}

function intelGraphDebugEnabled() {
  try {
    return globalThis.localStorage?.getItem("opencode:intelgraph-debug") === "1"
  } catch {
    return false
  }
}

function intelGraphDebug(message: string, details?: unknown) {
  if (!intelGraphDebugEnabled()) return
  console.info(`[IntelGraph] ${message}`, details ?? "")
}

function relationEdgeLabel(edge: SurfaceIntelGraphEdge) {
  return edge.label || edge.kind
}

function relationPayloadEdgeCount(data: SurfaceIntelGraphRelations) {
  return (data.groups ?? []).reduce(
    (total, group) =>
      total +
      (group.direct?.length ?? 0) +
      (group.indirect ?? []).reduce((pathTotal, path) => pathTotal + (path.edges?.length ?? 0), 0),
    0,
  )
}

function relationDataDebugSummary(data: SurfaceIntelGraphRelations) {
  const relationRecords = data.relationData?.nodes ?? []
  const relationBuckets = relationRecords.flatMap((record) => record.relations ?? [])
  const relationItems = relationBuckets.flatMap((bucket) => bucket.items ?? [])
  return {
    relationDataPresent: Boolean(data.relationData),
    relationRecordCount: relationRecords.length,
    relationBucketCount: relationBuckets.length,
    relationItemCount: relationItems.length,
    relationDirectItemCount: relationItems.filter((item) => item.relation.direct !== false).length,
    relationIndirectItemCount: relationItems.filter((item) => item.relation.direct === false).length,
    relationTypes: relationBuckets.map((bucket) => `${bucket.direction}:${bucket.type}`).slice(0, 20),
  }
}

function relationKindsForDirection(direction: SurfaceIntelGraphDirection): SurfaceIntelGraphV1RelationKind[] {
  if (direction === "incoming") return ["api_callers", "indirect_registered_callers"]
  if (direction === "outgoing") return ["api_registrations", "api_deregistrations"]
  return ["api_callers", "api_registrations", "api_deregistrations", "indirect_registered_callers"]
}

function relationKindsForRequest(
  direction: SurfaceIntelGraphDirection,
  reset: boolean,
): SurfaceIntelGraphV1RelationKind[] {
  // Expanding callers-of-callers should stay on the fast direct caller path.
  // Indirect registrations are valuable on the root lookup, but they can be
  // expensive and usually irrelevant for one-hop expansion nodes.
  if (!reset && direction === "incoming") return ["api_callers"]
  return relationKindsForDirection(direction)
}

function surfaceRelationsFromV1(data: SurfaceIntelGraphV1RelationResult): SurfaceIntelGraphRelations {
  const relationData = adaptV1RelationResult(data)
  return {
    symbol: relationData.symbol,
    node: relationData.nodes[0]?.node ?? null,
    nodes: relationData.nodes.map((record) => record.node),
    groups: [],
    diagnostic: relationData.diagnostic,
    relationData,
  }
}

function relationExpansionAction(direction: SurfaceIntelGraphDirection) {
  if (direction === "incoming") return "callers"
  if (direction === "outgoing") return "callees"
  return "more"
}

function relationNodeSubtitle(node: SurfaceIntelGraphNode) {
  const location = nodeDefinitionLocation(node)
  if (!location.file && !location.line) return ""
  if (location.file && location.line) return `${location.file}:${location.line}`
  return location.file ?? `line ${location.line}`
}

const RELATION_DUPLICATE_COLORS = ["#f97316", "#06b6d4", "#a855f7", "#22c55e", "#eab308", "#ec4899"] as const

function relationStableHash(value: string) {
  let hash = 0
  for (let index = 0; index < value.length; index++) hash = (hash * 31 + value.charCodeAt(index)) >>> 0
  return hash
}

function relationDuplicateColor(id: string, count: number) {
  if (count <= 1) return undefined
  return RELATION_DUPLICATE_COLORS[relationStableHash(id) % RELATION_DUPLICATE_COLORS.length]
}

function clampCanvasZoom(value: number) {
  if (!Number.isFinite(value)) return 1
  return Math.max(CANVAS_MIN_ZOOM, Math.min(CANVAS_MAX_ZOOM, Math.round(value * 100) / 100))
}

function relationCanvasDetailLevel(zoom: number): IntelGraphCanvasDetailLevel {
  if (zoom < 0.7) return "compact"
  if (zoom > 1.2) return "detailed"
  return "normal"
}

function relationVisualParentChild(edge: SurfaceIntelGraphEdge, levels: Record<string, number>, rootId: string) {
  if (edge.src === edge.dst) return undefined
  if (edge.direction === "incoming") return { parentId: edge.dst, childId: edge.src, childRole: "src" as const }
  if (edge.direction === "outgoing") return { parentId: edge.src, childId: edge.dst, childRole: "dst" as const }
  if (edge.src === rootId) return { parentId: edge.src, childId: edge.dst, childRole: "dst" as const }
  if (edge.dst === rootId) return { parentId: edge.dst, childId: edge.src, childRole: "src" as const }
  const srcLevel = levels[edge.src] ?? 0
  const dstLevel = levels[edge.dst] ?? 0
  return Math.abs(srcLevel) <= Math.abs(dstLevel)
    ? { parentId: edge.src, childId: edge.dst, childRole: "dst" as const }
    : { parentId: edge.dst, childId: edge.src, childRole: "src" as const }
}

function relationCacheKey(direction: SurfaceIntelGraphDirection, depth: number): RelationCacheKey {
  return `${direction}:${depth}`
}

type RelationLayoutNodeDraft = Omit<RelationLayoutNode, "x" | "y">

function relationNodeWidth(node: SurfaceIntelGraphNode, duplicateLabel: boolean) {
  const labelLength = nodeLabel(node).length
  const subtitleLength = duplicateLabel ? relationNodeSubtitle(node).length : 0
  const desired = 48 + Math.max(labelLength, Math.min(subtitleLength, 40)) * NODE_CHAR_W
  return Math.max(NODE_MIN_W, Math.min(NODE_MAX_W, Math.ceil(desired)))
}

function relationEdgeColor(edge: SurfaceIntelGraphEdge, familyKey: string): string {
  if (isRegistrationRelation(edge)) return "#3b82f6"
  return relationEdgeFamilyColor(familyKey)
}

/**
 * Build an orthogonal L-shaped SVG path between two node boxes.
 * The path exits the source box horizontally (stub), turns 90°, then
 * enters the destination box horizontally (stub). This avoids diagonal
 * lines and keeps the graph readable.
 */
function orthogonalPath(
  sx: number,
  sy: number,
  sw: number,
  dx: number,
  dy: number,
  dw: number,
  nh: number,
  registrationEdge = false,
): string {
  const srcRight = sx + sw
  const srcLeft = sx
  const srcCy = sy + nh / 2
  const dstLeft = dx
  const dstRight = dx + dw
  const dstCy = dy + nh / 2

  if (srcRight <= dstLeft) {
    const ex = srcRight + ELBOW_STUB
    const fx = dstLeft - ELBOW_STUB
    const midX = (ex + fx) / 2
    return `M ${srcRight} ${srcCy} H ${midX} V ${dstCy} H ${dstLeft}`
  }

  if (dstRight <= srcLeft) {
    const ex = srcLeft - ELBOW_STUB
    const fx = dstRight + ELBOW_STUB
    const midX = (ex + fx) / 2
    return `M ${srcLeft} ${srcCy} H ${midX} V ${dstCy} H ${dstRight}`
  }

  if (registrationEdge) {
    const srcBottom = sy + nh
    const srcTop = sy
    const dstTop = dy
    const dstBottom = dy + nh
    const srcCx = sx + sw / 2
    const dstCx = dx + dw / 2
    if (srcBottom <= dstTop) {
      const midY = (srcBottom + ELBOW_STUB + dstTop - ELBOW_STUB) / 2
      return `M ${srcCx} ${srcBottom} V ${midY} H ${dstCx} V ${dstTop}`
    }
    if (dstBottom <= srcTop) {
      const midY = (srcTop - ELBOW_STUB + dstBottom + ELBOW_STUB) / 2
      return `M ${srcCx} ${srcTop} V ${midY} H ${dstCx} V ${dstBottom}`
    }
  }

  // Non-registration edges should not use bottom-to-top routing. If nodes overlap
  // in x, route around the outside horizontally to preserve tree direction.
  const routeRight = dx >= sx
  if (routeRight) {
    const detourX = Math.max(srcRight, dstRight) + ELBOW_STUB * 2
    return `M ${srcRight} ${srcCy} H ${detourX} V ${dstCy} H ${dstRight}`
  }
  const detourX = Math.min(srcLeft, dstLeft) - ELBOW_STUB * 2
  return `M ${srcLeft} ${srcCy} H ${detourX} V ${dstCy} H ${dstLeft}`
}

function bundleRelationLayoutEdges(
  items: RelationPositionedEdge[],
  levels: Record<string, number>,
): RelationLayoutEdge[] {
  const output: RelationLayoutEdge[] = []
  const grouped = new Map<string, RelationLayoutEdge>()

  for (const item of items) {
    const key = isRegistrationRelation(item.edge)
      ? null
      : relationPresentationEdgeGroupKey(item.edge, levels, item.familyKey)
    if (!key) {
      output.push({ ...item, edges: [item.edge], sources: [item.src], destinations: [item.dst] })
      continue
    }

    const existing = grouped.get(key)
    if (existing) {
      existing.edges.push(item.edge)
      if (!existing.sources.some((source) => source.node.id === item.src.node.id)) existing.sources.push(item.src)
      if (!existing.destinations.some((destination) => destination.node.id === item.dst.node.id))
        existing.destinations.push(item.dst)
      continue
    }

    const bundle = { ...item, edges: [item.edge], sources: [item.src], destinations: [item.dst] }
    grouped.set(key, bundle)
    output.push(bundle)
  }

  for (const bundle of grouped.values()) {
    bundle.sources.sort((a, b) => a.y - b.y || a.node.id.localeCompare(b.node.id))
    bundle.destinations.sort((a, b) => a.y - b.y || a.node.id.localeCompare(b.node.id))
    bundle.edges.sort((a, b) => stableEdgeKey(a).localeCompare(stableEdgeKey(b)))
    bundle.src = bundle.sources[0] ?? bundle.src
    bundle.dst = bundle.destinations[0] ?? bundle.dst
    bundle.edge = bundle.edges[0] ?? bundle.edge
  }

  return output
}

function bundledOrthogonalPath(item: RelationLayoutEdge, nh: number, registrationEdge = false): string {
  if (registrationEdge || (item.sources.length <= 1 && item.destinations.length <= 1))
    return orthogonalPath(
      item.src.x,
      item.src.y,
      item.src.width,
      item.dst.x,
      item.dst.y,
      item.dst.width,
      nh,
      registrationEdge,
    )

  const sources = [...item.sources].sort((a, b) => a.y - b.y || a.node.id.localeCompare(b.node.id))
  const dstLeft = item.dst.x
  const dstRight = item.dst.x + item.dst.width
  const dstCy = item.dst.y + nh / 2

  if (sources.every((source) => dstRight <= source.x)) {
    const trunkX = (Math.min(...sources.map((source) => source.x)) - ELBOW_STUB + (dstRight + ELBOW_STUB)) / 2
    const [first, ...rest] = sources
    let d = `M ${first.x} ${first.y + nh / 2} H ${trunkX}`
    for (const source of rest) d += ` V ${source.y + nh / 2} H ${source.x} H ${trunkX}`
    return `${d} V ${dstCy} H ${dstRight}`
  }

  if (sources.every((source) => source.x + source.width <= dstLeft)) {
    const trunkX =
      (Math.max(...sources.map((source) => source.x + source.width)) + ELBOW_STUB + (dstLeft - ELBOW_STUB)) / 2
    const [first, ...rest] = sources
    let d = `M ${first.x + first.width} ${first.y + nh / 2} H ${trunkX}`
    for (const source of rest) d += ` V ${source.y + nh / 2} H ${source.x + source.width} H ${trunkX}`
    return `${d} V ${dstCy} H ${dstLeft}`
  }

  if (item.destinations.length > 1) {
    const destinations = [...item.destinations].sort((a, b) => a.y - b.y || a.node.id.localeCompare(b.node.id))
    const srcLeft = item.src.x
    const srcRight = item.src.x + item.src.width
    const srcCy = item.src.y + nh / 2

    if (destinations.every((destination) => destination.x >= srcRight)) {
      const trunkX =
        (srcRight + ELBOW_STUB + Math.min(...destinations.map((destination) => destination.x)) - ELBOW_STUB) / 2
      let d = `M ${srcRight} ${srcCy} H ${trunkX}`
      destinations.forEach((destination, index) => {
        const endpointX = destination.x
        const cy = destination.y + nh / 2
        d += ` V ${cy} H ${endpointX}`
        if (index < destinations.length - 1) d += ` H ${trunkX}`
      })
      return d
    }

    if (destinations.every((destination) => destination.x + destination.width <= srcLeft)) {
      const trunkX =
        (srcLeft -
          ELBOW_STUB +
          Math.max(...destinations.map((destination) => destination.x + destination.width)) +
          ELBOW_STUB) /
        2
      let d = `M ${srcLeft} ${srcCy} H ${trunkX}`
      destinations.forEach((destination, index) => {
        const endpointX = destination.x + destination.width
        const cy = destination.y + nh / 2
        d += ` V ${cy} H ${endpointX}`
        if (index < destinations.length - 1) d += ` H ${trunkX}`
      })
      return d
    }
  }

  return orthogonalPath(
    item.src.x,
    item.src.y,
    item.src.width,
    item.dst.x,
    item.dst.y,
    item.dst.width,
    nh,
    registrationEdge,
  )
}

// ─── Component ───────────────────────────────────────────────────────────────
export type SurfaceIntelGraphTabDeps = {
  bridge?: SurfaceBridge
  file?: ReturnType<typeof useFile>
  layout?: ReturnType<typeof useSessionLayout>
}

export type SurfaceIntelGraphTabProps = {
  deps?: SurfaceIntelGraphTabDeps
}

export function SurfaceIntelGraphTab(props: SurfaceIntelGraphTabProps = {}) {
  const bridge = props.deps?.bridge ?? useSurfaceSessionBridge()
  const file = props.deps?.file ?? useFile()
  const { handoff, tabs, view } = props.deps?.layout ?? useSessionLayout()
  const [state, setState] = createStore({
    query: "",
    selectedFile: "",
    selectedLine: 0,
    selectedCharacter: 1,
    lastRelationTarget: "",
    lastRelationDirection: "incoming" as SurfaceIntelGraphDirection,
    lastRelationDepth: RELATION_STARTUP_DEPTH,
    canvasPanning: false,
    canvasZoom: 1,
    canvasScrollLeft: 0,
    canvasScrollTop: 0,
    canvasViewportWidth: 1,
    canvasViewportHeight: 1,
    canvasOverviewCollapsed: true,
  })
  const [graph, setGraph] = createStore<GraphStore>({
    rootId: "",
    focusId: "",
    selectedId: "",
    nodes: {},
    edges: {},
    levels: {},
    loadingIds: new Set(),
    error: "",
    truncationNotice: "",
    lastSelectedByRoot: {},
    relationCache: {},
  })
  let canvasViewportRef: HTMLDivElement | undefined
  let relationNavigationToken = 0
  let canvasPanState:
    | { pointerId: number; startX: number; startY: number; scrollLeft: number; scrollTop: number }
    | undefined

  const logRelationUiEvent = (
    message: string,
    level: "debug" | "info" | "warn" | "error" = "info",
    extra: Record<string, unknown> = {},
  ) => {
    emitDiagnosticLog({
      service: "web.intelgraph",
      level,
      message,
      extra: {
        rootId: graph.rootId || undefined,
        focusId: graph.focusId || undefined,
        selectedFile: state.selectedFile || undefined,
        selectedLine: state.selectedLine || undefined,
        visibleNodeCount: Object.keys(graph.nodes).length,
        visibleEdgeCount: Object.keys(graph.edges).length,
        ...extra,
      },
    })
  }

  // ── Merge helper ──────────────────────────────────────────────────────────
  const mergeRelations = (data: SurfaceIntelGraphRelations, options: MergeOptions) => {
    const responseTargetId = data.node?.id || options.targetId
    const baseNodes = options.reset ? {} : graph.nodes
    const visibleTargetId = !options.reset && baseNodes[options.targetId] ? options.targetId : responseTargetId
    const dataForMerge = rebaseSurfaceIntelGraphRelationsRoot(data, visibleTargetId)
    const canonicalTargetId = dataForMerge.node?.id || visibleTargetId
    const canonicalRootId = options.reset ? canonicalTargetId : options.rootId
    const baseEdges = options.reset ? {} : graph.edges
    const baseLevels = options.reset ? {} : graph.levels
    const flattened = flattenRelations(dataForMerge, canonicalTargetId, options.direction, {
      includeIndirect: !(options.reset && options.direction !== "both"),
    })
    const filteredNodes = flattened.nodes.filter((node) => isApiSymbolNode(node, canonicalRootId))
    const nextNodes: Record<string, SurfaceIntelGraphNode> = { ...baseNodes }
    const nextEdges: Record<string, SurfaceIntelGraphEdge> = { ...baseEdges }
    const nextLevels: Record<string, number> = { ...baseLevels, [canonicalTargetId]: options.targetLevel }
    const existingCount = Object.keys(nextNodes).length
    const newNodeIds = filteredNodes.filter((node) => !nextNodes[node.id]).map((node) => node.id)
    const allowedNewNodeIds = new Set(newNodeIds.slice(0, Math.max(0, VISIBLE_NODE_CAP - existingCount)))
    const truncated = newNodeIds.length > allowedNewNodeIds.size

    for (const node of filteredNodes) {
      if (nextNodes[node.id] || allowedNewNodeIds.has(node.id))
        nextNodes[node.id] = { ...(nextNodes[node.id] ?? {}), ...node }
    }
    for (const edge of flattened.edges) {
      if (!nextNodes[edge.src] || !nextNodes[edge.dst]) continue
      const key = stableEdgeKey(edge)
      nextEdges[key] = edge
      nextLevels[edge.src] = mergedRelationLevel(
        edge,
        edge.src,
        canonicalTargetId,
        options.targetLevel,
        options.direction,
        nextLevels[edge.src],
        canonicalRootId,
      )
      nextLevels[edge.dst] = mergedRelationLevel(
        edge,
        edge.dst,
        canonicalTargetId,
        options.targetLevel,
        options.direction,
        nextLevels[edge.dst],
        canonicalRootId,
      )
    }
    if (nextNodes[canonicalRootId]) nextLevels[canonicalRootId] = 0
    const fallbackFocus =
      graph.lastSelectedByRoot[canonicalRootId] && nextNodes[graph.lastSelectedByRoot[canonicalRootId]]
        ? graph.lastSelectedByRoot[canonicalRootId]
        : canonicalRootId
    const pruned = pruneOrphanIntelGraphRelationState(canonicalRootId, {
      nodes: nextNodes,
      edges: nextEdges,
      levels: nextLevels,
    })
    const focusId = options.reset
      ? fallbackFocus
      : pruned.nodes[canonicalTargetId]
        ? canonicalTargetId
        : pruned.nodes[fallbackFocus]
          ? fallbackFocus
          : canonicalRootId
    const nextLoadingIds = relationLoadingIdsAfterCompletion(graph.loadingIds, [options.targetId, canonicalTargetId])
    setGraph({
      rootId: canonicalRootId,
      focusId,
      selectedId: focusId,
      nodes: pruned.nodes,
      edges: pruned.edges,
      levels: pruned.levels,
      loadingIds: nextLoadingIds,
      error: "",
      truncationNotice: truncated
        ? `Showing the first ${VISIBLE_NODE_CAP} relation nodes. Additional one-hop results were truncated.`
        : "",
    })
    if (pruned.orphanIds.length > 0)
      logRelationUiEvent("relation.layout.prune_orphans", "debug", {
        orphanIds: pruned.orphanIds.slice(0, 20),
        orphanCount: pruned.orphanIds.length,
      })
    return { visibleNodeCount: Object.keys(pruned.nodes).length, visibleEdgeCount: Object.keys(pruned.edges).length }
  }

  // ── Load helper ───────────────────────────────────────────────────────────
  const loadRelations = async (
    targetId: string,
    direction: SurfaceIntelGraphDirection,
    reset = false,
    refreshSnapshot = false,
    depth = RELATION_EXPANSION_DEPTH,
  ) => {
    if (!targetId) return
    const location = symbolLocation(targetId)
    const targetNode = graph.nodes[targetId]
    const rootId = reset ? targetId : graph.rootId || targetId
    const targetLevel = reset ? 0 : (graph.levels[targetId] ?? 0)
    const fallbackLine = reset || targetId === graph.rootId ? state.selectedLine : 0
    const phase = reset ? "initial" : "expansion"
    setState({ lastRelationTarget: targetId, lastRelationDirection: direction, lastRelationDepth: depth })
    const nextLoadingIds = new Set(graph.loadingIds)
    nextLoadingIds.add(targetId)
    setGraph({ loadingIds: nextLoadingIds, error: "", truncationNotice: reset ? "" : graph.truncationNotice })
    const requestFile = targetNode?.file_path || state.selectedFile || location.file || undefined
    const requestLine = targetNode?.line ?? (fallbackLine > 0 ? fallbackLine : location.line)
    const requestCharacter = reset || targetId === graph.rootId ? state.selectedCharacter : undefined
    const completionIds = [targetId]
    const requestLog = {
      rootId,
      targetId,
      direction,
      depth,
      file: requestFile,
      line: requestLine,
      character: requestCharacter,
      refreshSnapshot,
    }
    logRelationUiEvent(`relation.${phase}.start`, "info", requestLog)
    const cacheKey = relationCacheKey(direction, depth)
    const cached = !reset && !refreshSnapshot ? graph.relationCache[targetId]?.[cacheKey] : undefined
    if (cached) {
      const visible = mergeRelations(cached, { rootId, targetId, direction, targetLevel, reset })
      logRelationUiEvent(`relation.${phase}.cache_hit`, "info", {
        ...requestLog,
        cacheKey,
        visibleNodeCountAfterMerge: visible.visibleNodeCount,
        visibleEdgeCountAfterMerge: visible.visibleEdgeCount,
      })
      setGraph("loadingIds", relationLoadingIdsAfterCompletion(graph.loadingIds, completionIds))
      return
    }
    try {
      const data = surfaceRelationsFromV1(
        await withRelationRequestTimeout(
          bridge.resolveRelations(
            {
              symbol: targetId,
              file: requestFile,
              line: requestLine,
              character: requestCharacter,
              kinds: relationKindsForRequest(direction, reset),
              language: "c",
            },
            { force: true, refresh: refreshSnapshot || undefined },
          ),
          targetId,
        ),
      )
      if (data.node?.id) completionIds.push(data.node.id)
      if (!data.node) {
        logRelationUiEvent(`relation.${phase}.miss`, "warn", {
          ...requestLog,
          nodeCount: data.nodes?.length ?? 0,
          edgeCount: relationPayloadEdgeCount(data),
          groupCount: data.groups?.length ?? 0,
          diagnosticCode: data.diagnostic?.code,
          diagnosticMessage: data.diagnostic?.message,
          ...relationDataDebugSummary(data),
        })
        setGraph({
          error: relationMissMessage(data, targetId, requestFile, requestLine),
          truncationNotice: "",
        })
        return
      }
      const cacheTargetIds = new Set([data.node.id, targetId].filter(Boolean))
      const hasNotReadyDiagnostic =
        data.diagnostics?.some(
          (d) => d.code === "intelgraph_index_not_ready" || d.code === "intelgraph_runtime_degraded",
        ) || data.diagnostic?.code === "intelgraph_index_not_ready"
      if (!hasNotReadyDiagnostic) {
        setGraph("relationCache", (current) => {
          const next: RelationExpansionCache = { ...current }
          for (const id of cacheTargetIds) next[id] = { ...(next[id] ?? {}), [cacheKey]: data }
          return next
        })
      }
      const visible = mergeRelations(data, { rootId, targetId, direction, targetLevel, reset })
      logRelationUiEvent(`relation.${phase}.success`, "info", {
        ...requestLog,
        canonicalTargetId: data.node.id,
        nodeCount: (data.nodes?.length ?? 0) + 1,
        edgeCount: relationPayloadEdgeCount(data),
        groupCount: data.groups?.length ?? 0,
        visibleNodeCountAfterMerge: visible.visibleNodeCount,
        visibleEdgeCountAfterMerge: visible.visibleEdgeCount,
        diagnosticCode: data.diagnostic?.code,
        ...relationDataDebugSummary(data),
      })
    } catch (error) {
      const timedOut =
        (error instanceof Error && error.message.toLowerCase().includes("timed out")) ||
        (error instanceof DOMException && error.name === "AbortError")
      logRelationUiEvent(`relation.${phase}.${timedOut ? "timeout" : "error"}`, timedOut ? "warn" : "error", {
        ...requestLog,
        error: diagnosticError(error),
      })
      setGraph({
        error: relationErrorMessage(error, targetId, requestFile, requestLine),
        truncationNotice: "",
        relationCache: {},
      })
    } finally {
      setGraph("loadingIds", relationLoadingIdsAfterCompletion(graph.loadingIds, completionIds))
    }
  }

  // ── Handoff effect ────────────────────────────────────────────────────────
  createEffect(
    on(
      () => handoff.intelGraphFocus(),
      (focus) => {
        if (!focus) return
        const symbolId = focus.symbolId ?? ""
        const label = focus.symbolName || focus.query || focus.filePath || symbolId
        const wantsRelationships = focus.action === "relationships"
        const location = symbolLocation(symbolId)
        setState({
          selectedFile: focus.filePath ?? location.file ?? "",
          selectedLine: focus.lineNumber ?? location.line ?? 0,
          selectedCharacter: focus.characterNumber ?? 1,
          query: label,
        })
        if (wantsRelationships && symbolId) {
          logRelationUiEvent("relation.handoff.received", "info", {
            symbolId,
            symbolName: focus.symbolName,
            filePath: focus.filePath,
            lineNumber: focus.lineNumber,
            characterNumber: focus.characterNumber,
          })
          void loadRelations(symbolId, "incoming", true, false, RELATION_STARTUP_DEPTH)
        } else if (wantsRelationships && focus.filePath && focus.lineNumber) {
          logRelationUiEvent("relation.handoff.location_only", "warn", {
            filePath: focus.filePath,
            lineNumber: focus.lineNumber,
            characterNumber: focus.characterNumber,
          })
          void loadRelations(
            `location@${focus.filePath}:${focus.lineNumber}`,
            "incoming",
            true,
            false,
            RELATION_STARTUP_DEPTH,
          )
        } else if (symbolId) {
          setGraph({
            rootId: symbolId,
            focusId: symbolId,
            selectedId: symbolId,
            nodes: { [symbolId]: fallbackNode(symbolId, "root") },
            edges: {},
            levels: { [symbolId]: 0 },
            error: "",
            truncationNotice: "",
          })
        }
        handoff.clearIntelGraphFocus()
      },
    ),
  )

  // ── Derived state ─────────────────────────────────────────────────────────
  const graphNodes = createMemo(() => Object.values(graph.nodes))
  const graphEdges = createMemo(() => Object.values(graph.edges))
  const canvasGraph = createMemo(() =>
    graphNodes().length > 0 ? { nodes: graphNodes(), edges: graphEdges() } : undefined,
  )
  const focusNode = createMemo(() => graph.nodes[graph.focusId])
  const isLoading = createMemo(() => graph.loadingIds.size > 0)
  const canvasZoom = createMemo(() => clampCanvasZoom(state.canvasZoom))
  const canvasDetailLevel = createMemo(() => relationCanvasDetailLevel(canvasZoom()))
  const canvasShowRelationLabels = createMemo(() => canvasDetailLevel() !== "compact")
  const canvasShowNodeControls = createMemo(() => canvasDetailLevel() !== "compact")
  const canvasShowNodeSubtitle = createMemo(() => canvasDetailLevel() === "detailed")
  const updateCanvasViewportMetrics = () => {
    const viewport = canvasViewportRef
    if (!viewport) return
    setState({
      canvasScrollLeft: viewport.scrollLeft,
      canvasScrollTop: viewport.scrollTop,
      canvasViewportWidth: Math.max(1, viewport.clientWidth),
      canvasViewportHeight: Math.max(1, viewport.clientHeight),
    })
  }
  // ── Layout ────────────────────────────────────────────────────────────────
  const relationWindowLayout = createMemo(() => {
    const nodes = graphNodes()
    const edges = graphEdges()
    const labelCounts = nodes.reduce((counts, node) => {
      const label = nodeLabel(node)
      counts.set(label, (counts.get(label) ?? 0) + 1)
      return counts
    }, new Map<string, number>())
    const layoutScores = relationLayoutScores(nodes, edges, graph.levels, graph.rootId)
    const layoutLevels = layoutScores.levels
    const childOccurrences = new Map<
      string,
      Array<{ edge: SurfaceIntelGraphEdge; role: "src" | "dst"; parentId: string }>
    >()
    const childParents = new Map<string, Set<string>>()
    for (const edge of [...edges].sort((a, b) => stableEdgeKey(a).localeCompare(stableEdgeKey(b)))) {
      const relation = relationVisualParentChild(edge, layoutLevels, graph.rootId)
      if (!relation) continue
      childOccurrences.set(relation.childId, [
        ...(childOccurrences.get(relation.childId) ?? []),
        { edge, role: relation.childRole, parentId: relation.parentId },
      ])
      childParents.set(relation.childId, new Set([...(childParents.get(relation.childId) ?? []), relation.parentId]))
    }
    const relationAppearanceCounts = new Map(
      [...childParents.entries()].map(([id, parents]) => [id, parents.size] as const),
    )
    const levels = new Map<number, SurfaceIntelGraphNode[]>()
    for (const node of nodes) {
      const level = layoutLevels[node.id] ?? graph.levels[node.id] ?? 0
      levels.set(level, [...(levels.get(level) ?? []), node])
    }
    const orderedLevels = (() => {
      const values = new Set(levels.keys())
      // Keep the root column visually centered and reserve the canonical sides:
      // callees/outgoing relations are left of root; callers/incoming relations are right of root.
      if (values.has(0)) {
        values.add(-1)
        values.add(1)
      }
      return [...values].sort((a, b) => a - b)
    })()
    for (const level of orderedLevels)
      levels.set(
        level,
        [...(levels.get(level) ?? [])].sort((a, b) => {
          const yDelta = (layoutScores.yScores[a.id] ?? 0) - (layoutScores.yScores[b.id] ?? 0)
          if (yDelta !== 0) return yDelta
          return relationNodeSortKey(a).localeCompare(relationNodeSortKey(b))
        }),
      )
    const yLevels = nodes.map((node) => layoutScores.yScores[node.id] ?? 0)
    const minYLevel = Math.min(0, ...yLevels)
    const maxYLevel = Math.max(0, ...yLevels)
    const maxRows = Math.max(1, maxYLevel - minYLevel + 1)
    const levelWidths = new Map(
      orderedLevels.map((level) => {
        const maxWidth = Math.max(
          NODE_MIN_W,
          ...(levels.get(level) ?? []).map((node) =>
            relationNodeWidth(node, (labelCounts.get(nodeLabel(node)) ?? 0) > 1),
          ),
        )
        return [level, maxWidth] as const
      }),
    )
    const columnX = new Map<number, number>()
    let cursorX = PAD_X
    for (const level of orderedLevels) {
      columnX.set(level, cursorX)
      cursorX += (levelWidths.get(level) ?? NODE_MIN_W) + COL_GAP
    }
    const width = Math.max(900, cursorX - COL_GAP + PAD_X)
    const height = Math.max(460, maxRows * (NODE_H + ROW_GAP) + PAD_Y * 2)
    const totalRowsHeight = maxRows * NODE_H + Math.max(0, maxRows - 1) * ROW_GAP
    const y0 = Math.max(PAD_Y, Math.floor((height - totalRowsHeight) / 2))
    const endpointVisualIds = new Map<string, string>()
    const positionedDraft = orderedLevels.flatMap((level) => {
      const items = levels.get(level) ?? []
      return items.flatMap((node, rowIndex) => {
        const duplicateLabel = (labelCounts.get(nodeLabel(node)) ?? 0) > 1
        const isStableParentNode = node.id === graph.rootId || node.id === graph.focusId
        const duplicateCount = isStableParentNode ? 1 : Math.max(1, relationAppearanceCounts.get(node.id) ?? 1)
        const duplicateColor = relationDuplicateColor(node.id, duplicateCount)
        const nodeWidth = relationNodeWidth(node, duplicateLabel)
        const baseYLevel = layoutScores.yScores[node.id] ?? rowIndex
        const occurrences = isStableParentNode || duplicateCount <= 1 ? [] : (childOccurrences.get(node.id) ?? [])
        const occurrencesByParent = new Map<string, (typeof occurrences)[number]>()
        for (const occurrence of occurrences) {
          if (!occurrencesByParent.has(occurrence.parentId)) occurrencesByParent.set(occurrence.parentId, occurrence)
        }
        // Physical duplicates are child-only: one visual child instance per distinct parent.
        // Parent/current/root nodes remain stable anchors even when many children point at them.
        const visualItems = occurrencesByParent.size > 1 ? [...occurrencesByParent.values()] : []
        const renderItems =
          visualItems.length > 1 ? visualItems : [{ edge: undefined, role: undefined, parentId: undefined }]
        return renderItems.map((occurrence, occurrenceIndex) => {
          const parentYLevel = occurrence.parentId
            ? (layoutScores.yScores[occurrence.parentId] ?? baseYLevel)
            : baseYLevel
          const offset = visualItems.length > 1 ? (occurrenceIndex - (visualItems.length - 1) / 2) * 0.75 : 0
          const yLevel = visualItems.length > 1 ? parentYLevel + offset : baseYLevel
          const yBand = [yLevel, yLevel] as const
          const visualId = occurrence.edge ? `${stableEdgeKey(occurrence.edge)}:${occurrence.role}:${node.id}` : node.id
          const item: RelationLayoutNodeDraft = {
            visualId,
            semanticId: node.id,
            node,
            level,
            xLevel: level,
            yLevel,
            yBand,
            yBandStart: yBand[0],
            yBandEnd: yBand[1],
            lane: yLevel,
            duplicateLabel,
            duplicateCount,
            duplicateColor,
            subtitle: relationNodeSubtitle(node),
            width: nodeWidth,
          }
          if (occurrence.parentId !== undefined) {
            for (const childOccurrence of occurrences) {
              if (childOccurrence.parentId === occurrence.parentId)
                endpointVisualIds.set(`${stableEdgeKey(childOccurrence.edge)}:${childOccurrence.role}`, item.visualId)
            }
          }
          return item
        })
      })
    })
    const resolvedDraft = resolveIntelGraphVisualYOverlaps(positionedDraft, RELATION_VISUAL_MIN_ROW_GAP)
    const resolvedYLevels = resolvedDraft.map((node) => node.yLevel)
    const resolvedMinYLevel = Math.min(0, ...resolvedYLevels)
    const resolvedMaxYLevel = Math.max(0, ...resolvedYLevels)
    const resolvedRows = Math.max(1, resolvedMaxYLevel - resolvedMinYLevel + 1)
    const resolvedHeight = Math.max(460, resolvedRows * (NODE_H + ROW_GAP) + PAD_Y * 2)
    const resolvedTotalRowsHeight = resolvedRows * NODE_H + Math.max(0, resolvedRows - 1) * ROW_GAP
    const resolvedY0 = Math.max(PAD_Y, Math.floor((resolvedHeight - resolvedTotalRowsHeight) / 2))
    const positioned = resolvedDraft.map((node) => ({
      ...node,
      yBand: [node.yLevel, node.yLevel] as const,
      yBandStart: node.yLevel,
      yBandEnd: node.yLevel,
      lane: node.yLevel,
      x: (columnX.get(node.level) ?? PAD_X) + ((levelWidths.get(node.level) ?? node.width) - node.width) / 2,
      y: resolvedY0 + (node.yLevel - resolvedMinYLevel) * (NODE_H + ROW_GAP),
    }))
    const byId = new Map(positioned.map((item) => [item.node.id, item] as const))
    const byVisualId = new Map(positioned.map((item) => [item.visualId, item] as const))
    const endpointVisuals = new Map(
      [...endpointVisualIds.entries()].flatMap(([key, visualId]) => {
        const item = byVisualId.get(visualId)
        return item ? [[key, item] as const] : []
      }),
    )
    return {
      width,
      height: resolvedHeight,
      nodeHeight: NODE_H,
      nodes: positioned,
      edges: bundleRelationLayoutEdges(
        edges
          .map((edge) => {
            // Keep render-time colors aligned with the connection-set contract:
            // incoming rails share destination-set color, outgoing rails share source-set color.
            const familyKey = relationEdgeFamilyKey(edge, layoutLevels, layoutScores.branchAnchors)
            return {
              edge,
              src: endpointVisuals.get(`${stableEdgeKey(edge)}:src`) ?? byId.get(edge.src),
              dst: endpointVisuals.get(`${stableEdgeKey(edge)}:dst`) ?? byId.get(edge.dst),
              familyKey,
              paletteIndex: relationEdgeFamilyPaletteIndex(familyKey),
              color: relationEdgeColor(edge, familyKey),
            }
          })
          .filter(
            (
              item,
            ): item is {
              edge: SurfaceIntelGraphEdge
              src: NonNullable<typeof item.src>
              dst: NonNullable<typeof item.dst>
              familyKey: string
              paletteIndex: number
              color: string
            } => !!item.src && !!item.dst,
          ),
        layoutLevels,
      ),
    }
  })

  const minimapViewport = createMemo(() => {
    const layout = relationWindowLayout()
    const zoom = canvasZoom()
    const scale = Math.min(CANVAS_MINIMAP_W / Math.max(1, layout.width), CANVAS_MINIMAP_H / Math.max(1, layout.height))
    return {
      scale,
      width: Math.max(1, layout.width * scale),
      height: Math.max(1, layout.height * scale),
      x: Math.max(0, (state.canvasScrollLeft / zoom) * scale),
      y: Math.max(0, (state.canvasScrollTop / zoom) * scale),
      w: Math.max(6, (state.canvasViewportWidth / zoom) * scale),
      h: Math.max(6, (state.canvasViewportHeight / zoom) * scale),
    }
  })

  createEffect(() => {
    relationWindowLayout().width
    relationWindowLayout().height
    canvasZoom()
    requestAnimationFrame(updateCanvasViewportMetrics)
  })

  // ── Actions ───────────────────────────────────────────────────────────────
  const rememberFocus = (id: string) => {
    if (!id) return
    setGraph("focusId", id)
    setGraph("selectedId", id)
    if (graph.rootId) setGraph("lastSelectedByRoot", graph.rootId, id)
  }

  const captureViewportAnchor = (nodeId: string): ViewportAnchor | undefined => {
    const viewport = canvasViewportRef
    if (!viewport) return undefined
    const target = relationWindowLayout().nodes.find((item) => item.node.id === nodeId)
    if (!target) return undefined
    const centerX = target.x + target.width / 2
    const centerY = target.y + relationWindowLayout().nodeHeight / 2
    return {
      nodeId,
      centerOffsetX: centerX - viewport.scrollLeft,
      centerOffsetY: centerY - viewport.scrollTop,
    }
  }

  const restoreViewportAnchor = (anchor: ViewportAnchor | undefined) => {
    if (!anchor) return
    const viewport = canvasViewportRef
    if (!viewport) return
    const target = relationWindowLayout().nodes.find((item) => item.node.id === anchor.nodeId)
    if (!target) return
    const centerX = target.x + target.width / 2
    const centerY = target.y + relationWindowLayout().nodeHeight / 2
    const maxScrollLeft = Math.max(0, relationWindowLayout().width - viewport.clientWidth)
    const maxScrollTop = Math.max(0, relationWindowLayout().height - viewport.clientHeight)
    const nextScrollLeft = Math.max(0, Math.min(maxScrollLeft, Math.round(centerX - anchor.centerOffsetX)))
    const nextScrollTop = Math.max(0, Math.min(maxScrollTop, Math.round(centerY - anchor.centerOffsetY)))
    viewport.scrollTo({ left: nextScrollLeft, top: nextScrollTop, behavior: "auto" })
  }

  const navigateCodeToNode = (node: SurfaceIntelGraphNode) => {
    rememberFocus(node.id)
    const location = nodeDefinitionLocation(node)
    const symbol = node.id.split("@")[0]?.split("#").pop() || nodeLabel(node) || ""
    const navigationToken = ++relationNavigationToken
    const isLatestNavigation = () => navigationToken === relationNavigationToken
    intelGraphDebug("node navigation requested", {
      id: node.id,
      label: nodeLabel(node),
      kind: node.kind,
      exported: node.exported,
      tags: node.tags,
      file_path: node.file_path,
      line: node.line,
      resolvedFile: location.file,
      resolvedLine: location.line,
      navigationToken,
    })
    if (!location.file) {
      logRelationUiEvent("relation.node.navigation.miss", "warn", {
        targetId: node.id,
        label: nodeLabel(node),
        kind: node.kind,
        file: node.file_path,
        line: node.line,
      })
      intelGraphDebug("node navigation failed: no definition file", { id: node.id, navigationToken })
      showToast({
        variant: "error",
        title: "No definition location",
        description: `IntelGraph could not resolve a source file for ${nodeLabel(node)}`,
      })
      return
    }

    const definitionFile = location.file
    const tab = file.tab(definitionFile)
    const readLoadedFileText = () => {
      const state = file.get(definitionFile)
      const content = state?.content
      if (content?.type !== "text") return undefined
      return content.content
    }
    const resolveLine = () => resolvedDefinitionLineFromText(readLoadedFileText(), symbol, location.line ?? undefined)
    const applyLine = (line: number | undefined) => {
      if (!isLatestNavigation()) return
      if (line && Number.isFinite(line) && line > 0) {
        file.setSelectedLines(definitionFile, { start: line, end: line })
        view().setScroll(tab, { x: 0, y: definitionScrollTop(line) })
      } else {
        file.setSelectedLines(definitionFile, null)
      }
    }

    const initialLine = resolveLine()
    logRelationUiEvent("relation.node.navigation.success", "info", {
      targetId: node.id,
      label: nodeLabel(node),
      kind: node.kind,
      file: location.file,
      line: initialLine ?? location.line,
      tab,
      navigationToken,
    })
    intelGraphDebug("opening definition tab", {
      tab,
      file: location.file,
      line: initialLine ?? location.line,
      symbol,
      navigationToken,
    })
    applyLine(initialLine)

    void tabs().open(tab)
    tabs().setActive(tab)
    void file.load(location.file).finally(() => {
      if (!isLatestNavigation()) {
        intelGraphDebug("skipping stale navigation completion", { tab, symbol, navigationToken })
        return
      }
      applyLine(resolveLine() ?? initialLine)
      tabs().setActive(tab)
    })
  }

  const expandNode = (node: SurfaceIntelGraphNode, direction: SurfaceIntelGraphDirection) => {
    rememberFocus(node.id)
    const viewportAnchor = captureViewportAnchor(node.id)
    logRelationUiEvent("relation.node.expand.click", "info", {
      action: relationExpansionAction(direction),
      targetId: node.id,
      direction,
      depth: RELATION_EXPANSION_DEPTH,
      file: node.file_path,
      line: node.line,
    })
    void loadRelations(node.id, direction, false, false, RELATION_EXPANSION_DEPTH).finally(() => {
      restoreViewportAnchor(viewportAnchor)
    })
  }

  const refreshSnapshotAndRetry = () => {
    const targetId = state.lastRelationTarget || graph.rootId
    if (!targetId || isLoading()) return
    setGraph("relationCache", {})
    void loadRelations(
      targetId,
      state.lastRelationDirection || "incoming",
      true,
      true,
      state.lastRelationDepth || RELATION_STARTUP_DEPTH,
    )
  }

  const openLogsTab = () => {
    if (tabs().activeB() === "intelgraph") {
      tabs().openInB("logs")
      tabs().setActiveB("logs")
      return
    }
    void tabs().open("logs")
    tabs().setActive("logs")
  }

  const deleteNode = (node: SurfaceIntelGraphNode) => {
    logRelationUiEvent("relation.node.close.click", "info", {
      targetId: node.id,
      file: node.file_path,
      line: node.line,
      closesRoot: node.id === graph.rootId,
    })
    if (node.id === graph.rootId) {
      setGraph({
        rootId: "",
        focusId: "",
        selectedId: "",
        nodes: {},
        edges: {},
        levels: {},
        error: "",
        truncationNotice: "",
      })
      return
    }
    const nextNodes = { ...graph.nodes }
    delete nextNodes[node.id]
    const nextEdges = Object.fromEntries(
      Object.entries(graph.edges).filter(([, edge]) => edge.src !== node.id && edge.dst !== node.id),
    )
    const nextLevels = { ...graph.levels }
    delete nextLevels[node.id]
    const pruned = pruneOrphanIntelGraphRelationState(graph.rootId, {
      nodes: nextNodes,
      edges: nextEdges,
      levels: nextLevels,
    })
    const focusId = graph.focusId === node.id || !pruned.nodes[graph.focusId] ? graph.rootId : graph.focusId
    setGraph({ nodes: pruned.nodes, edges: pruned.edges, levels: pruned.levels, focusId, selectedId: focusId })
  }

  const collapseSisters = (node: SurfaceIntelGraphNode) => {
    rememberFocus(node.id)
    const level = graph.levels[node.id]
    if (level === undefined) return
    const remove = new Set(
      Object.keys(graph.nodes).filter((id) => id !== node.id && id !== graph.rootId && graph.levels[id] === level),
    )
    logRelationUiEvent("relation.node.collapse_sisters.click", "info", {
      targetId: node.id,
      file: node.file_path,
      line: node.line,
      level,
      removedNodeCount: remove.size,
    })
    const nextNodes = Object.fromEntries(Object.entries(graph.nodes).filter(([id]) => !remove.has(id)))
    const nextEdges = Object.fromEntries(
      Object.entries(graph.edges).filter(([, edge]) => !remove.has(edge.src) && !remove.has(edge.dst)),
    )
    const nextLevels = Object.fromEntries(Object.entries(graph.levels).filter(([id]) => !remove.has(id)))
    const pruned = pruneOrphanIntelGraphRelationState(graph.rootId, {
      nodes: nextNodes,
      edges: nextEdges,
      levels: nextLevels,
    })
    setGraph({ nodes: pruned.nodes, edges: pruned.edges, levels: pruned.levels })
  }

  const moveFocus = (deltaLevel: number, deltaIndex: number) => {
    const current = graph.nodes[graph.focusId]
    if (!current) return
    const layoutNodes = relationWindowLayout().nodes
    const currentPosition = layoutNodes.find((item) => item.node.id === current.id)
    const currentLevel = graph.levels[current.id] ?? 0
    const targetLevel = currentLevel + deltaLevel
    if (deltaLevel === 0) {
      const sameLevel = layoutNodes
        .filter((item) => item.level === currentLevel)
        .sort((a, b) => a.y - b.y || nodeLabel(a.node).localeCompare(nodeLabel(b.node)))
      const index = sameLevel.findIndex((item) => item.node.id === current.id)
      const next = sameLevel[Math.max(0, Math.min(sameLevel.length - 1, index + deltaIndex))]
      if (next) rememberFocus(next.node.id)
      return
    }
    const candidates = layoutNodes.filter((item) => item.level === targetLevel)
    const target = candidates.sort(
      (a, b) =>
        Math.abs(a.y - (currentPosition?.y ?? 0)) - Math.abs(b.y - (currentPosition?.y ?? 0)) ||
        nodeLabel(a.node).localeCompare(nodeLabel(b.node)),
    )[0]
    if (target) rememberFocus(target.node.id)
  }

  const setCanvasZoomAroundViewportPoint = (nextZoom: number, clientX?: number, clientY?: number) => {
    const viewport = canvasViewportRef
    const previousZoom = canvasZoom()
    const zoom = clampCanvasZoom(nextZoom)
    if (Math.abs(previousZoom - zoom) < 0.001) return
    if (!viewport) {
      setState("canvasZoom", zoom)
      return
    }
    const rect = viewport.getBoundingClientRect()
    const anchorX = clientX === undefined ? rect.width / 2 : clientX - rect.left
    const anchorY = clientY === undefined ? rect.height / 2 : clientY - rect.top
    const contentX = (viewport.scrollLeft + anchorX) / previousZoom
    const contentY = (viewport.scrollTop + anchorY) / previousZoom
    setState("canvasZoom", zoom)
    requestAnimationFrame(() => {
      viewport.scrollLeft = Math.max(0, contentX * zoom - anchorX)
      viewport.scrollTop = Math.max(0, contentY * zoom - anchorY)
      updateCanvasViewportMetrics()
    })
  }

  const resetCanvasZoom = () => {
    setCanvasZoomAroundViewportPoint(1)
  }

  const fitCanvasToViewport = () => {
    const viewport = canvasViewportRef
    if (!viewport) return
    const layout = relationWindowLayout()
    const nextZoom = clampCanvasZoom(
      Math.min(
        1,
        Math.max(0.1, (viewport.clientWidth - CANVAS_FIT_PADDING) / layout.width),
        Math.max(0.1, (viewport.clientHeight - CANVAS_FIT_PADDING) / layout.height),
      ),
    )
    setState("canvasZoom", nextZoom)
    requestAnimationFrame(() => {
      viewport.scrollLeft = Math.max(0, (layout.width * nextZoom - viewport.clientWidth) / 2)
      viewport.scrollTop = Math.max(0, (layout.height * nextZoom - viewport.clientHeight) / 2)
      updateCanvasViewportMetrics()
    })
  }

  const onCanvasWheel = (event: WheelEvent & { currentTarget: HTMLDivElement }) => {
    if (!event.ctrlKey && !event.metaKey) return
    event.preventDefault()
    const direction = event.deltaY > 0 ? -1 : 1
    setCanvasZoomAroundViewportPoint(canvasZoom() + direction * CANVAS_ZOOM_STEP, event.clientX, event.clientY)
  }

  const onCanvasScroll = () => updateCanvasViewportMetrics()

  const onMinimapPointerDown = (event: PointerEvent & { currentTarget: SVGSVGElement }) => {
    const viewport = canvasViewportRef
    if (!viewport) return
    const map = minimapViewport()
    const rect = event.currentTarget.getBoundingClientRect()
    const x = Math.max(0, Math.min(map.width, event.clientX - rect.left - (CANVAS_MINIMAP_W - map.width) / 2))
    const y = Math.max(0, Math.min(map.height, event.clientY - rect.top - (CANVAS_MINIMAP_H - map.height) / 2))
    viewport.scrollLeft = Math.max(0, (x / map.scale) * canvasZoom() - viewport.clientWidth / 2)
    viewport.scrollTop = Math.max(0, (y / map.scale) * canvasZoom() - viewport.clientHeight / 2)
    updateCanvasViewportMetrics()
  }

  const onCanvasPanStart = (event: PointerEvent & { currentTarget: HTMLDivElement }) => {
    if (event.button !== 0 && event.button !== 1) return
    const target = event.target
    if (target instanceof HTMLElement) {
      if (target.closest("button,a,input,textarea,select,[contenteditable=true]")) return
    }
    canvasPanState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: event.currentTarget.scrollLeft,
      scrollTop: event.currentTarget.scrollTop,
    }
    setState("canvasPanning", true)
    event.currentTarget.setPointerCapture?.(event.pointerId)
    event.preventDefault()
  }

  const onCanvasPanMove = (event: PointerEvent & { currentTarget: HTMLDivElement }) => {
    const pan = canvasPanState
    if (!pan || pan.pointerId !== event.pointerId) return
    event.currentTarget.scrollLeft = pan.scrollLeft - (event.clientX - pan.startX)
    event.currentTarget.scrollTop = pan.scrollTop - (event.clientY - pan.startY)
    updateCanvasViewportMetrics()
  }

  const onCanvasPanEnd = (event: PointerEvent & { currentTarget: HTMLDivElement }) => {
    const pan = canvasPanState
    if (!pan || pan.pointerId !== event.pointerId) return
    canvasPanState = undefined
    setState("canvasPanning", false)
    event.currentTarget.releasePointerCapture?.(event.pointerId)
  }

  const onGraphKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" && focusNode()) {
      event.preventDefault()
      navigateCodeToNode(focusNode()!)
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      moveFocus(0, -1)
    } else if (event.key === "ArrowDown") {
      event.preventDefault()
      moveFocus(0, 1)
    } else if (event.key === "ArrowLeft") {
      event.preventDefault()
      moveFocus(-1, 0)
    } else if (event.key === "ArrowRight") {
      event.preventDefault()
      moveFocus(1, 0)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div class="h-full min-h-0 overflow-hidden bg-background-base text-text-base">
      <div class="flex h-full min-h-0 flex-col">
        {/* Header */}
        <div class="flex items-center justify-between gap-3 border-b border-border-weaker-base/60 bg-background-base/50 px-4 py-2.5 backdrop-blur-md">
          <div>
            <h2 class="text-13-medium text-text-strong">IntelGraph relations</h2>
            <p class="text-11-regular text-text-weak">
              Indexed symbols only. Click a symbol to open definition; drag the canvas background to pan.
            </p>
          </div>
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="rounded-md border border-border-weaker-base/80 bg-background-base px-2.5 py-1 text-11-medium text-text-weak transition-all hover:bg-surface-base hover:text-text-base hover:shadow-sm active:scale-95"
              onClick={openLogsTab}
              title="Open unified frontend/backend logs in-session"
            >
              Logs
            </button>
            <div
              class="flex items-center overflow-hidden rounded-md border border-border-weaker-base/80 bg-background-base text-11-medium text-text-weak shadow-sm"
              aria-label="IntelGraph canvas zoom controls"
            >
              <button
                type="button"
                class="px-2.5 py-1 transition-colors hover:bg-surface-base hover:text-text-base disabled:opacity-40"
                disabled={!canvasGraph() || canvasZoom() <= CANVAS_MIN_ZOOM}
                onClick={() => setCanvasZoomAroundViewportPoint(canvasZoom() - CANVAS_ZOOM_STEP)}
                title="Zoom out"
              >
                −
              </button>
              <button
                type="button"
                class="min-w-14 border-x border-border-weaker-base/80 px-2.5 py-1 text-center font-medium transition-colors hover:bg-surface-base hover:text-text-base disabled:opacity-40"
                disabled={!canvasGraph()}
                onClick={resetCanvasZoom}
                title="Reset zoom"
              >
                {Math.round(canvasZoom() * 100)}%
              </button>
              <button
                type="button"
                class="px-2.5 py-1 transition-colors hover:bg-surface-base hover:text-text-base disabled:opacity-40"
                disabled={!canvasGraph() || canvasZoom() >= CANVAS_MAX_ZOOM}
                onClick={() => setCanvasZoomAroundViewportPoint(canvasZoom() + CANVAS_ZOOM_STEP)}
                title="Zoom in"
              >
                +
              </button>
              <button
                type="button"
                class="border-l border-border-weaker-base/80 px-2.5 py-1 transition-colors hover:bg-surface-base hover:text-text-base disabled:opacity-40"
                disabled={!canvasGraph()}
                onClick={fitCanvasToViewport}
                title="Fit relation tree to viewport"
              >
                Fit
              </button>
            </div>
            <button
              type="button"
              class="rounded-md border border-border-weaker-base/80 bg-background-base px-2.5 py-1 text-11-medium text-text-weak transition-all hover:bg-surface-base hover:text-text-base hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-50 active:scale-95"
              disabled={!state.lastRelationTarget || isLoading()}
              onClick={refreshSnapshotAndRetry}
              title="Invalidate and rebuild the IntelGraph snapshot, then retry the current relation lookup"
            >
              Refresh snapshot
            </button>
            <Show when={isLoading()}>
              <span class="flex items-center gap-1.5 rounded-md border border-accent/20 bg-accent/5 px-2.5 py-1 text-11-medium text-accent animate-pulse">
                Loading…
              </span>
            </Show>
          </div>
        </div>

        <Switch>
          <Match when={graph.error && !canvasGraph() && !isLoading()}>
            <div
              class="m-4 rounded-xl border border-danger/30 bg-danger/10 p-4 text-12-regular text-danger"
              role="status"
              aria-live="polite"
            >
              <div>{graph.error}</div>
              <div class="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  class="rounded-md border border-danger/40 px-2 py-1 text-11-medium text-danger hover:bg-danger/10"
                  disabled={!state.lastRelationTarget || isLoading()}
                  onClick={refreshSnapshotAndRetry}
                >
                  Refresh snapshot and retry
                </button>
                <button
                  type="button"
                  class="rounded-md border border-border-weaker-base px-2 py-1 text-11-medium text-text-weak hover:border-accent hover:text-accent"
                  onClick={openLogsTab}
                >
                  Open logs
                </button>
              </div>
            </div>
          </Match>
          <Match when={!canvasGraph() && !isLoading()}>
            <div class="m-6 flex flex-col items-center justify-center rounded-xl border border-border-weaker-base/60 bg-surface-base/20 p-8 text-center text-12-regular text-text-weak/90 shadow-sm">
              <span class="mb-2 text-14-medium text-text-strong">No relation graph active</span>
              <p class="max-w-md text-11-regular text-text-weak leading-relaxed">
                Open any source code file, select an indexed symbol definition, and click{" "}
                <span class="rounded bg-surface-base px-1.5 py-0.5 font-medium text-text-strong border border-border-weaker-base/40">
                  Show relation
                </span>{" "}
                to draw its interactive runtime caller graph.
              </p>
            </div>
          </Match>
          <Match when={!canvasGraph() && isLoading()}>
            <div class="p-4 text-12-regular text-text-weak">Loading relation graph…</div>
          </Match>
          <Match when={canvasGraph()}>
            {(graphData) => (
              <main class="relative flex min-h-0 flex-1 overflow-hidden bg-background-base">
                {/* Left: Canvas Area */}
                <div
                  class="min-h-0 flex-1 overflow-auto border-r border-border-weaker-base cursor-grab select-none"
                  classList={{ "cursor-grabbing": state.canvasPanning }}
                  ref={canvasViewportRef}
                  onPointerDown={onCanvasPanStart}
                  onPointerMove={onCanvasPanMove}
                  onPointerUp={onCanvasPanEnd}
                  onPointerCancel={onCanvasPanEnd}
                  onWheel={onCanvasWheel}
                  onScroll={onCanvasScroll}
                  title="Drag the canvas background to pan; Ctrl/Cmd + wheel to zoom"
                >
                  <Show when={graph.error}>
                    <div
                      class="m-3 rounded-lg border border-danger/30 bg-danger/10 p-3 text-12-regular text-danger"
                      role="status"
                      aria-live="polite"
                    >
                      {graph.error}
                    </div>
                  </Show>
                  <Show when={graph.truncationNotice}>
                    <div
                      class="m-3 rounded-lg border border-warning/30 bg-warning/10 p-3 text-12-regular text-text-base"
                      role="status"
                      aria-live="polite"
                    >
                      {graph.truncationNotice}
                    </div>
                  </Show>

                  {/* Canvas */}
                  <div
                    class="relative outline-none"
                    style={{
                      width: `${relationWindowLayout().width * canvasZoom()}px`,
                      height: `${relationWindowLayout().height * canvasZoom()}px`,
                    }}
                    tabIndex={0}
                    onKeyDown={onGraphKeyDown}
                    aria-label={`IntelGraph relation canvas at ${Math.round(canvasZoom() * 100)}% zoom, ${canvasDetailLevel()} detail`}
                    data-detail-level={canvasDetailLevel()}
                  >
                    <div
                      class="absolute left-0 top-0 origin-top-left"
                      style={{
                        width: `${relationWindowLayout().width}px`,
                        height: `${relationWindowLayout().height}px`,
                        transform: `scale(${canvasZoom()})`,
                        "transform-origin": "0 0",
                      }}
                    >
                      {/* SVG edges */}
                      <svg
                        class="absolute inset-0 h-full w-full overflow-visible"
                        viewBox={`0 0 ${relationWindowLayout().width} ${relationWindowLayout().height}`}
                        aria-label="IntelGraph relation edges"
                      >
                        <defs>
                          <marker
                            id="ig-arrow-registration"
                            markerWidth="8"
                            markerHeight="8"
                            refX="7"
                            refY="4"
                            orient="auto"
                          >
                            <path d="M0,0 L8,4 L0,8 Z" fill="#3b82f6" />
                          </marker>
                          <For each={RELATION_EDGE_FAMILY_PALETTE}>
                            {(color, index) => (
                              <marker
                                id={`ig-arrow-family-${index()}`}
                                markerWidth="8"
                                markerHeight="8"
                                refX="7"
                                refY="4"
                                orient="auto"
                              >
                                <path d="M0,0 L8,4 L0,8 Z" fill={color} />
                              </marker>
                            )}
                          </For>
                        </defs>
                        <For each={relationWindowLayout().edges}>
                          {(item) => {
                            const markerId = isRegistrationRelation(item.edge)
                              ? "ig-arrow-registration"
                              : `ig-arrow-family-${item.paletteIndex}`
                            const d = bundledOrthogonalPath(
                              item,
                              relationWindowLayout().nodeHeight,
                              isRegistrationRelation(item.edge),
                            )
                            const midX = (item.src.x + item.src.width / 2 + item.dst.x + item.dst.width / 2) / 2
                            const sourceMidY =
                              item.sources.reduce((total, source) => total + source.y, 0) / item.sources.length +
                              relationWindowLayout().nodeHeight / 2
                            const midY = (sourceMidY + item.dst.y + relationWindowLayout().nodeHeight / 2) / 2
                            return (
                              <g>
                                <path
                                  d={d}
                                  fill="none"
                                  stroke={item.color}
                                  data-edge-family={item.familyKey}
                                  stroke-width={item.edge.direct ? 2 : 1.35}
                                  stroke-dasharray={item.edge.direct ? undefined : "5 5"}
                                  marker-end={`url(#${markerId})`}
                                />
                                <Show when={canvasShowRelationLabels()}>
                                  <text
                                    x={midX}
                                    y={midY - 6}
                                    fill={item.color}
                                    class="text-10-mono select-none font-medium text-text-weak/80 transition-opacity hover:opacity-100"
                                    text-anchor="middle"
                                  >
                                    {relationEdgeLabel(item.edge)}
                                    <Show when={item.edges.length > 1}> ×{item.edges.length}</Show>
                                  </text>
                                </Show>
                              </g>
                            )
                          }}
                        </For>
                      </svg>

                      {/* Node boxes */}
                      <For each={relationWindowLayout().nodes}>
                        {(item) => {
                          const loading = createMemo(() => graph.loadingIds.has(item.node.id))
                          return (
                            <div
                              class="group absolute overflow-visible rounded-lg border-2 border-border-weaker-base bg-background-base shadow-sm transition-all hover:shadow-md hover:border-accent/40"
                              classList={{
                                "z-20 border-accent bg-accent/10 shadow-md": graph.focusId === item.node.id,
                                "z-20 ring-2 ring-accent/30": graph.rootId === item.node.id,
                                "z-10": graph.focusId !== item.node.id && graph.rootId !== item.node.id,
                                "opacity-60": loading(),
                              }}
                              style={{
                                left: `${item.x}px`,
                                top: `${item.y}px`,
                                width: `${item.width}px`,
                                height: `${relationWindowLayout().nodeHeight}px`,
                                "z-index": graph.rootId === item.node.id || graph.focusId === item.node.id ? 40 : 1,
                                "border-color": item.duplicateColor ?? undefined,
                                "box-shadow": item.duplicateColor ? `0 0 0 2px ${item.duplicateColor}33` : undefined,
                              }}
                            >
                              <Show when={item.duplicateCount > 1 && item.duplicateColor}>
                                <div
                                  class="pointer-events-none absolute -right-2 -top-2 z-30 flex h-5 min-w-5 items-center justify-center rounded-full border border-background-base px-1 text-10-mono font-semibold text-background-base shadow-sm"
                                  style={{ "background-color": item.duplicateColor }}
                                  title={`${item.duplicateCount} appearances for ${item.node.id} in the current relation canvas`}
                                >
                                  ×{item.duplicateCount}
                                </div>
                              </Show>

                              <Show when={canvasShowNodeControls()}>
                                {/* Top controls — hover/focus overlay for compact layout */}
                                <div class="absolute left-1 right-1 top-1 z-20 flex items-center justify-between opacity-100">
                                  <button
                                    type="button"
                                    title="Collapse sisters at same level"
                                    aria-label={`Collapse sister relation nodes for ${item.node.id}`}
                                    class="flex h-4 w-4 items-center justify-center rounded-full border border-border-weaker-base bg-surface-base text-10-regular text-text-weak hover:border-accent hover:text-accent"
                                    onClick={(event) => {
                                      event.stopPropagation()
                                      collapseSisters(item.node)
                                    }}
                                  >
                                    ↔
                                  </button>
                                  <button
                                    type="button"
                                    title="Remove this node from canvas"
                                    aria-label={`Delete IntelGraph relation node ${item.node.id}`}
                                    class="flex h-4 w-4 items-center justify-center rounded-full border border-danger/40 bg-danger/10 text-10-regular text-danger hover:bg-danger/20"
                                    onClick={(event) => {
                                      event.stopPropagation()
                                      deleteNode(item.node)
                                    }}
                                  >
                                    ×
                                  </button>
                                </div>
                              </Show>

                              {/* Symbol name — single-line, width adapts by label length */}
                              <button
                                type="button"
                                aria-label={`Open IntelGraph API symbol definition ${item.node.id}`}
                                class="flex h-full min-h-0 w-full cursor-pointer flex-col items-center justify-center px-2 py-1 text-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                                onClick={() => {
                                  intelGraphDebug("node body clicked", {
                                    id: item.node.id,
                                    label: nodeLabel(item.node),
                                  })
                                  navigateCodeToNode(item.node)
                                }}
                                title={
                                  item.duplicateLabel && item.subtitle
                                    ? `${nodeLabel(item.node)} — ${item.subtitle}`
                                    : `Open definition: ${item.node.id}`
                                }
                              >
                                <span
                                  class="max-w-full truncate whitespace-nowrap text-11-medium leading-tight text-text-strong"
                                  title={nodeLabel(item.node)}
                                >
                                  {nodeLabel(item.node)}
                                </span>
                                <Show when={item.duplicateLabel && item.subtitle}>
                                  <span class="sr-only">{item.subtitle}</span>
                                </Show>
                                <Show when={canvasShowNodeSubtitle() && item.subtitle}>
                                  <span class="max-w-full truncate text-10-regular leading-tight text-text-weak">
                                    {item.subtitle}
                                  </span>
                                </Show>
                              </button>

                              <Show when={canvasShowNodeControls()}>
                                {/* Bottom controls — hover/focus overlay; does not affect node height */}
                                <div class="absolute inset-x-1 top-full z-20 mt-1 flex items-center overflow-hidden rounded-md border border-border-weaker-base bg-background-base/95 shadow-sm opacity-100">
                                  <button
                                    type="button"
                                    title="Expand callers (incoming) — one hop on demand"
                                    aria-label={`Expand callers for ${item.node.id}`}
                                    class="min-w-0 flex-1 px-1 py-0.5 text-10-regular text-text-weak hover:bg-surface-base hover:text-text-base"
                                    classList={{ "opacity-50 pointer-events-none": loading() }}
                                    onClick={(event) => {
                                      event.stopPropagation()
                                      expandNode(item.node, "incoming")
                                    }}
                                  >
                                    <span class="truncate">Callers</span>
                                  </button>
                                  <div class="h-full w-px bg-border-weaker-base" />
                                  <button
                                    type="button"
                                    title="Expand callees (outgoing) — one hop on demand"
                                    aria-label={`Expand callees for ${item.node.id}`}
                                    class="min-w-0 flex-1 px-1 py-0.5 text-10-regular text-text-weak hover:bg-surface-base hover:text-text-base"
                                    classList={{ "opacity-50 pointer-events-none": loading() }}
                                    onClick={(event) => {
                                      event.stopPropagation()
                                      expandNode(item.node, "outgoing")
                                    }}
                                  >
                                    <span class="truncate">Callees</span>
                                  </button>
                                  <div class="h-full w-px bg-border-weaker-base" />
                                  <button
                                    type="button"
                                    title="Load more relationships (both directions) — one hop on demand"
                                    aria-label={`Load more relations for ${item.node.id}`}
                                    class="min-w-0 flex-1 px-1 py-0.5 text-10-regular text-text-weak hover:bg-surface-base hover:text-text-base"
                                    classList={{ "opacity-50 pointer-events-none": loading() }}
                                    onClick={(event) => {
                                      event.stopPropagation()
                                      expandNode(item.node, "both")
                                    }}
                                  >
                                    <span class="truncate">More</span>
                                  </button>
                                </div>
                              </Show>
                            </div>
                          )
                        }}
                      </For>
                    </div>
                  </div>
                </div>
                <Show when={canvasGraph()}>
                  <div
                    class="pointer-events-auto absolute left-4 top-4 z-50 rounded-lg border border-border-weaker-base bg-background-base/90 shadow-lg backdrop-blur"
                    title="Canvas overview — red rectangle is current viewport; click to navigate"
                  >
                    <button
                      type="button"
                      class="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-10-mono text-text-weak transition-colors hover:bg-surface-base hover:text-text-base"
                      aria-expanded={!state.canvasOverviewCollapsed}
                      aria-controls="intelgraph-canvas-overview-minimap"
                      onClick={() => setState("canvasOverviewCollapsed", !state.canvasOverviewCollapsed)}
                      title={state.canvasOverviewCollapsed ? "Show Canvas overview" : "Hide Canvas overview"}
                    >
                      <span>Overview</span>
                      <span class="flex items-center gap-1">
                        <span>{Math.round(canvasZoom() * 100)}%</span>
                        <span aria-hidden="true">{state.canvasOverviewCollapsed ? "▸" : "▾"}</span>
                      </span>
                    </button>
                    <Show when={!state.canvasOverviewCollapsed}>
                      <div id="intelgraph-canvas-overview-minimap" class="px-2 pb-2">
                        <svg
                          width={CANVAS_MINIMAP_W}
                          height={CANVAS_MINIMAP_H}
                          viewBox={`0 0 ${CANVAS_MINIMAP_W} ${CANVAS_MINIMAP_H}`}
                          class="cursor-crosshair rounded border border-border-weaker-base bg-surface-base/80"
                          onPointerDown={onMinimapPointerDown}
                          aria-label="IntelGraph canvas minimap"
                        >
                          <g
                            transform={`translate(${(CANVAS_MINIMAP_W - minimapViewport().width) / 2} ${(CANVAS_MINIMAP_H - minimapViewport().height) / 2})`}
                          >
                            <rect
                              width={minimapViewport().width}
                              height={minimapViewport().height}
                              fill="rgba(148,163,184,0.16)"
                              stroke="rgba(148,163,184,0.45)"
                            />
                            <For each={relationWindowLayout().edges}>
                              {(edge) => {
                                const d = bundledOrthogonalPath(
                                  edge,
                                  relationWindowLayout().nodeHeight,
                                  isRegistrationRelation(edge.edge),
                                )
                                return (
                                  <path
                                    d={d}
                                    fill="none"
                                    stroke={edge.color}
                                    stroke-opacity="0.55"
                                    stroke-width={Math.max(1, 1.5 / Math.max(0.1, minimapViewport().scale))}
                                    stroke-dasharray={edge.edge.direct ? undefined : "5 5"}
                                    transform={`scale(${minimapViewport().scale})`}
                                    vector-effect="non-scaling-stroke"
                                  />
                                )
                              }}
                            </For>
                            <For each={relationWindowLayout().nodes}>
                              {(node) => (
                                <circle
                                  cx={(node.x + node.width / 2) * minimapViewport().scale}
                                  cy={(node.y + relationWindowLayout().nodeHeight / 2) * minimapViewport().scale}
                                  r={Math.max(1.5, 3 * minimapViewport().scale)}
                                  fill={node.duplicateColor ?? "rgba(59,130,246,0.85)"}
                                />
                              )}
                            </For>
                            <rect
                              x={minimapViewport().x}
                              y={minimapViewport().y}
                              width={Math.min(minimapViewport().width, minimapViewport().w)}
                              height={Math.min(minimapViewport().height, minimapViewport().h)}
                              fill="rgba(239,68,68,0.12)"
                              stroke="#ef4444"
                              stroke-width="2"
                            />
                          </g>
                        </svg>
                      </div>
                    </Show>
                  </div>
                </Show>
              </main>
            )}
          </Match>
        </Switch>
      </div>
    </div>
  )
}
