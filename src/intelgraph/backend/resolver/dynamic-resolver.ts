import { readFileSync } from "node:fs"
import { resolveIndirectRegisteredCallers } from "./indirect-callers"
import { canonicalizeIntelGraphSourcePath, canonicalizeIntelGraphSymbol, isIntelGraphPrimarySourcePath } from "../source-path-policy"
import {
  IntelGraphRelationKinds,
  createEmptyRelationMap,
  normalizeIntelGraphRelationRequest,
  intelGraphCapabilities,
  type IntelGraphApi,
  type IntelGraphDiagnostic,
  type IntelGraphLanguage,
  type IntelGraphNodeKind,
  type IntelGraphRelationKind,
  type IntelGraphRelationRequest,
  type IntelGraphRelationNode,
  type IntelGraphRelationResponse,
  type IntelGraphSymbolSearchMatch,
  type IntelGraphSymbolSearchRequest,
  type IntelGraphSymbolSearchResult,
} from "../../contract"

const DEFAULT_SYMBOL_SEARCH_LIMIT = 20
const MAX_SYMBOL_SEARCH_LIMIT = 100
const BRIDGED_DIRECT_CALLER_LIMIT = 3

type RegistrationOperation = "registration" | "deregistration"

export type IntelGraphLspSymbolMatch = {
  id?: string
  symbol?: string
  kind?: IntelGraphNodeKind
  file?: string
  line?: number
  character?: number
  label?: string
  language?: IntelGraphLanguage
  score?: number
}

export type IntelGraphLspLocation = {
  uri?: string
  range?: { start?: { line?: number; character?: number }; end?: { line?: number; character?: number } }
}

export type IntelGraphLspIndirectCaller = {
  symbol: string
  file?: string
  line?: number
  character?: number
  callerRole: "runtime_caller" | "registrar" | "direct_caller"
  invocationType?: string
  registrationApi?: string
  confidence?: number
  source?: string
  detail?: string
}

export type IntelGraphLspIncomingCall = {
  from?: {
    name?: string
    uri?: string
    range?: { start?: { line?: number; character?: number } }
    selectionRange?: { start?: { line?: number; character?: number } }
  }
  caller?: IntelGraphLspIncomingCall["from"]
}

export type IntelGraphLspLike = {
  workspaceSymbol(request: {
    query: string
    file?: string
    line?: number
    character?: number
    language?: IntelGraphLanguage
    limit: number
  }): Promise<IntelGraphLspSymbolMatch[]>
  incomingCalls?(request: {
    file: string
    line: number
    character?: number
    symbol: string
    limit: number
  }): Promise<IntelGraphLspIncomingCall[]>
  textReferences?(request: {
    file: string
    line: number
    character?: number
    symbol: string
    limit: number
  }): Promise<IntelGraphLspLocation[]>
  references?(request: {
    file: string
    line: number
    character?: number
    symbol: string
    limit: number
  }): Promise<IntelGraphLspLocation[]>
  indirectCallers?(request: {
    file: string
    line: number
    character?: number
    symbol: string
    limit: number
  }): Promise<IntelGraphLspIndirectCaller[]>
}

export type DynamicIntelGraphResolverOptions = {
  lsp: IntelGraphLspLike
  defaultLanguage?: IntelGraphLanguage
}

export function createDynamicIntelGraphResolver(options: DynamicIntelGraphResolverOptions): IntelGraphApi {
  const defaultLanguage = options.defaultLanguage ?? "c"

  return {
    async capabilities() {
      return intelGraphCapabilities()
    },

    async searchSymbol(request) {
      return searchSymbol(options.lsp, request, defaultLanguage)
    },

    async resolveRelations(request) {
      return resolveRelations(options.lsp, request, defaultLanguage)
    },
  }
}

async function searchSymbol(
  lsp: IntelGraphLspLike,
  request: IntelGraphSymbolSearchRequest,
  defaultLanguage: IntelGraphLanguage,
): Promise<IntelGraphSymbolSearchResult> {
  const query = request.symbol.trim()
  if (!query) {
    return {
      query,
      matches: [],
      diagnostics: [
        {
          code: "missing_symbol",
          message: "Missing symbol",
          severity: "warn",
          tool: "resolver",
        },
      ],
    }
  }

  const limit = clamp(request.limit, DEFAULT_SYMBOL_SEARCH_LIMIT, 1, MAX_SYMBOL_SEARCH_LIMIT)

  try {
    const rows = await lsp.workspaceSymbol({
      query,
      file: request.file,
      line: request.line,
      character: request.character,
      language: request.language,
      limit,
    })

    const matches = rows
      .slice(0, limit)
      .map((row, index) => symbolMatchFromLsp({
        ...row,
        symbol: row.symbol ? canonicalizeIntelGraphSymbol(row.symbol) : row.symbol,
        file: canonicalizeIntelGraphSourcePath(row.file),
      }, query, defaultLanguage, index))

    return {
      query,
      matches,
    }
  } catch (error) {
    return {
      query,
      matches: [],
      diagnostics: [
        {
          code: "symbol_search_failed",
          message: `Symbol search failed for \"${query}\"`,
          severity: "warn",
          tool: "lsp",
          cause: error,
        },
      ],
    }
  }
}

