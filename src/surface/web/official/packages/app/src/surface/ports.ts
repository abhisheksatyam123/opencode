export type SurfaceTodoStatus = "pending" | "in_progress" | "completed" | "cancelled" | string
export type SurfaceTodoPriority = "high" | "medium" | "low" | string

export type SurfaceTodoItem = {
  content: string
  status: SurfaceTodoStatus
  priority: SurfaceTodoPriority
  num?: string
  type?: string
  phase?: string
  acceptance_signal?: string
  depends_on?: string[]
  blocked_by?: string[]
  parallel_group?: string
  agent?: string
  comments?: string[]
  learnings?: string[]
  plans?: string[]
  children?: SurfaceTodoItem[]
}

export type SurfaceTodoSection = {
  title: string
  body: string
}

export type SurfaceTodoAgent = {
  rootSessionID: string
  name: string
  sessionID: string
  providerID: string
  modelID: string
  timeCreated?: number
  timeUpdated?: number
}

export type SurfaceTodoSnapshot = {
  todo_id?: string
  status?: "active" | "deferred" | "done" | "failed" | "missing" | string
  source?:
    | "explicit"
    | "session-active"
    | "session-attached"
    | "worktree-active"
    | "branch-active"
    | "default"
    | "archived-result"
    | "legacy"
    | "none"
    | string
  revision?: string
  updated_at?: string
  todos: SurfaceTodoItem[]
  tree?: SurfaceTodoItem[]
  progress_tail?: string[]
  /** Server wire field. Prefer taskPath in UI code. */
  task_path?: string
  taskPath?: string
  sections?: SurfaceTodoSection[]
  hash?: string
  context?: string
  learnings_by_agent?: Record<string, string[]>
  open_questions?: string[]
  working_memory?: Record<string, string>
  verification_results?: string
  messages_recent?: string[]
}

export type SurfaceTokenCounts = {
  input: number
  output: number
  reasoning: number
  cache: {
    read: number
    write: number
  }
}

export type SurfaceSessionTokenAgent = {
  sessionID: string
  title: string
  providerID: string
  modelID: string
  tokens: SurfaceTokenCounts
  cost: number
  contextLimit?: number
  contextUsagePct?: number
  messageCount: number
  isRoot: boolean
}

export type SurfaceSessionTokenTimeline = {
  userMessageID: string
  turnIndex: number
  tokens: SurfaceTokenCounts
  cost: number
  createdAt: number
}

export type SurfaceLLMCallStats = {
  messageID: string
  turnIndex: number
  providerID: string
  modelID: string
  tokens: SurfaceTokenCounts
  sentTokens: number
  receivedTokens: number
  toolCalls: number
  cost: number
  createdAt: number
}

export type SurfaceContextComponentStats = {
  name: string
  tokens: number
  pct: number
  detail?: string
}

