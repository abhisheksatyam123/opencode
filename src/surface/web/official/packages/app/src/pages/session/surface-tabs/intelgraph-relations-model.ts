import type {
  SurfaceIntelGraphDirection,
  SurfaceIntelGraphEdge,
  SurfaceIntelGraphNode,
  SurfaceIntelGraphRelations,
  SurfaceIntelGraphSearchResult,
  SurfaceIntelGraphV1RelationKind,
  SurfaceIntelGraphV1RelationNode,
  SurfaceIntelGraphV1RelationResult,
} from "@/surface/ports"

export const RELATION_UI_TIMEOUT_MS = 16_000

export type IntelGraphRelationDirection = Exclude<SurfaceIntelGraphDirection, "both">

export type IntelGraphRelationItem = {
  node: SurfaceIntelGraphNode
  relation: SurfaceIntelGraphEdge
}

export type IntelGraphRelationBucket = {
  type: string
  direction: IntelGraphRelationDirection
  items: IntelGraphRelationItem[]
  truncated?: boolean
}

export type IntelGraphNodeRelationRecord = {
  node: SurfaceIntelGraphNode
  relations: IntelGraphRelationBucket[]
}

export type IntelGraphRelationData = {
  symbol: string
  nodes: IntelGraphNodeRelationRecord[]
  diagnostic?: SurfaceIntelGraphRelations["diagnostic"]
}

export type IntelGraphUiLayoutBand = {
  xLevel: number
  yLevel: number
  yBand: readonly [number, number]
  yBandStart: number
  yBandEnd: number
}

export type IntelGraphRelationEdgeStyle = "primary" | "cross-link" | "warning"

export type IntelGraphUiRelationItem = IntelGraphRelationItem & {
  layout: IntelGraphUiLayoutBand & {
    parentNodeId: string
    relationType: string
    edgeStyle: IntelGraphRelationEdgeStyle
  }
}

export type IntelGraphUiRelationBucket = Omit<IntelGraphRelationBucket, "items"> & {
  layout: IntelGraphUiLayoutBand & {
    yCenter: number
    colorKey?: string
  }
  items: IntelGraphUiRelationItem[]
}

export type IntelGraphUiNodeRecord = Omit<IntelGraphNodeRelationRecord, "relations"> & {
  layout: IntelGraphUiLayoutBand
  relations: IntelGraphUiRelationBucket[]
}

export type IntelGraphRelationUiModel = {
  nodes: IntelGraphUiNodeRecord[]
  edges: SurfaceIntelGraphEdge[]
  layout: RelationLayoutScores
}

export type IntelGraphRelationGraphState = {
  nodes: Record<string, SurfaceIntelGraphNode>
  edges: Record<string, SurfaceIntelGraphEdge>
  levels: Record<string, number>
}

export function pruneOrphanIntelGraphRelationState(
  rootId: string,
  state: IntelGraphRelationGraphState,
): IntelGraphRelationGraphState & { orphanIds: string[] } {
  const { nodes, edges, levels } = state
  if (!rootId || !nodes[rootId]) return { nodes, edges, levels, orphanIds: [] }
  const adjacency = new Map<string, Set<string>>()
  for (const id of Object.keys(nodes)) adjacency.set(id, new Set())
  for (const edge of Object.values(edges)) {
    if (!nodes[edge.src] || !nodes[edge.dst]) continue
    adjacency.get(edge.src)?.add(edge.dst)
    adjacency.get(edge.dst)?.add(edge.src)
  }
  const reachable = new Set<string>([rootId])
  const queue = [rootId]
  for (let index = 0; index < queue.length; index++) {
    for (const next of adjacency.get(queue[index]) ?? []) {
      if (reachable.has(next)) continue
      reachable.add(next)
      queue.push(next)
    }
  }
  const orphanIds = Object.keys(nodes).filter((id) => !reachable.has(id))
  if (orphanIds.length === 0) return { nodes, edges, levels, orphanIds }
  return {
    nodes: Object.fromEntries(Object.entries(nodes).filter(([id]) => reachable.has(id))),
    edges: Object.fromEntries(
      Object.entries(edges).filter(([, edge]) => reachable.has(edge.src) && reachable.has(edge.dst)),
    ),
    levels: Object.fromEntries(Object.entries(levels).filter(([id]) => reachable.has(id))),
    orphanIds,
  }
}

export type IntelGraphVisualYNode = {
  visualId: string
  level: number
  yLevel: number
  node: SurfaceIntelGraphNode
}

export function resolveIntelGraphVisualYOverlaps<T extends IntelGraphVisualYNode>(nodes: T[], minRowGap = 1) {
  const byLevel = new Map<number, T[]>()
  for (const node of nodes) byLevel.set(node.level, [...(byLevel.get(node.level) ?? []), node])
  const adjusted = new Map<string, number>()
  for (const [, levelNodes] of byLevel) {
    const ordered = [...levelNodes].sort(
      (a, b) =>
        a.yLevel - b.yLevel ||
        nodeLabel(a.node).localeCompare(nodeLabel(b.node)) ||
        a.visualId.localeCompare(b.visualId),
    )
    let cursor = Number.NEGATIVE_INFINITY
    for (const node of ordered) {
      const nextY = Math.max(node.yLevel, cursor + minRowGap)
      adjusted.set(node.visualId, nextY)
      cursor = nextY
    }
    const originalCenter = ordered.reduce((total, node) => total + node.yLevel, 0) / Math.max(1, ordered.length)
    const adjustedCenter =
      ordered.reduce((total, node) => total + (adjusted.get(node.visualId) ?? node.yLevel), 0) /
      Math.max(1, ordered.length)
    const recenterDelta = adjustedCenter - originalCenter
    for (const node of ordered)
      adjusted.set(node.visualId, (adjusted.get(node.visualId) ?? node.yLevel) - recenterDelta)
  }
  return nodes.map((node) => ({ ...node, yLevel: adjusted.get(node.visualId) ?? node.yLevel }))
}

export function nodeLabel(node: SurfaceIntelGraphNode | SurfaceIntelGraphSearchResult | undefined) {
  if (!node) return ""
  return node.label || node.id.split("@")[0]?.split("/").pop() || node.id
}

export function symbolLocation(symbol: string) {
  const match = symbol.match(/^.*@(.+):(\d+)$/)
  if (!match) return { file: undefined, line: undefined }
  const line = Number(match[2] ?? "")
  return {
    file: (match[1] ?? "").trim() || undefined,
    line: Number.isFinite(line) && line > 0 ? line : undefined,
  }
}