async function resolveRelations(
  lsp: IntelGraphLspLike,
  request: IntelGraphRelationRequest,
  defaultLanguage: IntelGraphLanguage,
): Promise<IntelGraphRelationResponse> {
  const normalizedRequest = normalizeIntelGraphRelationRequest(request)
  const selectedSymbol = canonicalizeIntelGraphSymbol(normalizedRequest.symbol.trim())
  const canonicalRequest: IntelGraphRelationRequest = {
    ...normalizedRequest,
    symbol: selectedSymbol,
    file: canonicalizeIntelGraphSourcePath(normalizedRequest.file),
  }
  const symbol = selectedSymbol || fallbackSymbolFromLocation(canonicalRequest.file, canonicalRequest.line)
  const { kinds, diagnostics } = relationKindsFrom(canonicalRequest.kinds)
  const limit = clamp(canonicalRequest.limits?.maxResultsPerKind, 25, 1, 100)

  const relations = createEmptyRelationMap()
  for (const kind of kinds) relations[kind] = []

  const root: IntelGraphRelationNode = {
    id: relationNodeId(symbol, canonicalRequest.file, canonicalRequest.line),
    kind: "function",
    symbol,
    file: canonicalRequest.file,
    line: canonicalRequest.line,
    character: canonicalRequest.character,
    language: canonicalRequest.language ?? defaultLanguage,
    relations,
  }

  const allDiagnostics = [...diagnostics]

  for (const kind of kinds) {
    if (kind === "api_callers") {
      const { nodes, diagnostics: callerDiagnostics } = await resolveApiCallers(
        lsp,
        canonicalRequest,
        symbol,
        defaultLanguage,
        limit,
      )
      root.relations.api_callers = nodes
      allDiagnostics.push(...callerDiagnostics)
      continue
    }
    if (kind === "api_registrations" || kind === "api_deregistrations") {
      const operation = kind === "api_deregistrations" ? "deregistration" : "registration"
      const { nodes, diagnostics: registrationDiagnostics } = await resolveApiRegistrations(
        lsp,
        canonicalRequest,
        symbol,
        defaultLanguage,
        limit,
        operation,
      )
      root.relations[kind] = nodes
      allDiagnostics.push(...registrationDiagnostics)
      continue
    }
    if (kind === "indirect_registered_callers") {
      const { nodes, diagnostics: indirectDiagnostics } = await resolveIndirectRegisteredCallers(
        lsp,
        canonicalRequest,
        symbol,
        defaultLanguage,
        limit,
      )
      const directFallback =
        nodes.length === 0
          ? await indirectCallerNodesThroughDirectCallers(lsp, canonicalRequest, symbol, defaultLanguage, limit)
          : emptyFallback()
      const registrationFallback =
        nodes.length === 0 && directFallback.nodes.length === 0
          ? await indirectCallerNodesFromRegistrationTextReferences(lsp, canonicalRequest, symbol, defaultLanguage, limit)
          : emptyFallback()
      root.relations.indirect_registered_callers =
        nodes.length > 0 ? nodes : directFallback.nodes.length > 0 ? directFallback.nodes : registrationFallback.nodes
      allDiagnostics.push(...indirectDiagnostics, ...directFallback.diagnostics, ...registrationFallback.diagnostics)
      continue
    }
  }

  if (allDiagnostics.length > 0) root.diagnostics = allDiagnostics

  return {
    root,
    ...(allDiagnostics.length > 0 ? { diagnostics: allDiagnostics } : {}),
  }
}

function primarySourceRelationNodes(nodes: IntelGraphRelationNode[]) {
  const seen = new Set<string>()
  const canonical: IntelGraphRelationNode[] = []
  for (const node of nodes) {
    const next = canonicalizeRelationNode(node)
    const key = [next.symbol, next.file ?? "", next.line ?? ""].join("|")
    if (seen.has(key)) continue
    seen.add(key)
    canonical.push(next)
  }
  return canonical
}

function canonicalizeRelationNode(node: IntelGraphRelationNode): IntelGraphRelationNode {
  const symbol = canonicalizeIntelGraphSymbol(node.symbol)
  const file = canonicalizeIntelGraphSourcePath(node.file)
  return {
    ...node,
    id: relationNodeId(symbol, file, node.line),
    symbol,
    label: node.label ? canonicalizeIntelGraphSymbol(node.label) : node.label,
    file,
  }
}

