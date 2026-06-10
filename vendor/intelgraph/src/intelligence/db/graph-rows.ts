import type {
  EdgeRow,
  EvidenceRef,
  RuntimeCallerRow,
  RuntimeGraphNodeKind,
  RuntimeGraphParticipantRow,
  SourceLocation,
  SymbolRow,
} from "../contracts/common.js"

export interface GraphNodeRow {
  snapshot_id: number
  node_id: string
  canonical_name: string
  kind: string
  location?: SourceLocation
  payload: Record<string, unknown>
}

export interface GraphEdgeRow {
  snapshot_id: number
  edge_id: string
  edge_kind: string
  src_node_id?: string
  dst_node_id?: string
  confidence: number
  derivation: string
  metadata: Record<string, unknown>
}

export interface GraphEvidenceRow {
  snapshot_id: number
  evidence_id: string
  edge_id?: string
  node_id?: string
  source_kind: string
  location?: SourceLocation
  payload: Record<string, unknown>
}

export interface GraphObservationRow {
  snapshot_id: number
  observation_id: string
  node_id?: string
  kind: string
  observed_at: string
  confidence: number
  payload: Record<string, unknown>
}

export interface GraphWriteBatch {
  nodes: GraphNodeRow[]
  edges: GraphEdgeRow[]
  evidence: GraphEvidenceRow[]
  observations: GraphObservationRow[]
}

export interface GraphWriteSink {
  write(batch: GraphWriteBatch): Promise<void>
  /**
   * Purge all nodes and dependent edges for a given file from a snapshot.
   * Optional — only the SQLite-backed sink implements it; in-memory and
   * test sinks may omit it. Callers must check for its presence before use.
   */
  purgeFile?(snapshotId: number, filePath: string): Promise<{ nodes: number; edges: number }>
}

function id(parts: Array<string | number | undefined>): string {
  return parts.filter((part): part is string | number => part !== undefined && part !== null && part !== "").join(":")
}

function isSymbolBackedKind(kind: string): boolean {
  return ["function", "api", "struct", "union", "enum", "typedef", "macro", "global_var", "field", "param"].includes(
    kind,
  )
}

function normalizeGraphKind(kind: RuntimeGraphNodeKind): string {
  if (kind === "api") return "function"
  return kind
}

function runtimeNodeId(snapshotId: number, participant: { name: string; kind: string }): string {
  if (isSymbolBackedKind(participant.kind)) {
    return id(["graph_node", snapshotId, "symbol", participant.name])
  }
  return id(["graph_node", snapshotId, "runtime", participant.kind, participant.name])
}

function runtimeParticipantNode(snapshotId: number, participant: RuntimeGraphParticipantRow): GraphNodeRow {
  const kind = normalizeGraphKind(participant.kind)
  return {
    snapshot_id: snapshotId,
    node_id: runtimeNodeId(snapshotId, { name: participant.name, kind }),
    canonical_name: participant.name,
    kind,
    location: participant.location,
    payload: {
      role: participant.role,
      ...(participant.metadata ?? {}),
    },
  }
}

function placeholderRuntimeParticipant(
  row: RuntimeCallerRow,
  role: string,
  name: string,
  kind: RuntimeGraphNodeKind,
  location?: SourceLocation,
): RuntimeGraphParticipantRow {
  return {
    name,
    kind,
    location,
    role,
    metadata: {
      runtime_trigger: row.runtimeTrigger,
      dispatch_chain: row.dispatchChain,
      dispatch_site: row.dispatchSite,
    },
  }
}

function participantsForRuntimeRow(row: RuntimeCallerRow): RuntimeGraphParticipantRow[] {
  const participantsByName = new Map<string, RuntimeGraphParticipantRow>()

  const push = (participant: RuntimeGraphParticipantRow) => {
    participantsByName.set(participant.name, participant)
  }

  for (const participant of row.participants ?? []) {
    push(participant)
  }

  if (!participantsByName.has(row.targetApi)) {
    push(placeholderRuntimeParticipant(row, "target", row.targetApi, row.targetKind ?? "function"))
  }

  if (!participantsByName.has(row.immediateInvoker)) {
    push(placeholderRuntimeParticipant(row, "invoker", row.immediateInvoker, "unknown", row.dispatchSite))
  }

  const chain = row.dispatchChain.length > 0 ? row.dispatchChain : [row.immediateInvoker, row.targetApi]

  chain.forEach((name: string, index: number) => {
    if (participantsByName.has(name)) return
    const role =
      name === row.targetApi
        ? "target"
        : name === row.immediateInvoker
          ? "invoker"
          : index === 0
            ? "trigger"
            : "dispatch_step"
    const kind: RuntimeGraphNodeKind = name === row.targetApi ? (row.targetKind ?? "function") : "unknown"
    push(
      placeholderRuntimeParticipant(row, role, name, kind, index === chain.length - 1 ? row.dispatchSite : undefined),
    )
  })

  return [...participantsByName.values()]
}