export function nodeDefinitionLocation(node: SurfaceIntelGraphNode | undefined) {
  if (!node) return { file: undefined, line: undefined }
  const inferred = symbolLocation(node.id)
  const lineFromNode = typeof node.line === "number" ? node.line : undefined
  const line = lineFromNode && Number.isFinite(lineFromNode) && lineFromNode > 0 ? lineFromNode : inferred.line
  return {
    file: node.file_path ?? inferred.file,
    line,
  }
}

export function hasDefinitionLocation(node: SurfaceIntelGraphNode | undefined) {
  const location = nodeDefinitionLocation(node)
  return Boolean(location.file && location.line)
}

export function isApiSymbolNode(node: SurfaceIntelGraphNode, rootId: string) {
  if (node.id === rootId) return true
  if (!hasDefinitionLocation(node)) return false
  const kind = (node.kind ?? "").toLowerCase()
  return (
    kind === "" ||
    kind === "function" ||
    kind === "class" ||
    kind === "macro" ||
    kind === "symbol" ||
    kind === "method" ||
    kind === "typedef" ||
    kind === "enum"
  )
}

export function fallbackNode(id: string, kind = "symbol"): SurfaceIntelGraphNode {
  return {
    id,
    label: id.split("@")[0]?.split("#").pop() || id,
    kind,
    file_path: null,
    line: null,
    doc: null,
    source: "derived",
  }
}

function relationTargetLabel(targetId: string, file?: string, line?: number) {
  return file && line ? `${file}:${line}` : file || targetId
}

export function relationMissMessage(data: SurfaceIntelGraphRelations, targetId: string, file?: string, line?: number) {
  const diagnostic = data.diagnostic
  if (diagnostic?.message) return diagnostic.message
  const location = relationTargetLabel(targetId, file, line)
  return `No IntelGraph relationships found for ${location}. Refresh or rebuild the IntelGraph snapshot for this workspace, then retry.`
}

function isAbortLikeError(error: unknown) {
  const value = error && typeof error === "object" ? (error as { name?: unknown; message?: unknown }) : undefined
  const name = typeof value?.name === "string" ? value.name : ""
  const message = typeof value?.message === "string" ? value.message : String(error ?? "")
  return name === "AbortError" || /\babort(?:ed)?\b/i.test(message)
}

export function relationErrorMessage(error: unknown, targetId: string, file?: string, line?: number) {
  const location = relationTargetLabel(targetId, file, line)
  const raw = error instanceof Error ? error.message : String(error)
  const detail = raw && raw !== "undefined" ? raw : "Unknown error"
  if (isAbortLikeError(error))
    return `IntelGraph relation lookup for ${location} was aborted before completion. Retry the lookup or refresh the snapshot if it repeats.`
  if (/timed out/i.test(detail)) {
    const scopedDetail = detail.includes(location) ? detail : `${detail} for ${location}`
    return `${scopedDetail}. Refresh the IntelGraph snapshot and retry if the symbol should be indexed.`
  }
  return `IntelGraph relation lookup failed for ${location}: ${detail}. Refresh the IntelGraph snapshot and retry if the symbol should be indexed.`
}

export function relationLoadingIdsAfterCompletion(loadingIds: Iterable<string>, ids: Array<string | null | undefined>) {
  const next = new Set(loadingIds)
  for (const id of ids) if (id) next.delete(id)
  return next
}

export function relationTimeoutError(targetId: string, timeoutMs = RELATION_UI_TIMEOUT_MS) {
  return new Error(`IntelGraph relation lookup timed out after ${Math.round(timeoutMs / 1000)}s for ${targetId}`)
}

export async function withRelationRequestTimeout<T>(
  request: Promise<T>,
  targetId: string,
  timeoutMs = RELATION_UI_TIMEOUT_MS,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(relationTimeoutError(targetId, timeoutMs)), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export function stableEdgeKey(edge: SurfaceIntelGraphEdge) {
  return edge.id ?? `${edge.src}->${edge.dst}:${edge.kind}:${edge.label ?? ""}:${edge.path_id ?? "direct"}`
}

export type RelationConnectionViewPolicy = {
  /** Root/focus x-level. Renderers must not move the root unexpectedly. */
  rootLevel: number
  /** Prefix for incoming/caller connection sets, keyed by destination/callee id. */
  incomingFamilyPrefix: "incoming-dst"
  /** Prefix for outgoing/callee connection sets, keyed by source/caller id. */
  outgoingFamilyPrefix: "outgoing-src"
  /** Bundle key namespace for rendered relation trunks. */
  bundleKeyPrefix: "relation-edge-bundle"
  /** Same connection set may bundle across x-depth, label, kind, and directness. */
  bundleByConnectionSetAcrossDepth: true
  /** Runtime/session details must never affect colors or bundle identity. */
  deterministicKeysOnly: true
}

/**
 * IntelGraph API connection view policy (DIP boundary + executable spec).
 *
 * High-level rendering code must depend on this model-layer policy through
 * `relationEdgeFamilyKey`, `relationPresentationEdgeGroupKey`, and
 * `relationLayoutScores` instead of re-encoding color/layout rules in JSX.
 * Keeping the contract here makes the specification clear at the code site that
 * enforces it and prevents drift between comments, tests, and rendering.
 *
 * Layout rules:
 * - Root/focus stays at `rootLevel` (0).
 * - For call-like non-registration edges, callers should render to the right of
 *   callees: x(caller) > x(callee). Same-level caller/callee edges are defects
 *   unless they are inside an unavoidable cycle/SCC fallback.
 * - Y order is deterministic and should group related connection sets to reduce
 *   crossings; tie-breaks must be stable across refreshes.
 *
 * Color and bundling rules:
 * - Color by connection set, not by individual caller.
 * - Incoming connection set = destination/callee bucket (`incoming-dst:<dstId>`).
 *   All callers into the same API, even from x-level 1 and x-level 2, share one
 *   color and one bundled trunk/horizontal entry into that API.
 * - Outgoing connection set = source/caller bucket (`outgoing-src:<srcId>`).
 *   All callees from the same source share one color and one bundled trunk.
 * - Registration/callback/handler structure edges are semantic edges; keep them
 *   separate from normal call-like bundles.
 * - Keys must be deterministic: never use session ids, timestamps, array order,
 *   or expansion counters for colors/bundles.
 */
export const RELATION_CONNECTION_VIEW_POLICY = {
  rootLevel: 0,
  incomingFamilyPrefix: "incoming-dst",
  outgoingFamilyPrefix: "outgoing-src",
  bundleKeyPrefix: "relation-edge-bundle",
  bundleByConnectionSetAcrossDepth: true,
  deterministicKeysOnly: true,
} satisfies RelationConnectionViewPolicy

export const RELATION_EDGE_FAMILY_PALETTE = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#14b8a6",
  "#06b6d4",
  "#3b82f6",
  "#6366f1",
  "#8b5cf6",
  "#d946ef",
  "#ec4899",
  "#f43f5e",
  "#84cc16",
  "#10b981",
  "#0ea5e9",
  "#a855f7",
] as const