async function resolveApiCallers(
  lsp: IntelGraphLspLike,
  request: IntelGraphRelationRequest,
  symbol: string,
  defaultLanguage: IntelGraphLanguage,
  limit: number,
): Promise<{ nodes: IntelGraphRelationNode[]; diagnostics: IntelGraphDiagnostic[] }> {
  if (!request.file || typeof request.line !== "number") {
    return {
      nodes: [],
      diagnostics: [
        {
          code: "relation_location_required",
          message: "api_callers requires a file and line for dynamic LSP call hierarchy lookup",
          severity: "warn",
          tool: "resolver",
          file: request.file,
          line: request.line,
          character: request.character,
        },
      ],
    }
  }
  if (!lsp.incomingCalls) {
    return {
      nodes: [],
      diagnostics: [
        {
          code: "lsp_incoming_calls_unavailable",
          message: "The configured LSP adapter does not support incoming call hierarchy lookup",
          severity: "warn",
          tool: "lsp",
          file: request.file,
          line: request.line,
          character: request.character,
        },
      ],
    }
  }

  try {
    const calls = await lsp.incomingCalls({
      file: request.file,
      line: request.line,
      character: request.character,
      symbol,
      limit,
    })
    const nodes = primarySourceRelationNodes(
      calls
        .slice(0, limit)
        .flatMap((call, index) => nodeFromIncomingCall(call, symbol, defaultLanguage, index, `direct call to ${symbol}`)),
    )
    if (nodes.length > 0 || !lsp.textReferences) return { nodes, diagnostics: [] }

    const textReferenceNodes = await directCallerNodesFromTextReferences(lsp, request, symbol, defaultLanguage, limit)
    return {
      nodes: textReferenceNodes,
      diagnostics:
        textReferenceNodes.length > 0
          ? [
              {
                code: "api_callers_text_reference_fallback",
                message: `api_callers used text references after LSP call hierarchy returned no callers for "${symbol}"`,
                severity: "info",
                tool: "resolver",
                file: request.file,
                line: request.line,
                character: request.character,
              },
            ]
          : [],
    }
  } catch (error) {
    return {
      nodes: [],
      diagnostics: [
        {
          code: "api_callers_failed",
          message: `api_callers lookup failed for "${symbol}"`,
          severity: "warn",
          tool: "lsp",
          file: request.file,
          line: request.line,
          character: request.character,
          cause: error,
        },
      ],
    }
  }
}

async function resolveApiRegistrations(
  lsp: IntelGraphLspLike,
  request: IntelGraphRelationRequest,
  symbol: string,
  defaultLanguage: IntelGraphLanguage,
  limit: number,
  operation: RegistrationOperation = "registration",
): Promise<{ nodes: IntelGraphRelationNode[]; diagnostics: IntelGraphDiagnostic[] }> {
  if (!request.file || typeof request.line !== "number") {
    return {
      nodes: [],
      diagnostics: [
        {
          code: "relation_location_required",
          message: `${operation === "deregistration" ? "api_deregistrations" : "api_registrations"} requires a file and line for dynamic LSP reference lookup`,
          severity: "warn",
          tool: "resolver",
          file: request.file,
          line: request.line,
          character: request.character,
        },
      ],
    }
  }
  if (!lsp.references) {
    return {
      nodes: [],
      diagnostics: [
        {
          code: "lsp_references_unavailable",
          message: "The configured LSP adapter does not support reference lookup for registration detection",
          severity: "warn",
          tool: "lsp",
          file: request.file,
          line: request.line,
          character: request.character,
        },
      ],
    }
  }

  try {
    const references = await lsp.references({
      file: request.file,
      line: request.line,
      character: request.character,
      symbol,
      limit,
    })
    const nodes = primarySourceRelationNodes(
      references
        .filter((reference) => !isSameLocation(reference, request.file, request.line, request.character))
        .slice(0, limit)
        .map((reference, index) => nodeFromReference(reference, symbol, defaultLanguage, index, operation)),
    )
    const textFallback =
      nodes.length === 0 ? await registrationNodesFromTextReferences(lsp, request, symbol, defaultLanguage, limit, operation) : emptyFallback()
    const bridgeFallback =
      operation === "registration" && nodes.length === 0 && textFallback.nodes.length === 0
        ? await registrationNodesThroughDirectCallers(lsp, request, symbol, defaultLanguage, limit)
        : emptyFallback()
    return {
      nodes: nodes.length > 0 ? nodes : textFallback.nodes.length > 0 ? textFallback.nodes : bridgeFallback.nodes,
      diagnostics: [
        {
          code: `${operation === "deregistration" ? "deregistration" : "registration"}_candidates_unclassified`,
          message: `${operation === "deregistration" ? "api_deregistrations" : "api_registrations"} currently returns LSP reference candidates; tree-sitter classification is the next refinement`,
          severity: "info",
          tool: "lsp",
          file: request.file,
          line: request.line,
          character: request.character,
        },
        ...textFallback.diagnostics,
        ...bridgeFallback.diagnostics,
      ],
    }
  } catch (error) {
    return {
      nodes: [],
      diagnostics: [
        {
          code: "api_registrations_failed",
          message: `api_registrations lookup failed for "${symbol}"`,
          severity: "warn",
          tool: "lsp",
          file: request.file,
          line: request.line,
          character: request.character,
          cause: error,
        },
      ],
    }
  }
}

