export const IntelGraphRelationKinds = [
  "api_callers",
  "api_registrations",
  "api_deregistrations",
  "indirect_registered_callers",
] as const

export type IntelGraphRelationKind = (typeof IntelGraphRelationKinds)[number]

export type IntelGraphLanguage = "c" | (string & {})

export type IntelGraphNodeKind =
  | "function"
  | "api"
  | "registration"
  | "struct_field"
  | "callsite"
  | (string & {})

export type IntelGraphDiagnosticSeverity = "debug" | "info" | "warn" | "error"

export type IntelGraphDiagnostic = {
  code: string
  message: string
  severity?: IntelGraphDiagnosticSeverity
  tool?: string
  file?: string
  line?: number
  character?: number
  cause?: unknown
}

export type IntelGraphRelationEvidence = {
  tool: "lsp" | "tree-sitter" | "resolver" | (string & {})
  detail: string
  file?: string
  line?: number
  character?: number
  confidence?: number
}

export type IntelGraphRelationMap = Partial<Record<IntelGraphRelationKind, IntelGraphRelationNode[]>>

export type IntelGraphRelationNode = {
  id: string
  kind: IntelGraphNodeKind
  symbol: string
  file?: string
  line?: number
  character?: number
  label?: string
  language?: IntelGraphLanguage
  relations: IntelGraphRelationMap
  via?: IntelGraphRelationEvidence[]
  diagnostics?: IntelGraphDiagnostic[]
  truncated?: boolean
}


export type IntelGraphParsedRelationSymbol = {
  symbol: string
  file?: string
  line?: number
}

export function parseIntelGraphRelationSymbol(value: string): IntelGraphParsedRelationSymbol {
  const raw = stripIntelGraphSymbolPrefix(value)
  if (!raw) return { symbol: "" }
  const location = raw.match(/^(.+)@(.+):(\d+)(?:#\d+)?$/)
  if (!location) return { symbol: relationSymbolName(raw) }
  const line = Number(location[3] ?? "")
  return {
    symbol: relationSymbolName(location[1] ?? raw),
    file: (location[2] ?? "").trim() || undefined,
    line: Number.isFinite(line) && line > 0 ? line : undefined,
  }
}

export function normalizeIntelGraphRelationRequest(request: IntelGraphRelationRequest): IntelGraphRelationRequest {
  const parsed = parseIntelGraphRelationSymbol(request.symbol)
  return {
    ...request,
    symbol: parsed.symbol || request.symbol.trim(),
    file: request.file || parsed.file,
    line: request.line ?? parsed.line,
  }
}

function relationSymbolName(value: string) {
  const symbol = stripIntelGraphSymbolPrefix(value)
  return symbol.includes("#") ? (symbol.split("#").pop() ?? symbol).trim() : symbol
}

function stripIntelGraphSymbolPrefix(value: string) {
  const trimmed = value.trim()
  if (trimmed.startsWith("fn:")) return trimmed.slice(3).trim()
  if (trimmed.startsWith("reg:")) return trimmed.slice(4).trim()
  return trimmed
}

export type IntelGraphCapabilities = {
  languages: IntelGraphLanguage[]
  relationKinds: IntelGraphRelationKind[]
  features: {
    dynamicResolution: true
    persistentIndex: false
    fullGraph: false
    readOnly: true
  }
}

export type IntelGraphSymbolSearchRequest = {
  symbol: string
  file?: string
  line?: number
  character?: number
  language?: IntelGraphLanguage
  limit?: number
}

export type IntelGraphSymbolSearchMatch = Omit<IntelGraphRelationNode, "relations" | "via"> & {
  relations?: IntelGraphRelationMap
  score?: number
}

export type IntelGraphSymbolSearchResult = {
  query: string
  matches: IntelGraphSymbolSearchMatch[]
  diagnostics?: IntelGraphDiagnostic[]
}

export type IntelGraphRelationRequest = {
  symbol: string
  file?: string
  line?: number
  character?: number
  kinds?: IntelGraphRelationKind[]
  language?: IntelGraphLanguage
  limits?: {
    maxResultsPerKind?: number
    timeoutMs?: number
  }
}

export type IntelGraphRelationResponse = {
  root: IntelGraphRelationNode
  diagnostics?: IntelGraphDiagnostic[]
}

export type IntelGraphApi = {
  capabilities(): Promise<IntelGraphCapabilities>
  searchSymbol(request: IntelGraphSymbolSearchRequest): Promise<IntelGraphSymbolSearchResult>
  resolveRelations(request: IntelGraphRelationRequest): Promise<IntelGraphRelationResponse>
}

export function createEmptyRelationMap(): IntelGraphRelationMap {
  return {}
}

export function intelGraphCapabilities(): IntelGraphCapabilities {
  return {
    languages: ["c"],
    relationKinds: [...IntelGraphRelationKinds],
    features: {
      dynamicResolution: true,
      persistentIndex: false,
      fullGraph: false,
      readOnly: true,
    },
  }
}