function stableStringHash(value: string) {
  let hash = 2_166_136_261
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return hash >>> 0
}

export function relationEdgeFamilyPaletteIndex(familyKey: string) {
  return stableStringHash(familyKey || "relation-edge-family") % RELATION_EDGE_FAMILY_PALETTE.length
}

export function relationEdgeFamilyColor(familyKey: string) {
  return RELATION_EDGE_FAMILY_PALETTE[relationEdgeFamilyPaletteIndex(familyKey)]
}

export function isRegistrationRelation(edge: SurfaceIntelGraphEdge) {
  const kind = `${edge.kind} ${edge.label ?? ""} ${edge.resolution_kind ?? ""}`.toLowerCase()
  return (
    kind.includes("api_registrations") ||
    kind.includes("api_deregistrations") ||
    kind.includes("indirect_registered_callers") ||
    kind.includes("registered_by") ||
    kind.includes("registers_callback") ||
    kind.includes("register_callback") ||
    kind.includes("callback") ||
    kind.includes("handler") ||
    kind.includes("ops") ||
    kind.includes("structure")
  )
}

export function isCallLikeRelation(edge: SurfaceIntelGraphEdge) {
  if (isRegistrationRelation(edge)) return false
  const kind = `${edge.kind} ${edge.label ?? ""} ${edge.resolution_kind ?? ""}`.toLowerCase()
  return (
    kind.includes("call") ||
    kind.includes("caller") ||
    kind.includes("callee") ||
    kind.includes("invoke") ||
    kind.includes("invocation")
  )
}

export function relationNodeSortKey(node: SurfaceIntelGraphNode) {
  const location = nodeDefinitionLocation(node)
  return [nodeLabel(node), location.file ?? "", String(location.line ?? 0).padStart(8, "0"), node.id].join("|")
}

/**
 * Connection-set color contract (user-facing readability invariant):
 *
 * - Incoming edges (x+ -> x) are colored by destination bucket: `incoming-dst:<dstId>`.
 *   All callers connected to the same callee/target share one color.
 * - Outgoing edges (x -> x-) are colored by source bucket: `outgoing-src:<srcId>`.
 *   All callees reached from the same caller/source share one color.
 *
 * This intentionally does NOT color by individual caller identity, so root-caller views
 * do not fragment into many colors for the same target set. Keys must remain deterministic
 * across refresh/retry; no session or runtime IDs are allowed.
 */
export function relationEdgeFamilyKey(
  edge: SurfaceIntelGraphEdge,
  levels: Record<string, number | undefined> = {},
  _branchAnchors: Record<string, string | undefined> = {},
) {
  const srcLevel = levels[edge.src] ?? 0
  const dstLevel = levels[edge.dst] ?? 0
  if (edge.direction === "incoming") return `${RELATION_CONNECTION_VIEW_POLICY.incomingFamilyPrefix}:${edge.dst}`
  if (edge.direction === "outgoing") return `${RELATION_CONNECTION_VIEW_POLICY.outgoingFamilyPrefix}:${edge.src}`

  // Direction-less call edges still get connection-set colors. Right-to-root/
  // right-to-right edges are caller/incoming buckets keyed by destination;
  // root/left-to-left edges are callee/outgoing buckets keyed by source.
  if (srcLevel > dstLevel)
    return dstLevel >= 0
      ? `${RELATION_CONNECTION_VIEW_POLICY.incomingFamilyPrefix}:${edge.dst}`
      : `${RELATION_CONNECTION_VIEW_POLICY.outgoingFamilyPrefix}:${edge.src}`
  if (dstLevel > srcLevel)
    return srcLevel <= 0
      ? `${RELATION_CONNECTION_VIEW_POLICY.outgoingFamilyPrefix}:${edge.src}`
      : `${RELATION_CONNECTION_VIEW_POLICY.incomingFamilyPrefix}:${edge.dst}`
  return srcLevel >= 0
    ? `${RELATION_CONNECTION_VIEW_POLICY.incomingFamilyPrefix}:${edge.dst}`
    : `${RELATION_CONNECTION_VIEW_POLICY.outgoingFamilyPrefix}:${edge.src}`
}

/**
 * Presentation bundle contract: non-registration relation edges collapse by the
 * connection-set family only. Incoming callers at different depths, with different
 * labels or directness, still share one trunk when they target the same destination
 * bucket (`incoming-dst:<dst>`). Outgoing callees do the same by source bucket
 * (`outgoing-src:<src>`). Different connection sets must stay separate.
 */
export function relationPresentationEdgeGroupKey(
  edge: SurfaceIntelGraphEdge,
  levels: Record<string, number | undefined>,
  familyKeyOrBranchAnchors?: string | Record<string, string | undefined>,
) {
  const srcLevel = levels[edge.src] ?? 0
  const dstLevel = levels[edge.dst] ?? 0
  if (srcLevel === dstLevel) return null
  const familyKey =
    typeof familyKeyOrBranchAnchors === "string"
      ? familyKeyOrBranchAnchors
      : relationEdgeFamilyKey(edge, levels, familyKeyOrBranchAnchors)
  return [RELATION_CONNECTION_VIEW_POLICY.bundleKeyPrefix, `family:${familyKey}`].join("|")
}

type RelationLayoutScores = {
  levels: Record<string, number>
  yScores: Record<string, number>
  branchAnchors: Record<string, string>
}

function stronglyConnectedRelationComponents(nodeIds: string[], edges: SurfaceIntelGraphEdge[]) {
  let index = 0
  const stack: string[] = []
  const onStack = new Set<string>()
  const indexes = new Map<string, number>()
  const lowlinks = new Map<string, number>()
  const componentById: Record<string, number> = {}
  let componentIndex = 0
  const outgoing = new Map<string, string[]>()

  for (const id of nodeIds) outgoing.set(id, [])
  for (const edge of edges) {
    if (!outgoing.has(edge.src) || !outgoing.has(edge.dst)) continue
    outgoing.get(edge.src)?.push(edge.dst)
  }
  for (const [id, next] of outgoing) next.sort((a, b) => a.localeCompare(b))

  const visit = (id: string) => {
    indexes.set(id, index)
    lowlinks.set(id, index)
    index++
    stack.push(id)
    onStack.add(id)

    for (const next of outgoing.get(id) ?? []) {
      if (!indexes.has(next)) {
        visit(next)
        lowlinks.set(id, Math.min(lowlinks.get(id) ?? 0, lowlinks.get(next) ?? 0))
      } else if (onStack.has(next)) {
        lowlinks.set(id, Math.min(lowlinks.get(id) ?? 0, indexes.get(next) ?? 0))
      }
    }

    if (lowlinks.get(id) !== indexes.get(id)) return
    while (stack.length) {
      const next = stack.pop() as string
      onStack.delete(next)
      componentById[next] = componentIndex
      if (next === id) break
    }
    componentIndex++
  }

  for (const id of [...nodeIds].sort((a, b) => a.localeCompare(b))) if (!indexes.has(id)) visit(id)
  return componentById
}