async function indirectCallerNodesFromRegistrationTextReferences(
  lsp: IntelGraphLspLike,
  request: IntelGraphRelationRequest,
  symbol: string,
  defaultLanguage: IntelGraphLanguage,
  limit: number,
): Promise<{ nodes: IntelGraphRelationNode[]; diagnostics: IntelGraphDiagnostic[] }> {
  if (!lsp.textReferences || !request.file || typeof request.line !== "number") return emptyFallback()
  const references = await lsp.textReferences({
    file: request.file,
    line: request.line,
    character: request.character,
    symbol,
    limit: Math.max(limit * 4, limit),
  })
  const nodes: IntelGraphRelationNode[] = []
  const seen = new Set<string>()
  for (const reference of references) {
    if (nodes.length >= limit) break
    const originalFile = uriToPath(reference.uri)
    const file = canonicalizeIntelGraphSourcePath(originalFile)
    const start = reference.range?.start
    if (!originalFile || !isIntelGraphPrimarySourcePath(originalFile) || !file || typeof start?.line !== "number") continue
    const source = readFile(file)
    const dispatch = source ? registrationRuntimeDispatchInfo(source, start.line, symbol) : undefined
    if (!source || !dispatch) continue
    const line = start.line + 1
    const character = typeof start.character === "number" ? start.character + 1 : undefined
    const node: IntelGraphRelationNode = {
      id: relationNodeId(dispatch.symbol, file, line, nodes.length),
      kind: "function",
      symbol: dispatch.symbol,
      label: dispatch.label,
      file,
      line,
      character,
      language: defaultLanguage,
      relations: createEmptyRelationMap(),
      via: [
        {
          tool: "resolver",
          detail: dispatch.detail,
          file,
          line,
          character,
          confidence: dispatch.confidence,
        },
      ],
    }
    const key = [node.symbol, node.file ?? "", node.line ?? ""].join("|")
    if (seen.has(key)) continue
    seen.add(key)
    nodes.push(node)
  }
  return {
    nodes,
    diagnostics:
      nodes.length > 0
        ? [
            {
              code: "indirect_callers_registration_dispatch_fallback",
              message: `indirect_registered_callers inferred runtime dispatch through registration for "${symbol}"`,
              severity: "info",
              tool: "resolver",
              file: request.file,
              line: request.line,
              character: request.character,
            },
          ]
        : [],
  }
}

function emptyFallback(): { nodes: IntelGraphRelationNode[]; diagnostics: IntelGraphDiagnostic[] } {
  return { nodes: [], diagnostics: [] }
}

async function registrationNodesFromTextReferences(
  lsp: IntelGraphLspLike,
  request: IntelGraphRelationRequest,
  symbol: string,
  defaultLanguage: IntelGraphLanguage,
  limit: number,
  operation: RegistrationOperation = "registration",
): Promise<{ nodes: IntelGraphRelationNode[]; diagnostics: IntelGraphDiagnostic[] }> {
  if (!lsp.textReferences || !request.file || typeof request.line !== "number") return emptyFallback()
  const references = await lsp.textReferences({
    file: request.file,
    line: request.line,
    character: request.character,
    symbol,
    limit: Math.max(limit * 4, limit),
  })
  const nodes: IntelGraphRelationNode[] = []
  const seen = new Set<string>()
  for (const reference of references) {
    if (nodes.length >= limit) break
    if (isSameLocation(reference, request.file, request.line, request.character)) continue
    const originalFile = uriToPath(reference.uri)
    const file = canonicalizeIntelGraphSourcePath(originalFile)
    const start = reference.range?.start
    if (!originalFile || !isIntelGraphPrimarySourcePath(originalFile) || !file || typeof start?.line !== "number") continue
    const source = readFile(file)
    if (!source || registrationReferenceOperation(source, start.line, symbol) !== operation) continue
    const node = nodeFromReference(reference, symbol, defaultLanguage, nodes.length, operation)
    node.via = [
      {
        tool: "resolver",
        detail: `text ${operation} candidate for ${symbol}`,
        file: node.file,
        line: node.line,
        character: node.character,
        confidence: 0.75,
      },
    ]
    const key = [node.symbol, node.file ?? "", node.line ?? "", node.character ?? ""].join("|")
    if (seen.has(key)) continue
    seen.add(key)
    nodes.push(node)
  }
  return {
    nodes,
    diagnostics:
      nodes.length > 0
        ? [
            {
              code: `${operation === "deregistration" ? "api_deregistrations" : "api_registrations"}_text_reference_fallback`,
              message: `${operation === "deregistration" ? "api_deregistrations" : "api_registrations"} used text references to find ${operation} candidate(s) for "${symbol}"`,
              severity: "info",
              tool: "resolver",
              file: request.file,
              line: request.line,
              character: request.character,
            },
          ]
        : [],
  }
}