export type SurfaceContextToolStats = {
  name: string
  calls: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export type SurfaceContextWindowStats = {
  providerID?: string
  modelID?: string
  modelName?: string
  hardLimit?: number
  inputLimit?: number
  outputReserve?: number
  softLimit?: number
  used: number
  availableHard?: number
  availableInput?: number
  availableSoft?: number
  usedPctHard?: number
  usedPctInput?: number
  usedPctSoft?: number
  estimatedTotal: number
  components: SurfaceContextComponentStats[]
  tools: SurfaceContextToolStats[]
  callCount: number
  avgCallTokens: number
  totalToolCalls: number
  totalToolCallTokens: number
  avgToolCallsPerLLM: number
  maxToolCallsPerLLM: number
}

export type SurfaceSessionTokenStats = {
  sessionID: string
  agents: SurfaceSessionTokenAgent[]
  aggregate: {
    tokens: SurfaceTokenCounts
    cost: number
    agentCount: number
    messageCount: number
  }
  timeline: SurfaceSessionTokenTimeline[]
  llmCalls: SurfaceLLMCallStats[]
  context: SurfaceContextWindowStats
}

export type SurfaceNoteFile = {
  path: string
  name: string
  ext: string
  size: number
}

export type SurfaceNoteFileResponse = {
  path: string
  ext: string
  content: string
  mtime: number
  size: number
}

export type SurfaceNoteSearchResult = {
  path: string
  line: number
  text: string
  kind?: "file" | "content"
}

export type SurfaceNotesGraph = {
  nodes: string[]
  edges: Array<{ from: string; to: string }>
}

export type SurfaceIntelGraphDirection = "incoming" | "outgoing" | "both"

export type SurfaceIntelGraphNode = {
  id: string
  label?: string
  kind: string
  file_path: string | null
  line: number | null
  end_line?: number | null
  line_count?: number | null
  exported?: boolean
  doc: string | null
  owning_class?: string | null
  signature?: string | null
  tags?: string[]
  confidence?: number
  metrics?: Record<string, number>
  source?: "indexed" | "manual" | "derived"
}

export type SurfaceIntelGraphEdge = {
  id?: string
  src: string
  dst: string
  kind: string
  label?: string
  direction?: SurfaceIntelGraphDirection
  direct?: boolean
  depth?: number
  path_id?: string
  confidence?: number
  tags?: string[]
  manual?: boolean
  resolution_kind?: string | null
  metadata?: Record<string, unknown> | null
}

export type SurfaceIntelGraphSearchResult = {
  id: string
  label: string
  kind: string
  file_path: string | null
  line: number | null
  signature?: string | null
  tags: string[]
  score: number
}

export type SurfaceIntelGraphRelationPath = {
  id: string
  depth: number
  nodes: string[]
  edges: SurfaceIntelGraphEdge[]
}

export type SurfaceIntelGraphRelationGroup = {
  kind: string
  direction: "incoming" | "outgoing"
  direct: SurfaceIntelGraphEdge[]
  indirect: SurfaceIntelGraphRelationPath[]
}

export type SurfaceIntelGraphRelationsDiagnostic = {
  code: "location_not_indexed" | "symbol_not_indexed" | "relation_timeout"
  message: string
  symbol?: string
  file?: string
  line?: number
}

export type SurfaceIntelGraphRelationItem = {
  node: SurfaceIntelGraphNode
  relation: SurfaceIntelGraphEdge
}

export type SurfaceIntelGraphRelationBucket = {
  type: string
  direction: "incoming" | "outgoing"
  items: SurfaceIntelGraphRelationItem[]
  truncated?: boolean
}

export type SurfaceIntelGraphNodeRelationRecord = {
  node: SurfaceIntelGraphNode
  relations: SurfaceIntelGraphRelationBucket[]
}

export type SurfaceIntelGraphRelationData = {
  symbol: string
  nodes: SurfaceIntelGraphNodeRelationRecord[]
  diagnostic?: SurfaceIntelGraphRelationsDiagnostic
  limits?: {
    maxNodes?: number
    maxDepth?: number
    truncated?: boolean
  }
}

export type SurfaceIntelGraphRelations = {
  symbol: string
  node: SurfaceIntelGraphNode | null
  nodes?: SurfaceIntelGraphNode[]
  groups: SurfaceIntelGraphRelationGroup[]
  diagnostic?: SurfaceIntelGraphRelationsDiagnostic
  relationData?: SurfaceIntelGraphRelationData
}

export type SurfaceIntelGraphV1RelationKind =
  | "api_callers"
  | "api_registrations"
  | "api_deregistrations"
  | "indirect_registered_callers"

export type SurfaceIntelGraphV1Diagnostic = {
  code: string
  message: string
  severity?: "debug" | "info" | "warn" | "error"
  tool?: string
  file?: string
  line?: number
  character?: number
}

export type SurfaceIntelGraphV1Evidence = {
  tool: string
  detail: string
  file?: string
  line?: number
  character?: number
  confidence?: number
}

export type SurfaceIntelGraphV1RelationNode = {
  id: string
  kind: string
  symbol: string
  file?: string
  line?: number
  character?: number
  label?: string
  language?: string
  relations: Partial<Record<SurfaceIntelGraphV1RelationKind, SurfaceIntelGraphV1RelationNode[]>>
  via?: SurfaceIntelGraphV1Evidence[]
  diagnostics?: SurfaceIntelGraphV1Diagnostic[]
  truncated?: boolean
}

export type SurfaceIntelGraphV1RelationRequest = {
  symbol: string
  file?: string
  line?: number
  character?: number
  kinds?: SurfaceIntelGraphV1RelationKind[]
  language?: "c" | (string & {})
  limits?: { maxResultsPerKind?: number; timeoutMs?: number }
}

export type SurfaceIntelGraphV1RelationResult = {
  root: SurfaceIntelGraphV1RelationNode
  diagnostics?: SurfaceIntelGraphV1Diagnostic[]
}

export type SurfaceIntelGraphV1Capabilities = {
  languages: string[]
  relationKinds: SurfaceIntelGraphV1RelationKind[]
  features: { dynamicResolution: boolean; persistentIndex: boolean; fullGraph: boolean; readOnly: boolean }
}

export type SurfaceIntelGraphV1SymbolSearchRequest = {
  symbol: string
  file?: string
  line?: number
  character?: number
  language?: "c" | (string & {})
  limit?: number
}

export type SurfaceIntelGraphV1SymbolSearchMatch = {
  id: string
  kind: string
  symbol: string
  file?: string
  line?: number
  character?: number
  label?: string
  language?: string
  score?: number
  diagnostics?: SurfaceIntelGraphV1Diagnostic[]
}

export type SurfaceIntelGraphV1SymbolSearchResult = {
  query: string
  matches: SurfaceIntelGraphV1SymbolSearchMatch[]
  diagnostics?: SurfaceIntelGraphV1Diagnostic[]
}

export interface SurfaceBridge {
  readonly getTodoSnapshot: (sessionID: string, options?: { force?: boolean }) => Promise<SurfaceTodoSnapshot>
  readonly createTodoFile: (
    sessionID: string,
    input: { title: string; slug?: string; assignment?: string; body?: string; project?: string },
  ) => Promise<SurfaceTodoSnapshot>
  readonly attachTodoFile: (sessionID: string, path: string) => Promise<SurfaceTodoSnapshot>
  readonly patchTodoFile: (
    sessionID: string,
    input: { baseHash?: string; operations: Array<Record<string, unknown>> },
  ) => Promise<{ snapshot: SurfaceTodoSnapshot; changed: boolean; applied: number; hash: string }>
  readonly listTodoAgents: (sessionID: string) => Promise<{ agents: SurfaceTodoAgent[] }>
  readonly runTodoAgentTask: (
    sessionID: string,
    input: { taskMarkdown: string; systemsText?: string; mode?: "initial" | "follow-up"; async?: boolean },
  ) => Promise<{ agent?: SurfaceTodoAgent; responseText?: string; accepted?: boolean }>
  readonly getSessionStatuses: () => Promise<Record<string, { type: string }>>
  readonly getSessionStats: (sessionID: string, options?: { force?: boolean }) => Promise<SurfaceSessionTokenStats>
  readonly listNotes: (options?: { force?: boolean }) => Promise<{ root: string; files: SurfaceNoteFile[] }>
  readonly getNoteFile: (path: string, options?: { force?: boolean }) => Promise<SurfaceNoteFileResponse>
  readonly saveNoteFile: (
    path: string,
    content: string,
  ) => Promise<{ path: string; size: number; backup?: string | null }>
  readonly searchNotes: (query: string, options?: { force?: boolean }) => Promise<SurfaceNoteSearchResult[]>
  readonly getNotesGraph: (options?: { force?: boolean }) => Promise<SurfaceNotesGraph>
  readonly capabilities: (options?: { force?: boolean }) => Promise<SurfaceIntelGraphV1Capabilities>
  readonly searchSymbol: (
    request: SurfaceIntelGraphV1SymbolSearchRequest,
    options?: { force?: boolean; refresh?: boolean },
  ) => Promise<SurfaceIntelGraphV1SymbolSearchResult>
  readonly resolveRelations: (
    request: SurfaceIntelGraphV1RelationRequest,
    options?: { force?: boolean; refresh?: boolean },
  ) => Promise<SurfaceIntelGraphV1RelationResult>
  readonly getIntelGraphUrl: () => string
  readonly getMermaidScriptUrl: () => string
  readonly renderPlantUML: (source: string) => Promise<string>
  readonly onTodoSnapshot?: (
    handler: (event: { sessionID: string; snapshot: SurfaceTodoSnapshot }) => void,
  ) => () => void
}