function relationWeight(edge: SurfaceIntelGraphEdge) {
  const directWeight = edge.direct === false ? 1 : 4
  const callWeight = isCallLikeRelation(edge) ? 3 : 1
  const registrationWeight = isRegistrationRelation(edge) ? 0.35 : 1
  return directWeight * callWeight * registrationWeight
}

function relationBfsDistances(rootId: string, nextIds: (id: string) => string[]) {
  const distances = new Map<string, number>()
  if (!rootId) return distances
  const queue: string[] = [rootId]
  distances.set(rootId, 0)
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const id = queue[cursor]
    const distance = distances.get(id) ?? 0
    for (const next of nextIds(id).sort((a, b) => a.localeCompare(b))) {
      if (distances.has(next)) continue
      distances.set(next, distance + 1)
      queue.push(next)
    }
  }
  return distances
}

function relationRows(orders: Map<number, string[]>) {
  const rows = new Map<string, number>()
  for (const [, ids] of orders) ids.forEach((id, row) => rows.set(id, row))
  return rows
}

function relationBarycenter(
  nodeId: string,
  edges: SurfaceIntelGraphEdge[],
  levels: Record<string, number>,
  rows: Map<string, number>,
  acceptsNeighbor: (neighborLevel: number) => boolean,
) {
  let weightedRow = 0
  let totalWeight = 0
  for (const edge of edges) {
    const neighbor = edge.src === nodeId ? edge.dst : edge.dst === nodeId ? edge.src : undefined
    if (!neighbor) continue
    if (!acceptsNeighbor(levels[neighbor] ?? 0)) continue
    const row = rows.get(neighbor)
    if (row === undefined) continue
    const weight = relationWeight(edge)
    weightedRow += weight * row
    totalWeight += weight
  }
  return totalWeight > 0 ? weightedRow / totalWeight : undefined
}

function computeRelationBranchAnchors(
  nodes: SurfaceIntelGraphNode[],
  edges: SurfaceIntelGraphEdge[],
  levels: Record<string, number>,
  rootId: string,
) {
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const))
  const anchors: Record<string, string> = {}
  if (rootId) anchors[rootId] = rootId
  const ids = [...nodeById.keys()].sort((a, b) => {
    const levelDelta = Math.abs(levels[a] ?? 0) - Math.abs(levels[b] ?? 0)
    if (levelDelta !== 0) return levelDelta
    return relationNodeSortKey(nodeById.get(a) as SurfaceIntelGraphNode).localeCompare(
      relationNodeSortKey(nodeById.get(b) as SurfaceIntelGraphNode),
    )
  })

  for (const id of ids) {
    const level = levels[id] ?? 0
    if (id === rootId || level === 0) {
      anchors[id] = rootId || id
      continue
    }
    if (Math.abs(level) === 1) {
      anchors[id] = id
      continue
    }
    const sign = Math.sign(level)
    const candidates = edges
      .flatMap((edge) => {
        if (edge.src === id) return [edge.dst]
        if (edge.dst === id) return [edge.src]
        return []
      })
      .filter((neighbor) => {
        const neighborLevel = levels[neighbor] ?? 0
        return Math.sign(neighborLevel) === sign && Math.abs(neighborLevel) < Math.abs(level) && anchors[neighbor]
      })
      .map((neighbor) => anchors[neighbor])
    anchors[id] =
      [...new Set(candidates)].sort((a, b) => {
        const nodeA = nodeById.get(a)
        const nodeB = nodeById.get(b)
        const keyA = nodeA ? relationNodeSortKey(nodeA) : a
        const keyB = nodeB ? relationNodeSortKey(nodeB) : b
        return keyA.localeCompare(keyB)
      })[0] ?? id
  }
  return anchors
}

const RELATION_CHILD_ROW_GAP = 1
const RELATION_BUCKET_GAP_ROWS = 1
const RELATION_COMPONENT_GAP_ROWS = 2

type RelationTreeBucket = {
  key: string
  children: string[]
}

function relationParentChild(
  edge: SurfaceIntelGraphEdge,
  levels: Record<string, number>,
  nodeIds: Set<string>,
  rootId: string,
) {
  if (!nodeIds.has(edge.src) || !nodeIds.has(edge.dst) || edge.src === edge.dst) return undefined
  if (edge.direction === "incoming") return { parent: edge.dst, child: edge.src }
  if (edge.direction === "outgoing") return { parent: edge.src, child: edge.dst }
  const srcLevel = levels[edge.src] ?? 0
  const dstLevel = levels[edge.dst] ?? 0
  if (edge.src === rootId) return { parent: edge.src, child: edge.dst }
  if (edge.dst === rootId) return { parent: edge.dst, child: edge.src }
  return Math.abs(srcLevel) <= Math.abs(dstLevel)
    ? { parent: edge.src, child: edge.dst }
    : { parent: edge.dst, child: edge.src }
}

function relationBucketKey(edge: SurfaceIntelGraphEdge) {
  return `${edge.direction ?? "both"}:${edge.kind}`
}

function relationParentChildBuckets(
  edges: SurfaceIntelGraphEdge[],
  levels: Record<string, number>,
  nodeIds: Set<string>,
  rootId: string,
) {
  const bucketsByParent = new Map<string, Map<string, Set<string>>>()
  for (const edge of edges) {
    const relation = relationParentChild(edge, levels, nodeIds, rootId)
    if (!relation) continue
    const bucketKey = relationBucketKey(edge)
    let buckets = bucketsByParent.get(relation.parent)
    if (!buckets) {
      buckets = new Map()
      bucketsByParent.set(relation.parent, buckets)
    }
    let children = buckets.get(bucketKey)
    if (!children) {
      children = new Set()
      buckets.set(bucketKey, children)
    }
    children.add(relation.child)
  }
  return bucketsByParent
}