function runtimeChainEdges(
  snapshotId: number,
  row: RuntimeCallerRow,
  participantsByName: Map<string, RuntimeGraphParticipantRow>,
): GraphEdgeRow[] {
  const chain = row.dispatchChain.length > 0 ? row.dispatchChain : [row.immediateInvoker, row.targetApi]

  const edges: GraphEdgeRow[] = []
  const seen = new Set<string>()

  for (let i = 0; i < chain.length - 1; i += 1) {
    const srcName = chain[i]!
    const dstName = chain[i + 1]!
    const srcParticipant =
      participantsByName.get(srcName) ?? placeholderRuntimeParticipant(row, "dispatch_step", srcName, "unknown")
    const dstParticipant =
      participantsByName.get(dstName) ??
      placeholderRuntimeParticipant(
        row,
        "dispatch_step",
        dstName,
        dstName === row.targetApi ? (row.targetKind ?? "function") : "unknown",
      )
    const isFinalStep = srcName === row.immediateInvoker && dstName === row.targetApi
    const edge_id = isFinalStep
      ? id(["graph_edge", snapshotId, "runtime_invokes", row.immediateInvoker, row.targetApi])
      : id(["graph_edge", snapshotId, "runtime_chain", i, srcName, dstName])
    if (seen.has(edge_id)) continue
    seen.add(edge_id)
    edges.push({
      snapshot_id: snapshotId,
      edge_id,
      edge_kind: "runtime_calls",
      src_node_id: runtimeNodeId(snapshotId, {
        name: srcParticipant.name,
        kind: normalizeGraphKind(srcParticipant.kind),
      }),
      dst_node_id: runtimeNodeId(snapshotId, {
        name: dstParticipant.name,
        kind: normalizeGraphKind(dstParticipant.kind),
      }),
      confidence: row.confidence,
      derivation: "runtime",
      metadata: {
        runtime_call_kind: isFinalStep ? "runtime_observed" : "runtime_chain_step",
        runtime_trigger: row.runtimeTrigger,
        dispatch_chain: row.dispatchChain,
        dispatch_site: row.dispatchSite,
        chain_index: i,
      },
    })
  }

  return edges
}

export function symbolNode(snapshotId: number, row: SymbolRow): GraphNodeRow {
  const name = row.qualifiedName ?? row.name
  return {
    snapshot_id: snapshotId,
    node_id: id(["graph_node", snapshotId, "symbol", name]),
    canonical_name: name,
    kind: row.kind,
    location: row.location,
    payload: {
      signature: row.signature,
      linkage: row.linkage,
      metadata: row.metadata ?? {},
    },
  }
}

export function edgeRow(snapshotId: number, row: EdgeRow): GraphEdgeRow {
  const src = row.srcSymbolName ? id(["graph_node", snapshotId, "symbol", row.srcSymbolName]) : undefined
  const dst = row.dstSymbolName ? id(["graph_node", snapshotId, "symbol", row.dstSymbolName]) : undefined
  return {
    snapshot_id: snapshotId,
    edge_id: id(["graph_edge", snapshotId, row.edgeKind, row.srcSymbolName, row.dstSymbolName]),
    edge_kind: row.edgeKind,
    src_node_id: src,
    dst_node_id: dst,
    confidence: row.confidence,
    derivation: row.derivation,
    metadata: {
      ...(row.metadata ?? {}),
      access_path: row.accessPath,
      source_location: row.sourceLocation,
    },
  }
}

export function evidenceRow(snapshotId: number, edgeId: string, evidence?: EvidenceRef): GraphEvidenceRow | null {
  if (!evidence) return null
  return {
    snapshot_id: snapshotId,
    evidence_id: id(["graph_evidence", snapshotId, edgeId]),
    edge_id: edgeId,
    source_kind: evidence.sourceKind,
    location: evidence.location,
    payload: evidence.raw ?? {},
  }
}

export function runtimeRows(
  snapshotId: number,
  row: RuntimeCallerRow,
): {
  nodes: GraphNodeRow[]
  edges: GraphEdgeRow[]
  observation: GraphObservationRow
  evidence: GraphEvidenceRow | null
} {
  const participants = participantsForRuntimeRow(row)
  const participantsByName = new Map(participants.map((participant) => [participant.name, participant]))
  const nodes = participants.map((participant) => runtimeParticipantNode(snapshotId, participant))
  const edges = runtimeChainEdges(snapshotId, row, participantsByName)
  const primaryEdge =
    edges.find(
      (edge) => edge.edge_id === id(["graph_edge", snapshotId, "runtime_invokes", row.immediateInvoker, row.targetApi]),
    ) ?? edges[edges.length - 1]
  const dst =
    primaryEdge?.dst_node_id ??
    runtimeNodeId(snapshotId, { name: row.targetApi, kind: normalizeGraphKind(row.targetKind ?? "function") })
  return {
    nodes,
    edges,
    observation: {
      snapshot_id: snapshotId,
      observation_id: id(["graph_observation", snapshotId, row.targetApi, row.immediateInvoker]),
      node_id: dst,
      kind: "runtime_invocation",
      observed_at: new Date().toISOString(),
      confidence: row.confidence,
      payload: {
        target_api: row.targetApi,
        immediate_invoker: row.immediateInvoker,
        runtime_trigger: row.runtimeTrigger,
        dispatch_chain: row.dispatchChain,
        dispatch_site: row.dispatchSite,
      },
    },
    evidence: evidenceRow(
      snapshotId,
      primaryEdge?.edge_id ?? id(["graph_edge", snapshotId, "runtime_invokes", row.immediateInvoker, row.targetApi]),
      row.evidence,
    ),
  }
}
