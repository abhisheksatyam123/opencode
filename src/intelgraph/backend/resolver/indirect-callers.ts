import {
  createEmptyRelationMap,
  type IntelGraphDiagnostic,
  type IntelGraphLanguage,
  type IntelGraphRelationNode,
  type IntelGraphRelationRequest,
} from "../../contract"
import { isIntelGraphPrimarySourcePath } from "../source-path-policy"
import type {
  IntelGraphLspIncomingCall,
  IntelGraphLspIndirectCaller,
  IntelGraphLspLike,
  IntelGraphLspLocation,
} from "./dynamic-resolver"

const INDIRECT_PROVIDER_TIMEOUT_MS = 2000

export async function resolveIndirectRegisteredCallers(
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
          message: "indirect_registered_callers requires a file and line for dynamic lookup",
          severity: "warn",
          tool: "resolver",
          file: request.file,
          line: request.line,
          character: request.character,
        },
      ],
    }
  }
  if (lsp.indirectCallers) {
    return resolveWithIndirectProvider(lsp, request, symbol, defaultLanguage, limit)
  }

  if (!lsp.references || !lsp.incomingCalls) {
    return {
      nodes: [],
      diagnostics: [
        {
          code: "lsp_indirect_lookup_unavailable",
          message: "indirect_registered_callers requires LSP reference and incoming-call support",
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
    const callers: IntelGraphRelationNode[] = []
    const seen = new Set<string>()
    for (const reference of references.filter(
      (item) => !isSameLocation(item, request.file, request.line, request.character),
    )) {
      if (callers.length >= limit) break
      const refFile = uriToPath(reference.uri)
      const refLine = typeof reference.range?.start?.line === "number" ? reference.range.start.line + 1 : undefined
      const refCharacter =
        typeof reference.range?.start?.character === "number" ? reference.range.start.character + 1 : undefined
      if (!refFile || !refLine) continue
      const incoming = await lsp.incomingCalls({
        file: refFile,
        line: refLine,
        character: refCharacter,
        symbol,
        limit: Math.max(1, limit - callers.length),
      })
      for (const node of incoming.flatMap((call, index) =>
        nodeFromIncomingCall(
          call,
          symbol,
          defaultLanguage,
          callers.length + index,
          `incoming call through registration candidate for ${symbol}`,
        ),
      )) {
        const key = callerSemanticKey(node)
        if (seen.has(key) || callers.length >= limit) continue
        seen.add(key)
        callers.push(node)
      }
    }
    return {
      nodes: callers,
      diagnostics: [
        {
          code: "indirect_callers_lsp_candidate_mode",
          message:
            "indirect_registered_callers uses LSP reference candidates; tree-sitter dispatch-chain classification is the next refinement",
          severity: "info",
          tool: "lsp",
          file: request.file,
          line: request.line,
          character: request.character,
        },
      ],
    }
  } catch (error) {
    return {
      nodes: [],
      diagnostics: [
        {
          code: "indirect_registered_callers_failed",
          message: `indirect_registered_callers lookup failed for "${symbol}"`,
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

async function resolveWithIndirectProvider(
  lsp: IntelGraphLspLike,
  request: IntelGraphRelationRequest,
  symbol: string,
  defaultLanguage: IntelGraphLanguage,
  limit: number,
): Promise<{ nodes: IntelGraphRelationNode[]; diagnostics: IntelGraphDiagnostic[] }> {
  try {
    const entries = await withTimeout(
      lsp.indirectCallers!({
        file: request.file!,
        line: request.line!,
        character: request.character,
        symbol,
        limit,
      }),
      INDIRECT_PROVIDER_TIMEOUT_MS,
      `indirect_registered_callers timed out for "${symbol}"`,
    )
    const runtimeEntries = entries.filter(
      (entry) => entry.callerRole === "runtime_caller" && isIntelGraphPrimarySourcePath(entry.file),
    )
    const registrarCount = entries.filter(
      (entry) => entry.callerRole === "registrar" && isIntelGraphPrimarySourcePath(entry.file),
    ).length
    const nodes = runtimeEntries
      .slice(0, limit)
      .map((entry, index) => nodeFromIndirectCaller(entry, defaultLanguage, index))
    const diagnostics: IntelGraphDiagnostic[] = [
      {
        code: "indirect_callers_runtime_resolver",
        message: "indirect_registered_callers used the migrated LSP + C parser dispatch-chain resolver",
        severity: "info",
        tool: "lsp",
        file: request.file,
        line: request.line,
        character: request.character,
      },
    ]
    if (registrarCount > 0) {
      diagnostics.push({
        code: nodes.length > 0 ? "indirect_callers_registrars_filtered" : "indirect_callers_registrar_only",
        message:
          nodes.length > 0
            ? `${registrarCount} registration-only candidate(s) were kept out of indirect_registered_callers`
            : `${registrarCount} registration-only candidate(s) found, but no runtime dispatch caller was proven`,
        severity: nodes.length > 0 ? "info" : "warn",
        tool: "resolver",
        file: request.file,
        line: request.line,
        character: request.character,
      })
    }
    return { nodes, diagnostics }
  } catch (error) {
    return {
      nodes: [],
      diagnostics: [
        {
          code: "indirect_registered_callers_failed",
          message: `indirect_registered_callers lookup failed for "${symbol}"`,
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

function nodeFromIndirectCaller(
  entry: IntelGraphLspIndirectCaller,
  defaultLanguage: IntelGraphLanguage,
  index: number,
): IntelGraphRelationNode {
  const detail = entry.registrationApi
    ? `runtime caller via ${entry.registrationApi}${entry.invocationType ? ` (${entry.invocationType})` : ""}`
    : entry.detail || "runtime indirect caller"
  return {
    id: relationNodeId(entry.symbol, entry.file, entry.line, index),
    kind: "function",
    symbol: entry.symbol,
    file: entry.file,
    line: entry.line,
    character: entry.character,
    language: defaultLanguage,
    relations: createEmptyRelationMap(),
    via: [
      {
        tool: "lsp",
        detail,
        file: entry.file,
        line: entry.line,
        character: entry.character,
        confidence: entry.confidence,
      },
    ],
  }
}

function nodeFromIncomingCall(
  call: IntelGraphLspIncomingCall,
  targetSymbol: string,
  defaultLanguage: IntelGraphLanguage,
  index: number,
  detail: string,
): IntelGraphRelationNode[] {
  const from = call.from ?? call.caller
  const symbol = from?.name?.trim()
  if (!symbol) return []
  const file = uriToPath(from?.uri)
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

function callerSemanticKey(node: IntelGraphRelationNode) {
  return [node.symbol, node.file ?? "", node.line ?? ""].join("|")
}

function isSameLocation(reference: IntelGraphLspLocation, file?: string, line?: number, character?: number) {
  const refFile = uriToPath(reference.uri)
  const start = reference.range?.start
  const refLine = typeof start?.line === "number" ? start.line + 1 : undefined
  const refCharacter = typeof start?.character === "number" ? start.character + 1 : undefined
  return refFile === file && refLine === line && (character === undefined || refCharacter === character)
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

function relationNodeId(symbol: string, file?: string, line?: number, suffix?: number) {
  const location = file ? `@${file}${typeof line === "number" ? `:${Math.max(1, Math.trunc(line))}` : ""}` : ""
  return `fn:${symbol}${location}${suffix === undefined ? "" : `#${suffix}`}`
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