function relationOrderedTreeBuckets(
  parentId: string,
  bucketsByParent: Map<string, Map<string, Set<string>>>,
  nodeById: Map<string, SurfaceIntelGraphNode>,
  rowById: Map<string, number>,
): RelationTreeBucket[] {
  const buckets = bucketsByParent.get(parentId)
  if (!buckets) return []
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, values]) => ({
      key,
      children: [...values].sort((a, b) => {
        const rowDelta = (rowById.get(a) ?? 0) - (rowById.get(b) ?? 0)
        if (rowDelta !== 0) return rowDelta
        const nodeA = nodeById.get(a)
        const nodeB = nodeById.get(b)
        const keyA = nodeA ? relationNodeSortKey(nodeA) : a
        const keyB = nodeB ? relationNodeSortKey(nodeB) : b
        return keyA.localeCompare(keyB)
      }),
    }))
    .filter((bucket) => bucket.children.length > 0)
}

function relationParentDrivenYScores(
  nodes: SurfaceIntelGraphNode[],
  edges: SurfaceIntelGraphEdge[],
  levels: Record<string, number>,
  orders: Map<number, string[]>,
  rootId: string,
) {
  const nodeIds = new Set(nodes.map((node) => node.id))
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const))
  const rowById = new Map<string, number>()
  for (const [, ids] of orders) ids.forEach((id, row) => rowById.set(id, row))
  const bucketsByParent = relationParentChildBuckets(edges, levels, nodeIds, rootId)
  const measuring = new Set<string>()
  const measured = new Map<string, number>()

  const measure = (id: string): number => {
    const cached = measured.get(id)
    if (cached !== undefined) return cached
    if (measuring.has(id)) return 1
    measuring.add(id)
    const buckets = relationOrderedTreeBuckets(id, bucketsByParent, nodeById, rowById)
    const rows = buckets.length
      ? buckets.reduce((total, bucket, bucketIndex) => {
          const childRows = bucket.children.reduce((sum, child, childIndex) => {
            return sum + measure(child) + (childIndex > 0 ? RELATION_CHILD_ROW_GAP : 0)
          }, 0)
          return total + Math.max(1, childRows) + (bucketIndex > 0 ? RELATION_BUCKET_GAP_ROWS : 0)
        }, 0)
      : 1
    measuring.delete(id)
    const height = Math.max(1, rows)
    measured.set(id, height)
    return height
  }

  const yScores: Record<string, number> = {}
  const assigned = new Set<string>()
  const assigning = new Set<string>()

  const assign = (id: string, startY: number) => {
    if (!nodeIds.has(id) || assigned.has(id) || assigning.has(id)) return { start: startY, end: startY }
    assigning.add(id)
    const height = measure(id)
    const endY = startY + height - 1
    const centerY = (startY + endY) / 2
    yScores[id] = centerY
    assigned.add(id)

    let cursor = startY
    const buckets = relationOrderedTreeBuckets(id, bucketsByParent, nodeById, rowById)
    for (const [bucketIndex, bucket] of buckets.entries()) {
      if (bucketIndex > 0) cursor += RELATION_BUCKET_GAP_ROWS
      for (const [childIndex, child] of bucket.children.entries()) {
        if (childIndex > 0) cursor += RELATION_CHILD_ROW_GAP
        const childHeight = measure(child)
        assign(child, cursor)
        cursor += childHeight
      }
    }
    assigning.delete(id)
    return { start: startY, end: endY }
  }

  let cursorY = 0
  if (rootId && nodeIds.has(rootId)) {
    const rootHeight = measure(rootId)
    assign(rootId, -(rootHeight - 1) / 2)
    cursorY = rootHeight / 2 + RELATION_COMPONENT_GAP_ROWS
  }

  const orderedIds = [...nodes]
    .sort((a, b) => {
      const levelDelta = (levels[a.id] ?? 0) - (levels[b.id] ?? 0)
      if (levelDelta !== 0) return levelDelta
      const rowDelta = (rowById.get(a.id) ?? 0) - (rowById.get(b.id) ?? 0)
      if (rowDelta !== 0) return rowDelta
      return relationNodeSortKey(a).localeCompare(relationNodeSortKey(b))
    })
    .map((node) => node.id)

  for (const id of orderedIds) {
    if (assigned.has(id)) continue
    const height = measure(id)
    assign(id, cursorY)
    cursorY += height + RELATION_COMPONENT_GAP_ROWS
  }

  return yScores
}