async function registrationNodesThroughDirectCallers(
  lsp: IntelGraphLspLike,
  request: IntelGraphRelationRequest,
  symbol: string,
  defaultLanguage: IntelGraphLanguage,
  limit: number,
): Promise<{ nodes: IntelGraphRelationNode[]; diagnostics: IntelGraphDiagnostic[] }> {
  if (!lsp.textReferences || !lsp.references) return { nodes: [], diagnostics: [] }
  const directCallers = await directCallerNodesFromTextReferences(lsp, request, symbol, defaultLanguage, limit)
  const nodes: IntelGraphRelationNode[] = []
  const seen = new Set<string>()
  for (const caller of directCallers.slice(0, Math.min(BRIDGED_DIRECT_CALLER_LIMIT, limit))) {
    if (nodes.length >= limit || !caller.file || typeof caller.line !== "number") continue
    const result = await resolveApiRegistrations(
      lsp,
      { ...request, symbol: caller.symbol, file: caller.file, line: caller.line, character: caller.character },
      caller.symbol,
      defaultLanguage,
      Math.max(1, limit - nodes.length),
    )
    const dispatchKey = dispatchKeyForDirectCaller(caller)
    const dispatchKeyMatches = dispatchKey
      ? result.nodes.filter((node) => registrationMatchesDispatchKey(node, dispatchKey, caller))
      : []
    const effectiveDispatchKey = dispatchKeyMatches.length > 0 ? dispatchKey : undefined
    const candidates = dispatchKey && dispatchKeyMatches.length > 0 ? dispatchKeyMatches : result.nodes
    for (const node of candidates) {
      const key = [node.symbol, node.file ?? "", node.line ?? "", node.character ?? ""].join("|")
      if (seen.has(key) || nodes.length >= limit) continue
      seen.add(key)
      nodes.push(
        withBridgeDetail(
          node,
          `registered direct caller ${caller.symbol}${effectiveDispatchKey ? ` for ${effectiveDispatchKey}` : ""} reaches ${symbol}`,
        ),
      )
    }
  }
  return {
    nodes,
    diagnostics:
      nodes.length > 0
        ? [
            {
              code: "api_registrations_direct_caller_fallback",
              message: `api_registrations found registrations on direct caller(s) of "${symbol}"`,
              severity: "info",
              tool: "resolver",
              file: request.file,
              line: request.line,
              character: request.character,
            },
          ]
        : [],
  }
}

function dispatchKeyForDirectCaller(caller: IntelGraphRelationNode) {
  const via = caller.via?.[0]
  if (!via?.file || typeof via.line !== "number") return undefined
  const source = readFile(via.file)
  if (!source) return undefined
  const lines = source.split(/\r?\n/)
  for (let line = Math.max(0, via.line - 1); line >= 0 && line >= via.line - 80; line--) {
    const match = /\bcase\s+([A-Za-z_]\w*)\s*:/.exec(lines[line] ?? "")
    if (match?.[1]) return match[1]
  }
  return undefined
}

function registrationMatchesDispatchKey(
  node: IntelGraphRelationNode,
  dispatchKey: string,
  caller: IntelGraphRelationNode,
) {
  if (!node.file || typeof node.line !== "number") return false
  const source = readFile(resolveRegistrationFileForCaller(node.file, caller))
  const line = source?.split(/\r?\n/)?.[node.line - 1] ?? ""
  return new RegExp(`\b${escapeRegex(dispatchKey)}\b`).test(line)
}

function resolveRegistrationFileForCaller(file: string, caller: IntelGraphRelationNode) {
  if (file.startsWith("/")) return file
  if (caller.file?.endsWith(file)) return caller.file
  return file
}

async function indirectCallerNodesThroughDirectCallers(
  lsp: IntelGraphLspLike,
  request: IntelGraphRelationRequest,
  symbol: string,
  defaultLanguage: IntelGraphLanguage,
  limit: number,
): Promise<{ nodes: IntelGraphRelationNode[]; diagnostics: IntelGraphDiagnostic[] }> {
  if (!lsp.textReferences) return { nodes: [], diagnostics: [] }
  const directCallers = await directCallerNodesFromTextReferences(lsp, request, symbol, defaultLanguage, limit)
  const wmiNodes: IntelGraphRelationNode[] = []
  const wmiSeen = new Set<string>()
  for (const caller of directCallers.slice(0, Math.min(BRIDGED_DIRECT_CALLER_LIMIT, limit))) {
    if (wmiNodes.length >= limit || !caller.file || typeof caller.line !== "number") continue
    const result = await indirectCallerNodesFromRegistrationTextReferences(
      lsp,
      { ...request, symbol: caller.symbol, file: caller.file, line: caller.line, character: caller.character },
      caller.symbol,
      defaultLanguage,
      Math.max(1, limit - wmiNodes.length),
    )
    for (const node of result.nodes) {
      const key = [node.symbol, node.file ?? "", node.line ?? ""].join("|")
      if (wmiSeen.has(key) || wmiNodes.length >= limit) continue
      wmiSeen.add(key)
      wmiNodes.push(withBridgeDetail(node, `through direct caller ${caller.symbol} to ${symbol}`))
    }
  }
  if (wmiNodes.length > 0) {
    return {
      nodes: wmiNodes,
      diagnostics: [
        {
          code: "indirect_callers_direct_caller_fallback",
          message: `indirect_registered_callers found runtime caller(s) through direct caller(s) of "${symbol}"`,
          severity: "info",
          tool: "resolver",
          file: request.file,
          line: request.line,
          character: request.character,
        },
      ],
    }
  }
  if (directCallers.length > BRIDGED_DIRECT_CALLER_LIMIT) return { nodes: [], diagnostics: [] }

  const nodes: IntelGraphRelationNode[] = []
  const seen = new Set<string>()
  for (const caller of directCallers.slice(0, Math.min(BRIDGED_DIRECT_CALLER_LIMIT, limit))) {
    if (nodes.length >= limit || !caller.file || typeof caller.line !== "number") continue
    const result = await resolveIndirectRegisteredCallers(
      lsp,
      { ...request, symbol: caller.symbol, file: caller.file, line: caller.line, character: caller.character },
      caller.symbol,
      defaultLanguage,
      Math.max(1, limit - nodes.length),
    )
    for (const node of result.nodes) {
      const key = [node.symbol, node.file ?? "", node.line ?? ""].join("|")
      if (seen.has(key) || nodes.length >= limit) continue
      seen.add(key)
      nodes.push(withBridgeDetail(node, `through direct caller ${caller.symbol} to ${symbol}`))
    }
  }
  return {
    nodes,
    diagnostics:
      nodes.length > 0
        ? [
            {
              code: "indirect_callers_direct_caller_fallback",
              message: `indirect_registered_callers found runtime caller(s) through direct caller(s) of "${symbol}"`,
              severity: "info",
              tool: "resolver",
              file: request.file,
              line: request.line,
              character: request.character,
            },
          ]
        : [],
  }
}

