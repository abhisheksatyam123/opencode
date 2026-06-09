/**
 * graph-export.ts — pure SQLite → node-link graph reader.
 *
 * This module contains the reusable bit of `buildGraphJson` from
 * src/bin/snapshot-stats.ts: given a raw better-sqlite3 db handle and
 * a snapshot id, build a `GraphJson` document by reading graph_nodes
 * and graph_edges directly. The CLI uses this after running an
 * ephemeral extraction; the `intelligence_graph` transport tool uses it
 * against the live persisted snapshot, so any client (TUI,
 * external script, etc.) can fetch the visualization data without
 * re-extracting.
 *
 * The function is intentionally synchronous and pure: no extraction,
 * no schema, no IO beyond the SELECT statements. Callers own the db
 * connection.
 */

import type BetterSqlite3 from "better-sqlite3"
// GraphJson, GraphJsonFilters, and GraphDiff are pure data shapes defined in
// contracts/graph.ts. Re-exported here for back-compat with existing importers.
export type { GraphJson, GraphJsonFilters, GraphDiff } from "../../contracts/graph.js"
import type { GraphJson, GraphJsonFilters, GraphDiff } from "../../contracts/graph.js"

type NodeRow = {
  canonical_name: string
  kind: string
  location: string | null
  payload: string | null
}

type EdgeRow = {
  src_node_id: string
  dst_node_id: string
  edge_kind: string
  metadata: string | null
}

function parseMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function parseLocation(
  raw: string | null,
): { filePath?: string; line?: number } {
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

/**
 * Read graph_nodes + graph_edges for `snapshotId` and assemble the
 * node-link `GraphJson`. Pure: no IO outside the SELECTs, no side
 * effects on the db. Apply optional filters to subset the result.
 */
export function loadGraphJsonFromDb(
  raw: BetterSqlite3.Database,
  snapshotId: number,
  workspace: string,
  filters: GraphJsonFilters = {},
): GraphJson {
  const nodeRows = raw
    .prepare(
      `SELECT canonical_name, kind, location, payload
       FROM graph_nodes
       WHERE snapshot_id = ?
       ORDER BY canonical_name`,
    )
    .all(snapshotId) as NodeRow[]

  const edgeRows = raw
    .prepare(
      `SELECT src_node_id, dst_node_id, edge_kind, metadata
       FROM graph_edges
       WHERE snapshot_id = ?`,
    )
    .all(snapshotId) as EdgeRow[]

  // Build a node_id → canonical_name lookup so edges can use
  // canonical names (which are stable and human-readable) instead
  // of opaque graph_node IDs.
  const nodeIdLookup = new Map<string, string>()
  const nodeIdRows = raw
    .prepare(
      `SELECT node_id, canonical_name FROM graph_nodes WHERE snapshot_id = ?`,
    )
    .all(snapshotId) as Array<{ node_id: string; canonical_name: string }>
  for (const row of nodeIdRows) {
    nodeIdLookup.set(row.node_id, row.canonical_name)
  }

  const allNodes = nodeRows.map((row) => {
    const loc = parseLocation(row.location)
    const payload = parseMetadata(row.payload) as
      | { metadata?: Record<string, unknown> }
      | null
    const meta = payload?.metadata ?? {}
    return {
      id: row.canonical_name,
      kind: row.kind,
      file_path: loc.filePath ?? null,
      line: typeof loc.line === "number" ? loc.line : null,
      end_line:
        typeof (meta as { endLine?: unknown }).endLine === "number"
          ? Number((meta as { endLine?: number }).endLine)
          : null,
      line_count:
        typeof (meta as { lineCount?: unknown }).lineCount === "number"
          ? Number((meta as { lineCount?: number }).lineCount)
          : null,
      exported: (meta as { exported?: boolean }).exported === true,
      doc: (meta as { doc?: string }).doc ?? null,
      owning_class: (meta as { owningClass?: string }).owningClass ?? null,
    }
  })

  // Symbol-kind filter: drop nodes whose kind isn't in the set, and
  // build a survivor set so the edge filter below can drop edges
  // where either endpoint was filtered out.
  const nodes = filters.symbolKinds
    ? allNodes.filter((n) => filters.symbolKinds!.has(n.kind))
    : allNodes
  const survivingNodeIds = filters.symbolKinds
    ? new Set(nodes.map((n) => n.id))
    : null

  const edges = edgeRows
    .map((row) => {
      const src = nodeIdLookup.get(row.src_node_id)
      const dst = nodeIdLookup.get(row.dst_node_id)
      // Skip edges where src/dst doesn't resolve to a known node
      // (these are usually external/unresolved targets and don't
      // belong in a node-link graph). The visualizer can request
      // them separately via the query intents if needed.
      if (!src || !dst) return null
      // Edge-kind filter: drop edges whose kind isn't in the set
      if (filters.edgeKinds && !filters.edgeKinds.has(row.edge_kind)) {
        return null
      }
      // Symbol-kind filter cascade: drop edges that connect to a
      // node that was filtered out
      if (
        survivingNodeIds &&
        (!survivingNodeIds.has(src) || !survivingNodeIds.has(dst))
      ) {
        return null
      }
      const meta = parseMetadata(row.metadata)
      return {
        src,
        dst,
        kind: row.edge_kind,
        resolution_kind:
          (meta as { resolutionKind?: string } | null)?.resolutionKind ?? null,
        metadata: meta,
      }
    })
    .filter((e): e is NonNullable<typeof e> => e !== null)

  // Capture the pre-filter totals from the raw SELECT row counts
  // (NOT from `nodes` / `edges` after the orphan-edge dedupe and the
  // optional filter cascade). nodeRows.length is the true total of
  // graph_node rows for this snapshot; same for edgeRows.length on
  // graph_edges. Filters below may shrink `nodes` / `edges` but the
  // totals stay anchored to the snapshot.
  const totalNodes = nodeRows.length
  const totalEdges = edgeRows.length

  let result: GraphJson = {
    workspace,
    snapshot_id: snapshotId,
    nodes,
    edges,
    total_nodes: totalNodes,
    total_edges: totalEdges,
  }

  // centerOf is applied AFTER the kind filters so users can combine
  // "module dependency view" with "centered on this symbol" in one
  // call. The function is pure on the GraphJson and is also exported
  // for callers that have a graph in hand (e.g. tests).
  if (filters.centerOf) {
    result = centerSubgraph(
      result,
      filters.centerOf,
      filters.centerHops ?? 2,
      filters.centerDirection ?? "both",
    )
  }
  // dataPath: Phase 3h subgraph reducer. Walks field_of_type +
  // aggregates edges from src type to dst type. Applied after
  // centerOf so callers can scope to a region first, then ask for
  // the data path within it.
  if (filters.dataPathFrom && filters.dataPathTo) {
    result = dataPathSubgraph(
      result,
      filters.dataPathFrom,
      filters.dataPathTo,
      filters.dataPathDepth ?? 6,
    )
  }
  // maxNodes is applied LAST so it caps whatever the prior filters
  // produced. For unfiltered or lightly-filtered runs on big
  // workspaces this is what makes the result tractable for the
  // interactive HTML force layout.
  if (filters.maxNodes !== undefined && filters.maxNodes > 0) {
    result = topNByDegree(result, filters.maxNodes)
  }
  return result
}

/**
 * Reduce a graph to the top N nodes by total degree (incoming +
 * outgoing edges), plus the edges connecting them. Pure function:
 * returns a new GraphJson with the same workspace + snapshot_id.
 *
 * If the graph already has ≤ N nodes, returns it unchanged. If N
 * is non-positive, returns an empty graph.
 */
// GraphDiff moved to contracts/graph.ts — imported and re-exported above.

function edgeKey(src: string, dst: string, kind: string): string {
  return src + "|" + dst + "|" + kind
}

/**
 * Compute the symmetric difference of two graphs at the
 * canonical-name + edge-tuple level. Pure function: no IO, no
 * mutation of either input.
 *
 * Edge identity is the (src, dst, edge_kind) tuple — metadata is
 * intentionally ignored so a metadata-only change doesn't show up
 * as add+remove. Node identity is the canonical_name (the `id`
 * field of GraphJson nodes), which is stable across runs.
 *
 * The arrays of names are capped at 100 entries each so the
 * result stays usable in human-readable output. Counts in
 * `summary` are exact.
 */
export function diffGraphJson(a: GraphJson, b: GraphJson): GraphDiff {
  const aNodeIds = new Set(a.nodes.map((n) => n.id))
  const bNodeIds = new Set(b.nodes.map((n) => n.id))
  const aEdgeKeys = new Set(a.edges.map((e) => edgeKey(e.src, e.dst, e.kind)))
  const bEdgeKeys = new Set(b.edges.map((e) => edgeKey(e.src, e.dst, e.kind)))

  const nodesOnlyA: string[] = []
  const nodesOnlyB: string[] = []
  let nodesBoth = 0
  for (const id of aNodeIds) {
    if (bNodeIds.has(id)) nodesBoth++
    else nodesOnlyA.push(id)
  }
  for (const id of bNodeIds) {
    if (!aNodeIds.has(id)) nodesOnlyB.push(id)
  }

  const edgesOnlyA: string[] = []
  const edgesOnlyB: string[] = []
  let edgesBoth = 0
  for (const key of aEdgeKeys) {
    if (bEdgeKeys.has(key)) edgesBoth++
    else edgesOnlyA.push(key)
  }
  for (const key of bEdgeKeys) {
    if (!aEdgeKeys.has(key)) edgesOnlyB.push(key)
  }

  const SAMPLE_CAP = 100
  return {
    nodes_only_in_a: nodesOnlyA.slice(0, SAMPLE_CAP),
    nodes_only_in_b: nodesOnlyB.slice(0, SAMPLE_CAP),
    nodes_in_both: nodesBoth,
    edges_only_in_a: edgesOnlyA.slice(0, SAMPLE_CAP),
    edges_only_in_b: edgesOnlyB.slice(0, SAMPLE_CAP),
    edges_in_both: edgesBoth,
    summary: {
      a_nodes: a.nodes.length,
      b_nodes: b.nodes.length,
      a_edges: a.edges.length,
      b_edges: b.edges.length,
      nodes_added: nodesOnlyB.length,
      nodes_removed: nodesOnlyA.length,
      edges_added: edgesOnlyB.length,
      edges_removed: edgesOnlyA.length,
    },
  }
}

export function topNByDegree(graph: GraphJson, n: number): GraphJson {
  if (n <= 0) {
    return {
      workspace: graph.workspace,
      snapshot_id: graph.snapshot_id,
      nodes: [],
      edges: [],
      total_nodes: graph.total_nodes,
      total_edges: graph.total_edges,
    }
  }
  if (graph.nodes.length <= n) return graph

  const degree = new Map<string, number>()
  for (const node of graph.nodes) degree.set(node.id, 0)
  for (const edge of graph.edges) {
    degree.set(edge.src, (degree.get(edge.src) ?? 0) + 1)
    degree.set(edge.dst, (degree.get(edge.dst) ?? 0) + 1)
  }
  const ranked = [...degree.entries()].sort((a, b) => b[1] - a[1])
  const keep = new Set(ranked.slice(0, n).map(([id]) => id))
  return {
    workspace: graph.workspace,
    snapshot_id: graph.snapshot_id,
    nodes: graph.nodes.filter((node) => keep.has(node.id)),
    edges: graph.edges.filter(
      (edge) => keep.has(edge.src) && keep.has(edge.dst),
    ),
    total_nodes: graph.total_nodes,
    total_edges: graph.total_edges,
  }
}

/**
 * Resolve a forgiving symbol query to a node id, matching the HTML
 * viewer's resolution strategy: exact → suffix-after-# → substring.
 * Returns null if no node matches.
 *
 * Exported so callers (CLI, transport tool, tests) can do the resolution
 * themselves and report failures cleanly without invoking the full
 * subgraph reduction.
 */
export function resolveCenterSymbol(
  graph: GraphJson,
  query: string,
): string | null {
  if (!query) return null
  const ids = new Set(graph.nodes.map((n) => n.id))
  if (ids.has(query)) return query
  for (const id of ids) {
    if (id.endsWith("#" + query)) return id
  }
  for (const id of ids) {
    if (id.includes(query)) return id
  }
  return null
}

/**
 * Reduce a graph to nodes within `maxHops` BFS steps of a resolved
 * center node, walking edges in the requested direction.
 *
 *   - direction="both" → undirected (successors ∪ predecessors),
 *     "everything related to X"
 *   - direction="out"  → forward only (successors), "what does X
 *     reach"
 *   - direction="in"   → backward only (predecessors), "what
 *     reaches X"
 *
 * Pure function: returns a new GraphJson with the same workspace +
 * snapshot_id and the subset of nodes/edges.
 *
 * If the center query resolves to no node, returns an empty
 * subgraph (no nodes, no edges) — callers can detect this case and
 * report an error.
 */
export function centerSubgraph(
  graph: GraphJson,
  centerQuery: string,
  maxHops: number,
  direction: "in" | "out" | "both" = "both",
): GraphJson {
  const center = resolveCenterSymbol(graph, centerQuery)
  if (!center) {
    return {
      workspace: graph.workspace,
      snapshot_id: graph.snapshot_id,
      nodes: [],
      edges: [],
      total_nodes: graph.total_nodes,
      total_edges: graph.total_edges,
    }
  }
  // Build directed adjacency from the supplied edges. The two
  // direction-aware BFS variants below pick which side(s) to walk.
  const succ = new Map<string, Set<string>>()
  const pred = new Map<string, Set<string>>()
  for (const n of graph.nodes) {
    succ.set(n.id, new Set())
    pred.set(n.id, new Set())
  }
  for (const e of graph.edges) {
    succ.get(e.src)?.add(e.dst)
    pred.get(e.dst)?.add(e.src)
  }
  const walkOut = direction === "out" || direction === "both"
  const walkIn = direction === "in" || direction === "both"
  const seen = new Set<string>([center])
  let frontier: string[] = [center]
  for (let i = 0; i < maxHops; i++) {
    const next: string[] = []
    for (const id of frontier) {
      if (walkOut) {
        const out = succ.get(id)
        if (out) {
          for (const t of out) {
            if (!seen.has(t)) {
              seen.add(t)
              next.push(t)
            }
          }
        }
      }
      if (walkIn) {
        const inn = pred.get(id)
        if (inn) {
          for (const t of inn) {
            if (!seen.has(t)) {
              seen.add(t)
              next.push(t)
            }
          }
        }
      }
    }
    if (next.length === 0) break
    frontier = next
  }
  return {
    workspace: graph.workspace,
    snapshot_id: graph.snapshot_id,
    nodes: graph.nodes.filter((n) => seen.has(n.id)),
    edges: graph.edges.filter((e) => seen.has(e.src) && seen.has(e.dst)),
    total_nodes: graph.total_nodes,
    total_edges: graph.total_edges,
  }
}

/**
 * Phase 3h: data-path subgraph reducer. Walks `field_of_type` and
 * `aggregates` edges from `srcQuery` to `dstQuery`, returning the
 * union of every node/edge that lies on a chain of length ≤
 * `maxDepth`. This is the visualizer-side analog of the
 * `find_data_path` query intent — instead of a flat row list, the
 * caller gets a subgraph they can hand to the d3 force viewer.
 *
 * Both src and dst queries are resolved with the same forgiving
 * exact / suffix-after-# / substring strategy as `centerSubgraph`,
 * so the user can pass a short type name and the function will
 * pick the right canonical id.
 *
 * Algorithm: forward BFS from src restricted to field_of_type +
 * aggregates edges, recording per-hop predecessors. After the BFS
 * settles, walk backwards from dst to reconstruct every reachable
 * predecessor chain and union the visited nodes/edges. Returns the
 * filtered GraphJson preserving the original total_nodes /
 * total_edges so the viewer's "showing X of Y" header still reads
 * sensibly.
 *
 * Returns an empty subgraph (no nodes, no edges) when:
 *   - Either query resolves to no node
 *   - The src and dst exist but no path connects them within
 *     `maxDepth` field_of_type / aggregates hops
 *
 * Pure: no IO, no mutation of the input graph.
 */
export function dataPathSubgraph(
  graph: GraphJson,
  srcQuery: string,
  dstQuery: string,
  maxDepth: number,
): GraphJson {
  const empty = (): GraphJson => ({
    workspace: graph.workspace,
    snapshot_id: graph.snapshot_id,
    nodes: [],
    edges: [],
    total_nodes: graph.total_nodes,
    total_edges: graph.total_edges,
  })

  const src = resolveCenterSymbol(graph, srcQuery)
  const dst = resolveCenterSymbol(graph, dstQuery)
  if (!src || !dst) return empty()
  // Sanity-bound the depth so a malicious input can't blow the BFS
  // up on a deeply-recursive type graph. The find_data_path SQL
  // helper applies the same cap; mirror it here so the viewer and
  // the row API stay aligned.
  const depth = Math.min(Math.max(maxDepth, 1), 20)

  // Build a forward adjacency list restricted to data-path edge
  // kinds. We keep both kinds in the same map because the SQL
  // helper unions them — they encode the same relationship at
  // different granularities, so the BFS naturally picks whichever
  // path is shortest.
  const isDataEdge = (kind: string): boolean =>
    kind === "field_of_type" || kind === "aggregates"
  const succ = new Map<string, Set<string>>()
  for (const node of graph.nodes) succ.set(node.id, new Set())
  for (const edge of graph.edges) {
    if (!isDataEdge(edge.kind)) continue
    succ.get(edge.src)?.add(edge.dst)
  }

  // Forward BFS from src. Track parents as Map<node, Set<parent>>
  // so we can reconstruct *every* shortest chain back from dst.
  // Multiple parents per node lets us union all reachable chains,
  // not just one — useful when there are independent paths between
  // two types.
  const distance = new Map<string, number>()
  const parents = new Map<string, Set<string>>()
  distance.set(src, 0)
  let frontier: string[] = [src]
  for (let hop = 0; hop < depth; hop++) {
    const next: string[] = []
    for (const id of frontier) {
      const out = succ.get(id)
      if (!out) continue
      for (const t of out) {
        if (!distance.has(t)) {
          distance.set(t, hop + 1)
          parents.set(t, new Set([id]))
          next.push(t)
        } else if (distance.get(t) === hop + 1) {
          // Same-distance alternate parent — union into the set so
          // the back-walk recovers both chains.
          parents.get(t)?.add(id)
        }
      }
    }
    if (next.length === 0) break
    frontier = next
  }

  if (!distance.has(dst)) return empty()

  // Backward walk from dst through the parent map. Collect every
  // node/edge that lies on any chain from src → dst. The kept-edge
  // set is keyed by "src|dst" so the final filter pulls every
  // matching edge from the original graph regardless of edge_kind
  // (a single (a,b) endpoint pair can carry both a field_of_type
  // and an aggregates edge — both should render so the user can
  // see the granular field plus the rolled-up aggregation).
  const keptNodes = new Set<string>([dst])
  const keptEdges = new Set<string>()
  const stack: string[] = [dst]
  while (stack.length > 0) {
    const cur = stack.pop()!
    const ps = parents.get(cur)
    if (!ps) continue
    for (const p of ps) {
      keptEdges.add(p + "|" + cur)
      if (!keptNodes.has(p)) {
        keptNodes.add(p)
        stack.push(p)
      }
    }
  }

  return {
    workspace: graph.workspace,
    snapshot_id: graph.snapshot_id,
    nodes: graph.nodes.filter((n) => keptNodes.has(n.id)),
    edges: graph.edges.filter(
      (e) => isDataEdge(e.kind) && keptEdges.has(e.src + "|" + e.dst),
    ),
    total_nodes: graph.total_nodes,
    total_edges: graph.total_edges,
  }
}