export function relationLayoutScores(
  nodes: SurfaceIntelGraphNode[],
  edges: SurfaceIntelGraphEdge[],
  baseLevels: Record<string, number | undefined>,
  rootId: string,
): RelationLayoutScores {
  const sortedNodes = [...nodes].sort((a, b) => relationNodeSortKey(a).localeCompare(relationNodeSortKey(b)))
  const nodeIds = sortedNodes.map((node) => node.id)
  const nodeIdSet = new Set(nodeIds)
  const callEdges = edges
    .filter((edge) => nodeIdSet.has(edge.src) && nodeIdSet.has(edge.dst) && isCallLikeRelation(edge))
    .sort((a, b) => stableEdgeKey(a).localeCompare(stableEdgeKey(b)))
  const outgoing = new Map<string, string[]>()
  const incoming = new Map<string, string[]>()
  for (const id of nodeIds) {
    outgoing.set(id, [])
    incoming.set(id, [])
  }
  for (const edge of callEdges) {
    outgoing.get(edge.src)?.push(edge.dst)
    incoming.get(edge.dst)?.push(edge.src)
  }

  const callerDistances = relationBfsDistances(rootId, (id) => incoming.get(id) ?? [])
  const calleeDistances = relationBfsDistances(rootId, (id) => outgoing.get(id) ?? [])
  const levels: Record<string, number> = {}
  for (const node of sortedNodes) {
    if (node.id === rootId) {
      levels[node.id] = RELATION_CONNECTION_VIEW_POLICY.rootLevel
      continue
    }
    const baseLevel = baseLevels[node.id] ?? 0
    const callerDistance = callerDistances.get(node.id)
    const calleeDistance = calleeDistances.get(node.id)
    if (callerDistance !== undefined && calleeDistance !== undefined) {
      if (baseLevel > 0) levels[node.id] = Math.max(baseLevel, callerDistance)
      else if (baseLevel < 0) levels[node.id] = Math.min(baseLevel, -calleeDistance)
      else if (callerDistance < calleeDistance) levels[node.id] = callerDistance
      else if (calleeDistance < callerDistance) levels[node.id] = -calleeDistance
      else levels[node.id] = node.id.localeCompare(rootId) <= 0 ? callerDistance : -calleeDistance
    } else if (callerDistance !== undefined) levels[node.id] = Math.max(baseLevel, callerDistance)
    else if (calleeDistance !== undefined) levels[node.id] = Math.min(baseLevel, -calleeDistance)
    else levels[node.id] = baseLevel
  }
  if (rootId && nodeIdSet.has(rootId)) levels[rootId] = RELATION_CONNECTION_VIEW_POLICY.rootLevel

  const components = stronglyConnectedRelationComponents(nodeIds, callEdges)
  for (let pass = 0; pass < Math.max(1, nodeIds.length); pass++) {
    let changed = false
    for (const edge of callEdges) {
      if (components[edge.src] === components[edge.dst]) continue
      const srcLevel = levels[edge.src] ?? 0
      const dstLevel = levels[edge.dst] ?? 0
      if (srcLevel > dstLevel) continue
      if (edge.src === rootId) levels[edge.dst] = srcLevel - 1
      else levels[edge.src] = dstLevel + 1
      if (rootId && nodeIdSet.has(rootId)) levels[rootId] = RELATION_CONNECTION_VIEW_POLICY.rootLevel
      changed = true
    }
    if (!changed) break
  }

  const branchAnchors = computeRelationBranchAnchors(sortedNodes, edges, levels, rootId)
  const weightedDegree = new Map<string, number>()
  for (const id of nodeIds) weightedDegree.set(id, 0)
  for (const edge of edges) {
    const weight = relationWeight(edge)
    weightedDegree.set(edge.src, (weightedDegree.get(edge.src) ?? 0) + weight)
    weightedDegree.set(edge.dst, (weightedDegree.get(edge.dst) ?? 0) + weight)
  }

  const idsByLevel = new Map<number, string[]>()
  for (const node of sortedNodes) {
    const level = levels[node.id] ?? 0
    idsByLevel.set(level, [...(idsByLevel.get(level) ?? []), node.id])
  }
  const nodeById = new Map(sortedNodes.map((node) => [node.id, node] as const))
  const orderedLevels = [...idsByLevel.keys()].sort((a, b) => a - b)
  const orders = new Map<number, string[]>()
  for (const level of orderedLevels) {
    const ids = [...(idsByLevel.get(level) ?? [])].sort((a, b) => {
      if (a === rootId) return -1
      if (b === rootId) return 1
      const anchorA = nodeById.get(branchAnchors[a] ?? "")
      const anchorB = nodeById.get(branchAnchors[b] ?? "")
      const anchorKeyA = anchorA ? relationNodeSortKey(anchorA) : (branchAnchors[a] ?? a)
      const anchorKeyB = anchorB ? relationNodeSortKey(anchorB) : (branchAnchors[b] ?? b)
      const anchorDelta = anchorKeyA.localeCompare(anchorKeyB)
      if (anchorDelta !== 0) return anchorDelta
      const degreeDelta = (weightedDegree.get(b) ?? 0) - (weightedDegree.get(a) ?? 0)
      if (degreeDelta !== 0) return degreeDelta
      return relationNodeSortKey(nodeById.get(a) as SurfaceIntelGraphNode).localeCompare(
        relationNodeSortKey(nodeById.get(b) as SurfaceIntelGraphNode),
      )
    })
    orders.set(level, ids)
  }

  for (let sweep = 0; sweep < 3; sweep++) {
    let rows = relationRows(orders)
    for (const level of orderedLevels) {
      const previousRow = new Map((orders.get(level) ?? []).map((id, row) => [id, row] as const))
      orders.set(
        level,
        [...(orders.get(level) ?? [])].sort((a, b) => {
          if (a === rootId) return -1
          if (b === rootId) return 1
          const baryA = relationBarycenter(a, edges, levels, rows, (neighborLevel) => neighborLevel < level)
          const baryB = relationBarycenter(b, edges, levels, rows, (neighborLevel) => neighborLevel < level)
          if (baryA !== undefined || baryB !== undefined) {
            if (baryA === undefined) return 1
            if (baryB === undefined) return -1
            const delta = baryA - baryB
            if (Math.abs(delta) > 1e-9) return delta
          }
          const previousDelta = (previousRow.get(a) ?? 0) - (previousRow.get(b) ?? 0)
          if (previousDelta !== 0) return previousDelta
          return relationNodeSortKey(nodeById.get(a) as SurfaceIntelGraphNode).localeCompare(
            relationNodeSortKey(nodeById.get(b) as SurfaceIntelGraphNode),
          )
        }),
      )
      rows = relationRows(orders)
    }

    rows = relationRows(orders)
    for (const level of [...orderedLevels].reverse()) {
      const previousRow = new Map((orders.get(level) ?? []).map((id, row) => [id, row] as const))
      orders.set(
        level,
        [...(orders.get(level) ?? [])].sort((a, b) => {
          if (a === rootId) return -1
          if (b === rootId) return 1
          const baryA = relationBarycenter(a, edges, levels, rows, (neighborLevel) => neighborLevel > level)
          const baryB = relationBarycenter(b, edges, levels, rows, (neighborLevel) => neighborLevel > level)
          if (baryA !== undefined || baryB !== undefined) {
            if (baryA === undefined) return 1
            if (baryB === undefined) return -1
            const delta = baryA - baryB
            if (Math.abs(delta) > 1e-9) return delta
          }
          const previousDelta = (previousRow.get(a) ?? 0) - (previousRow.get(b) ?? 0)
          if (previousDelta !== 0) return previousDelta
          return relationNodeSortKey(nodeById.get(a) as SurfaceIntelGraphNode).localeCompare(
            relationNodeSortKey(nodeById.get(b) as SurfaceIntelGraphNode),
          )
        }),
      )
      rows = relationRows(orders)
    }
  }

  const yScores = relationParentDrivenYScores(sortedNodes, edges, levels, orders, rootId)
  return { levels, yScores, branchAnchors }
}

function relationNodeSourceMap(data: SurfaceIntelGraphRelations) {
  const sourceNodes = new Map<string, SurfaceIntelGraphNode>()
  const registerNode = (node: SurfaceIntelGraphNode | null | undefined) => {
    if (!node?.id) return
    sourceNodes.set(node.id, { ...node, source: node.source ?? "indexed" })
  }
  registerNode(data.node)
  for (const node of data.nodes ?? []) registerNode(node)
  return sourceNodes
}

function relationItemNodeId(edge: SurfaceIntelGraphEdge, ownerId: string, direction: IntelGraphRelationDirection) {
  if (edge.src === ownerId && edge.dst !== ownerId) return edge.dst
  if (edge.dst === ownerId && edge.src !== ownerId) return edge.src
  return direction === "incoming" ? edge.src : edge.dst
}

function relationFallbackNode(sourceNodes: Map<string, SurfaceIntelGraphNode>, id: string, kind = "symbol") {
  return sourceNodes.get(id) ?? fallbackNode(id, kind)
}

function relationLayoutBand(
  xLevel: number,
  yLevel: number,
  yBandStart = yLevel,
  yBandEnd = yLevel,
): IntelGraphUiLayoutBand {
  return { xLevel, yLevel, yBand: [yBandStart, yBandEnd], yBandStart, yBandEnd }
}