function withBridgeDetail(node: IntelGraphRelationNode, detail: string): IntelGraphRelationNode {
  return {
    ...node,
    via: node.via?.length
      ? node.via.map((via, index) => (index === 0 ? { ...via, detail: `${via.detail}; ${detail}` } : via))
      : [{ tool: "resolver", detail, file: node.file, line: node.line, character: node.character, confidence: 0.6 }],
  }
}

async function directCallerNodesFromTextReferences(
  lsp: IntelGraphLspLike,
  request: IntelGraphRelationRequest,
  symbol: string,
  defaultLanguage: IntelGraphLanguage,
  limit: number,
): Promise<IntelGraphRelationNode[]> {
  if (!lsp.textReferences || !request.file || typeof request.line !== "number") return []
  const references = await lsp.textReferences({
    file: request.file,
    line: request.line,
    character: request.character,
    symbol,
    limit: Math.max(limit * 4, limit),
  })
  const nodes: IntelGraphRelationNode[] = []
  const seen = new Set<string>()
  for (const reference of references) {
    if (nodes.length >= limit) break
    if (isSameLocation(reference, request.file, request.line, request.character)) continue
    const node = nodeFromTextReference(reference, symbol, defaultLanguage, nodes.length)
    if (!node) continue
    const key = [node.symbol, node.file ?? "", node.line ?? ""].join("|")
    if (seen.has(key)) continue
    seen.add(key)
    nodes.push(node)
  }
  return nodes
}

function nodeFromTextReference(
  reference: IntelGraphLspLocation,
  targetSymbol: string,
  defaultLanguage: IntelGraphLanguage,
  index: number,
): IntelGraphRelationNode | undefined {
  const originalFile = uriToPath(reference.uri)
  const file = canonicalizeIntelGraphSourcePath(originalFile)
  const start = reference.range?.start
  if (!originalFile || !isIntelGraphPrimarySourcePath(originalFile) || !file || typeof start?.line !== "number" || typeof start.character !== "number") return undefined
  const source = readFile(file)
  if (!source || isRegistrationReference(source, start.line, targetSymbol)) return undefined
  const caller = enclosingCFunction(source, start.line, start.character)
  if (!caller || caller.symbol === targetSymbol) return undefined
  return {
    id: relationNodeId(caller.symbol, file, caller.line, index),
    kind: "function",
    symbol: caller.symbol,
    file,
    line: caller.line,
    character: caller.character,
    language: defaultLanguage,
    relations: createEmptyRelationMap(),
    via: [
      {
        tool: "resolver",
        detail: `text reference call to ${targetSymbol}`,
        file,
        line: start.line + 1,
        character: start.character + 1,
        confidence: 0.7,
      },
    ],
  }
}

