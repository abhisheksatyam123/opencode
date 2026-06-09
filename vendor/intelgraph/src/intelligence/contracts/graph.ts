/**
 * graph.ts — Pure data-shape contracts for the graph export surface.
 *
 * GraphJson, GraphJsonFilters, and GraphDiff are protocol-level types used
 * by DbLookupRepository.loadGraphJson and the intelligence_graph transport tools.
 * They carry no SQLite dependency — the concrete loader (graph-export.ts)
 * imports from here and builds these shapes from raw DB rows.
 */

export interface GraphJson {
  workspace: string
  snapshot_id: number
  nodes: Array<{
    id: string
    kind: string
    file_path: string | null
    line: number | null
    end_line: number | null
    line_count: number | null
    exported: boolean
    doc: string | null
    owning_class: string | null
  }>
  edges: Array<{
    src: string
    dst: string
    kind: string
    resolution_kind: string | null
    metadata: Record<string, unknown> | null
  }>
  /**
   * Total node count in the snapshot BEFORE any filters were applied.
   * When equal to nodes.length the response is unfiltered; when
   * greater, the result was reduced by filters. Renderers show
   * "<visible> of <total>" so users see how much was hidden.
   */
  total_nodes: number
  /** Total edge count BEFORE filters were applied. */
  total_edges: number
}

export interface GraphJsonFilters {
  /** Keep only edges whose edge_kind is in this set. */
  edgeKinds?: Set<string>
  /**
   * Keep only nodes whose kind is in this set, plus only edges
   * where BOTH src and dst survive the node filter.
   */
  symbolKinds?: Set<string>
  /**
   * Scope the graph to nodes within `centerHops` hops of this
   * symbol (resolved by exact / suffix-after-# / substring strategy).
   * Applied AFTER edgeKinds and symbolKinds.
   */
  centerOf?: string
  /** Hop budget for centerOf. Defaults to 2. */
  centerHops?: number
  /**
   * Direction the centerOf BFS walks:
   *   "both" (default): undirected — successors ∪ predecessors.
   *   "out": forward — what does X depend on / reach.
   *   "in": backward — what depends on / reaches X.
   */
  centerDirection?: "in" | "out" | "both"
  /**
   * Cap the result to the top N nodes by total degree (in + out edges),
   * plus edges connecting them. Applied LAST in the filter pipeline.
   */
  maxNodes?: number
  /**
   * Data-path subgraph (Phase 3h). When both endpoints are set, restrict
   * the graph to nodes/edges on a chain of `field_of_type` or `aggregates`
   * edges from `dataPathFrom` to `dataPathTo` within `dataPathDepth` hops.
   * Applied AFTER edgeKinds/symbolKinds/centerOf, BEFORE maxNodes.
   */
  dataPathFrom?: string
  dataPathTo?: string
  /** Hop budget for the data-path BFS (default 6, max 20). */
  dataPathDepth?: number
}

export interface GraphDiff {
  nodes_only_in_a: string[]
  nodes_only_in_b: string[]
  nodes_in_both: number
  edges_only_in_a: string[]
  edges_only_in_b: string[]
  edges_in_both: number
  summary: {
    a_nodes: number
    b_nodes: number
    a_edges: number
    b_edges: number
    nodes_added: number
    nodes_removed: number
    edges_added: number
    edges_removed: number
  }
}