function relationEdgeStyle(edge: SurfaceIntelGraphEdge, levels: Record<string, number>) {
  const srcLevel = levels[edge.src] ?? 0
  const dstLevel = levels[edge.dst] ?? 0
  if (srcLevel === dstLevel) return "warning"
  return edge.direct === false ? "cross-link" : "primary"
}

function flattenIntelGraphRelationData(
  data: IntelGraphRelationData,
  direction: SurfaceIntelGraphDirection,
  options: { includeIndirect?: boolean } = {},
) {
  const nodes: SurfaceIntelGraphNode[] = []
  const edges: SurfaceIntelGraphEdge[] = []
  const semanticNodes = new Map<string, SurfaceIntelGraphNode>()
  for (const record of data.nodes) {
    if (record.node.id) semanticNodes.set(record.node.id, record.node)
    for (const bucket of record.relations) {
      for (const item of bucket.items) if (item.node.id) semanticNodes.set(item.node.id, item.node)
    }
  }
  const pushNode = (node: SurfaceIntelGraphNode | null | undefined) => {
    if (!node?.id) return
    const existingIndex = nodes.findIndex((existing) => existing.id === node.id)
    if (existingIndex < 0) {
      nodes.push(node)
      return
    }
    if (nodes[existingIndex]?.source === "derived" && node.source !== "derived") nodes[existingIndex] = node
  }
  const pushNodeById = (id: string, kind = "symbol") => pushNode(semanticNodes.get(id) ?? fallbackNode(id, kind))
  const pushRelation = (relation: SurfaceIntelGraphEdge, itemNode: SurfaceIntelGraphNode) => {
    if (options.includeIndirect === false && relation.direct === false) return
    if (direction !== "both" && relation.direction && relation.direction !== direction) return
    edges.push(relation)
    pushNode(itemNode)
    pushNodeById(relation.src)
    pushNodeById(relation.dst)
  }

  for (const record of data.nodes) {
    pushNode(record.node)
    for (const bucket of record.relations) {
      if (direction !== "both" && bucket.direction !== direction) continue
      for (const item of bucket.items) pushRelation(item.relation, item.node)
    }
  }
  return { nodes, edges }
}

/**
 * Adapter boundary from the current backend payload (`node`, raw `nodes`, `groups`)
 * to the approved simple UI model (`nodes[] -> relations[] -> items[]`).
 * The adapter keeps backend semantic nodes untouched; UI layout is added later on
 * wrapper records by `buildIntelGraphRelationUiModel`.
 */
function nodeFromV1(node: SurfaceIntelGraphV1RelationNode): SurfaceIntelGraphNode {
  return {
    id: node.id,
    label: node.label ?? node.symbol,
    kind: node.kind,
    file_path: node.file ?? null,
    line: node.line ?? null,
    doc: null,
    source: "derived",
  }
}

function relationDirectionFromV1(kind: SurfaceIntelGraphV1RelationKind): IntelGraphRelationDirection {
  return kind === "api_registrations" || kind === "api_deregistrations" ? "outgoing" : "incoming"
}

function relationEdgeFromV1(
  parent: SurfaceIntelGraphV1RelationNode,
  related: SurfaceIntelGraphV1RelationNode,
  kind: SurfaceIntelGraphV1RelationKind,
): SurfaceIntelGraphEdge {
  const direction = relationDirectionFromV1(kind)
  const evidence = related.via?.[0]
  return {
    id: `${parent.id}->${related.id}:${kind}`,
    src: direction === "incoming" ? related.id : parent.id,
    dst: direction === "incoming" ? parent.id : related.id,
    kind,
    label: evidence?.detail ?? kind,
    direction,
    direct: kind !== "indirect_registered_callers",
    metadata: related.via?.length ? { evidence: related.via } : null,
  }
}

export function adaptV1RelationResult(data: SurfaceIntelGraphV1RelationResult): IntelGraphRelationData {
  const relationRecord: IntelGraphNodeRelationRecord = { node: nodeFromV1(data.root), relations: [] }
  for (const [kind, relatedNodes] of Object.entries(data.root.relations) as Array<
    [SurfaceIntelGraphV1RelationKind, SurfaceIntelGraphV1RelationNode[] | undefined]
  >) {
    if (!relatedNodes?.length) continue
    relationRecord.relations.push({
      type: kind,
      direction: relationDirectionFromV1(kind),
      items: relatedNodes.map((related) => ({
        node: nodeFromV1(related),
        relation: relationEdgeFromV1(data.root, related, kind),
      })),
    })
  }
  return {
    symbol: data.root.symbol,
    nodes: [relationRecord],
    diagnostic: data.diagnostics?.[0],
  }
}

export function adaptSurfaceIntelGraphRelations(
  data: SurfaceIntelGraphRelations,
  targetId = data.node?.id || data.symbol,
): IntelGraphRelationData {
  if (data.relationData) return data.relationData
  const sourceNodes = relationNodeSourceMap(data)
  const ownerId = data.node?.id || targetId
  const ownerNode = relationFallbackNode(sourceNodes, ownerId, "root")
  const relationRecord: IntelGraphNodeRelationRecord = { node: ownerNode, relations: [] }

  for (const group of data.groups ?? []) {
    const direction = group.direction as IntelGraphRelationDirection
    const bucket: IntelGraphRelationBucket = {
      type: group.kind,
      direction,
      items: [],
    }
    for (const edge of group.direct ?? []) {
      const relation = { ...edge, direct: true, direction }
      const nodeId = relationItemNodeId(relation, ownerNode.id, direction)
      bucket.items.push({ node: relationFallbackNode(sourceNodes, nodeId), relation })
    }
    for (const path of group.indirect ?? []) {
      for (const id of path.nodes ?? []) if (!sourceNodes.has(id)) sourceNodes.set(id, fallbackNode(id))
      for (const edge of path.edges ?? []) {
        if (!sourceNodes.has(edge.src)) sourceNodes.set(edge.src, fallbackNode(edge.src))
        if (!sourceNodes.has(edge.dst)) sourceNodes.set(edge.dst, fallbackNode(edge.dst))
        const relation = { ...edge, direct: false, direction, path_id: path.id, depth: path.depth }
        const nodeId = relationItemNodeId(relation, ownerNode.id, direction)
        bucket.items.push({ node: relationFallbackNode(sourceNodes, nodeId), relation })
      }
    }
    relationRecord.relations.push(bucket)
  }

  return {
    symbol: data.symbol,
    nodes: [relationRecord],
    diagnostic: data.diagnostic,
  }
}