function enclosingCFunction(source: string, zeroBasedLine: number, zeroBasedCharacter: number) {
  const offsets = lineStartOffsets(source)
  const referenceOffset = (offsets[zeroBasedLine] ?? 0) + zeroBasedCharacter
  const signaturePattern = /(?:^|\n)\s*(?:[A-Za-z_][\w\s*]*\s+)+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*\{/g
  let best: { symbol: string; line: number; character: number } | undefined
  for (let match = signaturePattern.exec(source); match; match = signaturePattern.exec(source)) {
    const symbol = match[1] ?? ""
    if (!symbol || C_CONTROL_KEYWORDS.has(symbol)) continue
    const openBrace = source.indexOf("{", match.index)
    if (openBrace < 0 || openBrace >= referenceOffset) continue
    const closeBrace = matchingCloseBrace(source, openBrace)
    if (closeBrace === undefined || referenceOffset >= closeBrace) continue
    const symbolOffset = match.index + match[0].lastIndexOf(symbol)
    const position = positionFromOffset(offsets, symbolOffset)
    best = { symbol, line: position.line + 1, character: position.character + 1 }
  }
  return best
}

const C_CONTROL_KEYWORDS = new Set(["if", "for", "while", "switch", "return", "sizeof"])

function lineStartOffsets(source: string) {
  const offsets = [0]
  for (let index = 0; index < source.length; index++) if (source[index] === "\n") offsets.push(index + 1)
  return offsets
}

function positionFromOffset(offsets: number[], offset: number) {
  let line = 0
  for (let index = 1; index < offsets.length && offsets[index] <= offset; index++) line = index
  return { line, character: offset - (offsets[line] ?? 0) }
}

function matchingCloseBrace(source: string, openBrace: number) {
  let depth = 0
  for (let index = openBrace; index < source.length; index++) {
    if (source[index] === "{") depth++
    else if (source[index] === "}") {
      depth--
      if (depth === 0) return index
    }
  }
  return undefined
}

function isRegistrationReference(source: string, zeroBasedLine: number, symbol: string) {
  return Boolean(registrationReferenceOperation(source, zeroBasedLine, symbol))
}

function registrationReferenceOperation(
  source: string,
  zeroBasedLine: number,
  symbol: string,
): RegistrationOperation | undefined {
  const lines = source.split(/\r?\n/)
  const line = lines[zeroBasedLine] ?? ""
  if (!new RegExp(`\\b${escapeRegex(symbol)}\\b`).test(line)) return undefined
  const window = lines.slice(Math.max(0, zeroBasedLine - 8), Math.min(lines.length, zeroBasedLine + 9)).join("\n")
  const statement = registrationStatementWindow(lines, zeroBasedLine)
  if (/\b(?:WMI_)?DISPATCH_ENTRY\b/.test(window) && /\{[^}]*,/.test(line)) return "registration"
  if (/\bWMI_DECLARE_DISPATCH_TABLE/.test(window) && /\{[^}]*,/.test(line)) return "registration"
  const api = /\b([A-Za-z_]\w*(?:register|Register|attach|Attach|install|Install)[A-Za-z0-9_]*)\s*\(/.exec(
    statement,
  )?.[1]
  if (!api) return undefined
  if (/(?:^|_)(?:unregister|deregister|detach|remove|disable)/i.test(api)) return "deregistration"
  return "registration"
}

function registrationStatementWindow(lines: string[], zeroBasedLine: number) {
  if (/;\s*$/.test(lines[zeroBasedLine] ?? "")) return lines[zeroBasedLine] ?? ""
  let start = zeroBasedLine
  for (let line = zeroBasedLine - 1; line >= Math.max(0, zeroBasedLine - 8); line--) {
    const text = lines[line] ?? ""
    if (/;\s*$/.test(text) || /\{\s*$/.test(text) || /\}\s*$/.test(text)) break
    start = line
  }
  let end = zeroBasedLine
  for (let line = zeroBasedLine + 1; line < Math.min(lines.length, zeroBasedLine + 8); line++) {
    const text = lines[line] ?? ""
    if (/\}\s*$/.test(text) || /\{\s*$/.test(text)) break
    end = line
    if (/;\s*$/.test(text)) break
  }
  return lines.slice(start, end + 1).join("\n")
}

function registrationRuntimeDispatchInfo(source: string, zeroBasedLine: number, symbol: string) {
  if (!isRegistrationReference(source, zeroBasedLine, symbol)) return undefined
  if (isWmiDispatchRegistrationReference(source, zeroBasedLine, symbol)) {
    return {
      symbol: "wmi_dispatch_cmd",
      label: "Host WMI command dispatch",
      detail: `host WMI command dispatch via ${symbol} dispatch-table registration`,
      confidence: 0.7,
    }
  }
  const lines = source.split(/\r?\n/)
  const statement = registrationStatementWindow(lines, zeroBasedLine)
  const api = /\b([A-Za-z_]\w*(?:register|Register|attach|Attach|install|Install)[A-Za-z0-9_]*)\s*\(/.exec(
    statement,
  )?.[1]
  if (!api || registrationReferenceOperation(source, zeroBasedLine, symbol) !== "registration") return undefined
  if (/^wal_phy_dev_register_event_handler$/.test(api)) {
    return {
      symbol: "wal_phy_dev_event_dispatch",
      label: "WAL pdev event dispatch",
      detail: `runtime event dispatch via ${api} registration`,
      confidence: 0.7,
    }
  }
  return {
    symbol: `${api}.runtime_dispatch`,
    label: `${api} runtime dispatch`,
    detail: `runtime dispatch via ${api} registration`,
    confidence: 0.6,
  }
}

function isWmiDispatchRegistrationReference(source: string, zeroBasedLine: number, symbol: string) {
  if (!isRegistrationReference(source, zeroBasedLine, symbol)) return false
  const lines = source.split(/\r?\n/)
  const window = lines.slice(Math.max(0, zeroBasedLine - 8), Math.min(lines.length, zeroBasedLine + 9)).join("\n")
  return /\bWMI_DISPATCH_ENTRY\b|\bWMI_DECLARE_DISPATCH_TABLE/.test(window)
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function readFile(file: string) {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

function nodeFromReference(
  reference: IntelGraphLspLocation,
  targetSymbol: string,
  defaultLanguage: IntelGraphLanguage,
  index: number,
  operation: RegistrationOperation = "registration",
): IntelGraphRelationNode {
  const file = canonicalizeIntelGraphSourcePath(uriToPath(reference.uri))
  const start = reference.range?.start
  const line = typeof start?.line === "number" ? start.line + 1 : undefined
  const character = typeof start?.character === "number" ? start.character + 1 : undefined
  const symbol = `${targetSymbol} ${operation}`
  return {
    id: relationNodeId(`${operation === "deregistration" ? "dereg" : "reg"}:${targetSymbol}`, file, line, index),
    kind: "registration",
    symbol,
    label: symbol,
    file,
    line,
    character,
    language: defaultLanguage,
    relations: createEmptyRelationMap(),
    via: [
      {
        tool: "lsp",
        detail: `reference candidate for ${targetSymbol} ${operation}`,
        file,
        line,
        character,
        confidence: 0.45,
      },
    ],
  }
}

function isSameLocation(reference: IntelGraphLspLocation, file?: string, line?: number, character?: number) {
  const refFile = uriToPath(reference.uri)
  const start = reference.range?.start
  const refLine = typeof start?.line === "number" ? start.line + 1 : undefined
  const refCharacter = typeof start?.character === "number" ? start.character + 1 : undefined
  return refFile === file && refLine === line && (character === undefined || refCharacter === character)
}

function nodeFromIncomingCall(
  call: IntelGraphLspIncomingCall,
  targetSymbol: string,
  defaultLanguage: IntelGraphLanguage,
  index: number,
  detail: string,
): IntelGraphRelationNode[] {
  const from = call.from ?? call.caller
  const symbol = canonicalizeIntelGraphSymbol(from?.name?.trim() ?? "")
  if (!symbol) return []
  const file = canonicalizeIntelGraphSourcePath(uriToPath(from?.uri))
  const start = from?.selectionRange?.start ?? from?.range?.start
  const line = typeof start?.line === "number" ? start.line + 1 : undefined
  const character = typeof start?.character === "number" ? start.character + 1 : undefined
  return [
    {
      id: relationNodeId(symbol, file, line, index),
      kind: "function",
      symbol,
      file,
      line,
      character,
      language: defaultLanguage,
      relations: createEmptyRelationMap(),
      via: [
        {
          tool: "lsp",
          detail,
          file,
          line,
          character,
          confidence: 1,
        },
      ],
    },
  ]
}

function symbolMatchFromLsp(
  row: IntelGraphLspSymbolMatch,
  fallbackSymbol: string,
  defaultLanguage: IntelGraphLanguage,
  index: number,
): IntelGraphSymbolSearchMatch {
  const symbol = row.symbol?.trim() || fallbackSymbol
  const kind = row.kind ?? "function"

  return {
    id: row.id?.trim() || relationNodeId(symbol, row.file, row.line, index),
    kind,
    symbol,
    file: row.file,
    line: row.line,
    character: row.character,
    label: row.label,
    language: row.language ?? defaultLanguage,
    score: finiteNumber(row.score),
  }
}

function relationKindsFrom(input: IntelGraphRelationRequest["kinds"]): {
  kinds: IntelGraphRelationKind[]
  diagnostics: IntelGraphDiagnostic[]
} {
  if (!Array.isArray(input) || input.length === 0) {
    return { kinds: [...IntelGraphRelationKinds], diagnostics: [] }
  }

  const kinds: IntelGraphRelationKind[] = []
  const seen = new Set<IntelGraphRelationKind>()
  const diagnostics: IntelGraphDiagnostic[] = []

  for (const raw of input as unknown[]) {
    if (isRelationKind(raw)) {
      if (!seen.has(raw)) {
        seen.add(raw)
        kinds.push(raw)
      }
      continue
    }
    diagnostics.push({
      code: "unsupported_relation_kind",
      message: `Relation kind \"${String(raw)}\" is not supported`,
      severity: "warn",
      tool: "resolver",
    })
  }

  return { kinds, diagnostics }
}

function isRelationKind(value: unknown): value is IntelGraphRelationKind {
  return typeof value === "string" && (IntelGraphRelationKinds as readonly string[]).includes(value)
}

function uriToPath(uri: unknown) {
  if (typeof uri !== "string") return undefined
  if (!uri.startsWith("file://")) return uri || undefined
  try {
    return decodeURIComponent(uri.replace(/^file:\/\//, ""))
  } catch {
    return uri.replace(/^file:\/\//, "")
  }
}

function fallbackSymbolFromLocation(file?: string, line?: number) {
  if (!file) return "(unknown)"
  return typeof line === "number" ? `${file}:${Math.max(1, Math.trunc(line))}` : file
}

function relationNodeId(symbol: string, file?: string, line?: number, suffix?: number) {
  const location = file ? `@${file}${typeof line === "number" ? `:${Math.max(1, Math.trunc(line))}` : ""}` : ""
  return `fn:${symbol}${location}${suffix === undefined ? "" : `#${suffix}`}`
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function clamp(value: unknown, fallback: number, min: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(value)))
}