export function buildIntelGraphRelationUiModel(
  data: SurfaceIntelGraphRelations,
  targetId: string,
  direction: SurfaceIntelGraphDirection,
  options: {
    includeIndirect?: boolean
    baseLevels?: Record<string, number | undefined>
    rootId?: string
  } = {},
): IntelGraphRelationUiModel {
  const relationData = adaptSurfaceIntelGraphRelations(data, targetId)
  const graph = flattenIntelGraphRelationData(relationData, direction, { includeIndirect: options.includeIndirect })
  const rootId = options.rootId || relationData.nodes[0]?.node.id || targetId
  const layout = relationLayoutScores(graph.nodes, graph.edges, options.baseLevels ?? {}, rootId)
  const uiNodes = relationData.nodes.map((record): IntelGraphUiNodeRecord => {
    const nodeLevel = layout.levels[record.node.id] ?? options.baseLevels?.[record.node.id] ?? 0
    const nodeY = layout.yScores[record.node.id] ?? 0
    const relations = record.relations
      .filter((bucket) => direction === "both" || bucket.direction === direction)
      .map((bucket): IntelGraphUiRelationBucket => {
        const items = bucket.items
          .filter((item) => options.includeIndirect !== false || item.relation.direct !== false)
          .map((item): IntelGraphUiRelationItem => {
            const itemLevel = layout.levels[item.node.id] ?? options.baseLevels?.[item.node.id] ?? 0
            const itemY = layout.yScores[item.node.id] ?? nodeY
            return {
              ...item,
              layout: {
                ...relationLayoutBand(itemLevel, itemY),
                parentNodeId: record.node.id,
                relationType: bucket.type,
                edgeStyle: relationEdgeStyle(item.relation, layout.levels),
              },
            }
          })
        const yValues = items.length > 0 ? items.map((item) => item.layout.yLevel) : [nodeY]
        const yBandStart = Math.min(...yValues)
        const yBandEnd = Math.max(...yValues)
        const yCenter = (yBandStart + yBandEnd) / 2
        const firstRelation = items[0]?.relation
        const colorKey = firstRelation
          ? relationEdgeFamilyKey(firstRelation, layout.levels, layout.branchAnchors)
          : undefined
        return {
          type: bucket.type,
          direction: bucket.direction,
          truncated: bucket.truncated,
          items,
          layout: {
            ...relationLayoutBand(nodeLevel, yCenter, yBandStart, yBandEnd),
            yCenter,
            colorKey,
          },
        }
      })
    const bandValues = [nodeY, ...relations.flatMap((bucket) => [bucket.layout.yBandStart, bucket.layout.yBandEnd])]
    const yBandStart = Math.min(...bandValues)
    const yBandEnd = Math.max(...bandValues)
    return {
      node: record.node,
      relations,
      layout: relationLayoutBand(nodeLevel, nodeY, yBandStart, yBandEnd),
    }
  })
  return { nodes: uiNodes, edges: graph.edges, layout }
}

export function rebaseSurfaceIntelGraphRelationsRoot(
  data: SurfaceIntelGraphRelations,
  visibleRootId: string,
): SurfaceIntelGraphRelations {
  const relationData = data.relationData
  const semanticRootId = relationData?.nodes[0]?.node.id || data.node?.id
  if (!visibleRootId || !semanticRootId || semanticRootId === visibleRootId) return data

  const rebaseEdge = (edge: SurfaceIntelGraphEdge): SurfaceIntelGraphEdge => {
    const next = {
      ...edge,
      src: edge.src === semanticRootId ? visibleRootId : edge.src,
      dst: edge.dst === semanticRootId ? visibleRootId : edge.dst,
    }
    return { ...next, id: `${next.src}->${next.dst}:${next.kind}` }
  }
  const rebaseNode = (node: SurfaceIntelGraphNode): SurfaceIntelGraphNode =>
    node.id === semanticRootId ? { ...node, id: visibleRootId } : node

  return {
    ...data,
    node: data.node ? rebaseNode(data.node) : data.node,
    nodes: data.nodes?.map(rebaseNode) ?? data.nodes,
    groups: data.groups?.map((group) => ({
      ...group,
      direct: group.direct?.map(rebaseEdge),
      indirect: group.indirect?.map((path) => ({
        ...path,
        nodes: path.nodes?.map((id) => (id === semanticRootId ? visibleRootId : id)),
        edges: path.edges?.map(rebaseEdge),
      })),
    })),
    relationData: relationData
      ? {
          ...relationData,
          nodes: relationData.nodes.map((record, index) => ({
            ...record,
            node: index === 0 ? { ...record.node, id: visibleRootId } : rebaseNode(record.node),
            relations: record.relations.map((bucket) => ({
              ...bucket,
              items: bucket.items.map((item) => ({
                ...item,
                node: rebaseNode(item.node),
                relation: rebaseEdge(item.relation),
              })),
            })),
          })),
        }
      : relationData,
  }
}

export function flattenRelations(
  data: SurfaceIntelGraphRelations,
  targetId: string,
  direction: SurfaceIntelGraphDirection,
  options: { includeIndirect?: boolean } = {},
) {
  const relationData = adaptSurfaceIntelGraphRelations(data, targetId)
  const graph = flattenIntelGraphRelationData(relationData, direction, options)
  const hasTarget = graph.nodes.some((node) => node.id === targetId)
  if (!hasTarget) graph.nodes.push(fallbackNode(targetId, "root"))
  return graph
}

export function edgeImpliedLevel(
  edge: SurfaceIntelGraphEdge,
  id: string,
  targetId: string,
  targetLevel: number,
  direction: SurfaceIntelGraphDirection,
) {
  if (id === targetId) return targetLevel
  if (direction === "incoming") return targetLevel + 1
  if (direction === "outgoing") return targetLevel - 1
  if (edge.dst === targetId && edge.src === id) return targetLevel + 1
  if (edge.src === targetId && edge.dst === id) return targetLevel - 1
  if (edge.direction === "incoming") return targetLevel + 1
  if (edge.direction === "outgoing") return targetLevel - 1
  return targetLevel
}

export function mergedRelationLevel(
  edge: SurfaceIntelGraphEdge,
  id: string,
  targetId: string,
  targetLevel: number,
  direction: SurfaceIntelGraphDirection,
  currentLevel?: number,
  rootId?: string,
) {
  if (rootId && id === rootId) return 0
  if (id === targetId) return targetLevel

  const impliedLevel = edgeImpliedLevel(edge, id, targetId, targetLevel, direction)
  if (currentLevel === undefined) return impliedLevel

  if (impliedLevel > targetLevel) return Math.max(currentLevel, impliedLevel)
  if (impliedLevel < targetLevel) return Math.min(currentLevel, impliedLevel)
  return currentLevel
}
