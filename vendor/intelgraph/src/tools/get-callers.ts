/**
 * get-callers.ts — Unified single-endpoint caller resolution.
 *
 * Runs the full caller-resolution waterfall internally and returns a single
 * structured JSON response. Frontends call ONE tool instead of orchestrating
 * 5 different tools with fallback logic.
 *
 * Waterfall (highest quality first):
 *   1. lsp_runtime_flow      — LLM/cache-based runtime invoker (best quality, needs LLM config)
 *   2. who_calls_api_at_runtime — DB runtime graph (needs intelligence snapshot)
 *   3. who_calls_api         — DB static graph (needs intelligence snapshot)
 *   4. lsp_indirect_callers  — LSP + C parser dispatch chain (resolve:true)
 *   5. lsp_incoming_calls    — Direct callers only (always available)
 *
 * Name-alias handling: DB queries are tried with canonical name AND common
 * C firmware alias variants (_foo, __foo, foo___RAM, _foo___RAM, foo___ROM, _foo___ROM).
 */

import type { ILanguageClient } from "../lsp/ports.js"
import type { IndexTracker } from "../tracking/index.js"
import type { UnifiedBackend } from "../backend/unified-backend.js"
import type { OrchestratorRunnerDeps } from "../intelligence/contracts/orchestrator-runner-deps.js"
type ExecuteOrchestratedQuery = typeof import("../intelligence/public-api.js")["executeOrchestratedQuery"]
import { buildRuntimeFlowPayload } from "./reason-engine/runtime-flow-output.js"
import { readReasoningConfig } from "./reason-engine/reason-config.js"
import { prepareReasonQuery } from "./reason-engine/reason-query.js"
import type { ILogger } from "../logging/ports.js"
import { loggerPort } from "../logging/logger.js"
import { fileURLToPath } from "url"


async function executeIntelligenceQuery(...args: Parameters<ExecuteOrchestratedQuery>): ReturnType<ExecuteOrchestratedQuery> {
  const { executeOrchestratedQuery } = await import("../intelligence/public-api.js")
  return executeOrchestratedQuery(...args) as ReturnType<ExecuteOrchestratedQuery>
}

// ── Response types ────────────────────────────────────────────────────────────

/**
 * The role of a caller entry — the key distinction the frontend needs.
 *
 *   runtime_caller  — this function ACTUALLY INVOKES the target at runtime
 *                     (via direct call, fn-ptr dispatch, timer callback, etc.)
 *   registrar       — this function REGISTERS the target as a callback/handler
 *                     but does NOT call it directly at runtime
 *   direct_caller   — direct static call (always a runtime caller)
 *
 * Frontends MUST show only runtime_caller and direct_caller entries.
 * Registrar entries are context only — they explain HOW the target got wired in,
 * but they are NOT the function that invokes the target at runtime.
 */
export type CallerRole = "runtime_caller" | "registrar" | "direct_caller"

export type CallerInvocationType =
  | "runtime_direct_call"
  | "runtime_dispatch_table_call"
  | "runtime_callback_registration_call"
  | "runtime_function_pointer_call"
  | "interface_registration"   // registrar — NOT a runtime caller
  | "direct_call"
  | "unknown"

export interface CallerEntry {
  /** Canonical function name of the caller / runtime invoker */
  name: string
  /** Absolute file path (empty string if not available) */
  filePath: string
  /** 1-based line number (0 if not available) */
  lineNumber: number
  /**
   * Role of this entry — use this to decide what to show in the UI.
   *   runtime_caller  → show in the callers tree
   *   direct_caller   → show in the callers tree
   *   registrar       → show only as context (viaRegistrationApi), NOT as a caller
   */
  callerRole: CallerRole
  /** How this function invokes the target (detail within the role) */
  invocationType: CallerInvocationType
  /** Confidence score 0–1 */
  confidence: number
  /**
   * Registration API that wired the fn-ptr (if indirect).
   * Present when callerRole=runtime_caller and the call is indirect.
   * Also present when callerRole=registrar (the registrar IS this function).
   */
  viaRegistrationApi?: string
  /** Which waterfall step produced this entry */
  source: WaterfallStep
}

export type WaterfallStep =
  | "lsp_runtime_flow"
  | "intelligence_query_runtime"
  | "intelligence_query_static"
  | "lsp_indirect_callers"
  | "lsp_incoming_calls"

export interface GetCallersResponse {
  /** Resolved target API name */
  targetApi: string
  /** Absolute file path of the target */
  targetFile: string
  /** 1-based line of the target */
  targetLine: number
  /**
   * Runtime callers and direct callers — the functions that ACTUALLY INVOKE
   * the target at runtime. These are what the frontend should display.
   * callerRole is always "runtime_caller" or "direct_caller" here.
   */
  callers: CallerEntry[]
  /**
   * Registration APIs — functions that WIRED the target as a callback/handler
   * but do NOT call it directly at runtime.
   * callerRole is always "registrar" here.
   * Show these as context (e.g. "registered via X") but NOT as callers in the tree.
   */
  registrars: CallerEntry[]
  /**
   * Which waterfall step produced the final callers list.
   * "none" means all steps failed or returned empty.
   */
  source: WaterfallStep | "none"
  provenance: {
    /** All steps that were attempted, in order */
    stepsAttempted: WaterfallStep[]
    /** The step whose results are in `callers` */
    stepUsed: WaterfallStep | "none"
    /** Whether alias variants were tried for DB queries */
    aliasVariantsTriedForDb: boolean
    /** Alias variants that were tried (if any) */
    aliasVariantsTried: string[]
    /** Optional actionable diagnostic when DB snapshot appears empty/uningested. */
    diagnostic?: {
      code: "empty_ready_snapshot_suspected"
      path: "ingest_remediation_required"
      message: string
      remediation: string
      snapshotId: number
    }
  }
}

// ── Alias variant helpers ─────────────────────────────────────────────────────

/**
 * Canonicalize a C symbol name by stripping leading underscores and ___RAM suffixes.
 * wlan_bpf_filter_offload_handler___RAM → wlan_bpf_filter_offload_handler
 * _wlan_bpf_filter_offload_handler      → wlan_bpf_filter_offload_handler
 */
export function canonicalizeSymbol(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return trimmed
  let canonical = trimmed
  canonical = canonical.replace(/^_+/, "")
  canonical = canonical.replace(/___[A-Za-z0-9_]+$/, "")
  return canonical || trimmed
}

function preferSrcPath(path: string): string {
  const p = path.trim()
  if (!p) return p
  let out = p.replace(/\\/g, "/")
  out = out.replace(/\/(rom\/[^/]+|v[0-9]+rom|ramv[0-9]+)\/(patch|orig)\//g, "/src/")
  out = out.replace(/\/(rom\/[^/]+|v[0-9]+rom|ramv[0-9]+)\//g, "/src/")
  out = out.replace(/_patch(?=\.[^.\/]+$)/, "")
  return out
}

/**
 * Build all alias variants of a symbol name for DB lookup.
 * Returns canonical name first, then variants.
 */
export function symbolAliasVariants(name: string): string[] {
  const canonical = canonicalizeSymbol(name)
  const variants = new Set<string>([canonical])
  variants.add(`_${canonical}`)
  variants.add(`__${canonical}`)
  variants.add(`${canonical}___RAM`)
  variants.add(`_${canonical}___RAM`)
  variants.add(`${canonical}___ROM`)
  variants.add(`_${canonical}___ROM`)
  if (name !== canonical) variants.add(name)
  return [...variants]
}

// ── Waterfall implementation ──────────────────────────────────────────────────

export async function resolveCallers(
  client: ILanguageClient,
  tracker: IndexTracker,
  backend: UnifiedBackend | null,
  intelligenceDeps: OrchestratorRunnerDeps | null,
  args: {
    file: string
    line: number
    apiName?: string
    character: number
    snapshotId?: number
    maxNodes?: number
    resolve?: boolean
  },
  logger?: ILogger,
): Promise<GetCallersResponse> {
  const log = logger ?? loggerPort
  const maxNodes = args.maxNodes ?? 50
  const shouldResolve = args.resolve ?? true
  const stepsAttempted: WaterfallStep[] = []
  const aliasVariantsTried: string[] = []
  let dbRuntimeStatus: "hit" | "enriched" | "llm_fallback" | "not_found" | "error" | null = null
  let dbStaticStatus: "hit" | "enriched" | "llm_fallback" | "not_found" | "error" | null = null

  // ── Step 0: resolve target symbol name via prepareCallHierarchy ──────────────
  let targetApi = args.apiName ? canonicalizeSymbol(args.apiName) : ""
  let targetFile = args.file
  let targetLine = args.line

  if (!targetApi) {
    try {
      const seedItems = await client.prepareCallHierarchy(args.file, args.line - 1, args.character - 1)
      const seed = seedItems?.[0]
      if (seed) {
        targetApi = canonicalizeSymbol(seed.name ?? "")
        targetFile = seed.uri?.startsWith("file://") ? fileURLToPath(seed.uri) : (seed.uri ?? args.file)
        targetLine = (seed.selectionRange?.start?.line ?? seed.range?.start?.line ?? args.line - 1) + 1
      }
    } catch {
      // proceed with file/line as-is
    }
  }

  // Fallback: use hover to get symbol name
  if (!targetApi) {
    try {
      const hover = await client.hover(args.file, args.line - 1, args.character - 1)
      const hoverText = typeof hover?.contents === "string"
        ? hover.contents
        : hover?.contents?.value ?? ""
      const match = hoverText.match(/(?:function|method|void|int|bool|static)\s+(\w+)/i)
      if (match) targetApi = canonicalizeSymbol(match[1]!)
    } catch { /* ignore */ }
  }

  if (!targetApi) targetApi = `symbol@${args.file}:${args.line}`

  if (!shouldResolve) {
    stepsAttempted.push("lsp_incoming_calls")
    try {
      const results = await client.incomingCalls(args.file, args.line - 1, args.character - 1)
      if (results?.length) {
        const callers = incomingCallsToCallers(results, "lsp_incoming_calls")
        log.info("get_callers: lsp_incoming_calls direct mode succeeded", { targetApi, callerCount: callers.length })
        return buildResponse(targetApi, targetFile, targetLine, callers, "lsp_incoming_calls", stepsAttempted, false, [])
      }
    } catch (err) {
      log.debug("get_callers: lsp_incoming_calls direct mode failed", { error: String(err) })
    }
    return buildResponse(targetApi, targetFile, targetLine, [], "none", stepsAttempted, false, [])
  }

  let dbLookupsAttempted = false
  const tryDbCallerLookups = async (): Promise<GetCallersResponse | null> => {
    if (dbLookupsAttempted || !intelligenceDeps || !args.snapshotId || args.snapshotId <= 0) return null
    dbLookupsAttempted = true
    const variants = symbolAliasVariants(targetApi)
    aliasVariantsTried.push(...variants)

    // who_calls_api_at_runtime — single query matching all alias variants
    stepsAttempted.push("intelligence_query_runtime")
    try {
      const res = await executeIntelligenceQuery(
        {
          intent: "who_calls_api_at_runtime",
          snapshotId: args.snapshotId,
          apiName: canonicalizeSymbol(targetApi),
          apiNameAliases: variants,
          limit: maxNodes,
        },
        intelligenceDeps,
      )
      dbRuntimeStatus = res.status
      if ((res.status === "hit" || res.status === "enriched") && res.data.nodes.length > 0) {
        const callers = dbRuntimeNodesToCallers(res.data.nodes, "intelligence_query_runtime")
        if (callers.length > 0) {
          log.info("get_callers: intelligence_query_runtime succeeded", { targetApi, callerCount: callers.length })
          return buildResponse(targetApi, targetFile, targetLine, callers, "intelligence_query_runtime", stepsAttempted, true, aliasVariantsTried)
        }
      }
    } catch (err) {
      log.debug("get_callers: intelligence_query_runtime failed", { error: String(err) })
    }

    // who_calls_api — static graph fallback matching all alias variants
    stepsAttempted.push("intelligence_query_static")
    try {
      const res = await executeIntelligenceQuery(
        {
          intent: "who_calls_api",
          snapshotId: args.snapshotId,
          apiName: canonicalizeSymbol(targetApi),
          apiNameAliases: variants,
          limit: maxNodes,
        },
        intelligenceDeps,
      )
      dbStaticStatus = res.status
      if ((res.status === "hit" || res.status === "enriched") && res.data.nodes.length > 0) {
        const callers = dbStaticNodesToCallers(res.data.nodes, res.data.edges ?? [], targetApi, "intelligence_query_static")
        if (callers.length > 0) {
          log.info("get_callers: intelligence_query_static succeeded", { targetApi, callerCount: callers.length })
          return buildResponse(targetApi, targetFile, targetLine, callers, "intelligence_query_static", stepsAttempted, true, aliasVariantsTried)
        }
      }
    } catch (err) {
      log.debug("get_callers: intelligence_query_static failed", { error: String(err) })
    }

    return null
  }

  // Explicit API-name queries often target code hidden behind current compile flags;
  // use the indexed snapshot first so callers still resolve when clangd cannot.
  if (args.apiName) {
    const dbResult = await tryDbCallerLookups()
    if (dbResult) return dbResult
  }

  // ── Step 1: lsp_runtime_flow (LLM/cache) ─────────────────────────────────────
  if (backend) {
    stepsAttempted.push("lsp_runtime_flow")
    try {
      const reasoningConfig = readReasoningConfig(client.root)
      const prepared = await prepareReasonQuery(backend, client, {
        file: args.file,
        line: args.line,
        character: args.character,
        targetSymbol: targetApi,
      })
      const result = await backend.reasonEngine.run(
        client,
        {
          targetSymbol: prepared.symbol || targetApi,
          targetFile: args.file,
          targetLine: args.line,
          knownEvidence: prepared.knownEvidence,
          suspectedPatterns: [],
        },
        reasoningConfig,
      )
      const payload = buildRuntimeFlowPayload(prepared.symbol || targetApi, result)
      const callers = await runtimeFlowToCallers(payload, "lsp_runtime_flow", client)
      if (callers.length > 0) {
        log.info("get_callers: lsp_runtime_flow succeeded", { targetApi, callerCount: callers.length })
        return buildResponse(targetApi, targetFile, targetLine, callers, "lsp_runtime_flow", stepsAttempted, false, [])
      }
    } catch (err) {
      log.debug("get_callers: lsp_runtime_flow failed", { error: String(err) })
    }
  }

  // ── Step 2 + 3: intelligence_query (DB) with alias variants ──────────────────
  const dbResult = await tryDbCallerLookups()
  if (dbResult) return dbResult

  // ── Step 4: lsp_indirect_callers (LSP + C parser, resolve:true) ──────────────
  if (backend) {
    stepsAttempted.push("lsp_indirect_callers")
    try {
      const graph = await backend.patterns.collectIndirectCallers(client, {
        file: args.file,
        line: args.line,
        character: args.character,
        maxNodes,
        resolve: shouldResolve,
      })
      if (graph.nodes.length > 0) {
        const allEntries = indirectGraphToCallers(graph, "lsp_indirect_callers")
        // Only return early if there are actual runtime/direct callers, not just registrars.
        // If only registrars are present, fall through to step 5 (direct incomingCalls).
        const actualCallers = allEntries.filter(e =>
          e.callerRole === "runtime_caller" || e.callerRole === "direct_caller"
        )
        if (actualCallers.length > 0) {
          log.info("get_callers: lsp_indirect_callers succeeded", { targetApi, callerCount: actualCallers.length })
          return buildResponse(targetApi, targetFile, targetLine, allEntries, "lsp_indirect_callers", stepsAttempted, false, [])
        }
      }
    } catch (err) {
      log.debug("get_callers: lsp_indirect_callers failed", { error: String(err) })
    }
  }

  // ── Step 5: lsp_incoming_calls (direct callers only, always available) ────────
  stepsAttempted.push("lsp_incoming_calls")
  try {
    const results = await client.incomingCalls(args.file, args.line - 1, args.character - 1)
    if (results?.length) {
      const callers = incomingCallsToCallers(results, "lsp_incoming_calls")
      log.info("get_callers: lsp_incoming_calls succeeded", { targetApi, callerCount: callers.length })
      return buildResponse(targetApi, targetFile, targetLine, callers, "lsp_incoming_calls", stepsAttempted, false, [])
    }
  } catch (err) {
    log.debug("get_callers: lsp_incoming_calls failed", { error: String(err) })
  }

  // All steps failed or returned empty
  if (intelligenceDeps && args.snapshotId && args.snapshotId > 0 && dbRuntimeStatus === "not_found" && dbStaticStatus === "not_found") {
    const diag = await detectEmptyReadySnapshotDiagnostic(intelligenceDeps, args.snapshotId)
    if (diag) {
      log.warn("get_callers: empty-ready-snapshot suspected", {
        targetApi,
        snapshotId: args.snapshotId,
        diagnosticCode: diag.code,
      })
      return buildResponse(targetApi, targetFile, targetLine, [], "none", stepsAttempted, aliasVariantsTried.length > 0, aliasVariantsTried, diag)
    }
  }
  log.warn("get_callers: all steps returned empty", { targetApi, stepsAttempted })
  return buildResponse(targetApi, targetFile, targetLine, [], "none", stepsAttempted, aliasVariantsTried.length > 0, aliasVariantsTried)
}

async function detectEmptyReadySnapshotDiagnostic(
  intelligenceDeps: OrchestratorRunnerDeps,
  snapshotId: number,
): Promise<GetCallersResponse["provenance"]["diagnostic"] | undefined> {
  try {
    const probe = await executeIntelligenceQuery(
      {
        intent: "show_hot_call_paths",
        snapshotId,
        limit: 1,
      },
      intelligenceDeps,
    )
    const hasRows = probe.data.nodes.length > 0 || probe.data.edges.length > 0
    if (probe.status !== "not_found" || hasRows) return undefined
    return {
      code: "empty_ready_snapshot_suspected",
      path: "ingest_remediation_required",
      message: "Snapshot is queryable but has zero graph coverage for runtime/static callers.",
      remediation: "Re-run intelligence ingest for this workspace and commit a fresh snapshot before calling get_callers.",
      snapshotId,
    }
  } catch {
    return undefined
  }
}

// ── Adapter functions ─────────────────────────────────────────────────────────

/** Derive callerRole from invocationType — single source of truth. */
function roleFromInvocationType(invocationType: CallerInvocationType): CallerRole {
  switch (invocationType) {
    case "runtime_direct_call":
    case "runtime_dispatch_table_call":
    case "runtime_callback_registration_call":
    case "runtime_function_pointer_call":
      return "runtime_caller"
    case "direct_call":
      return "direct_caller"
    case "interface_registration":
      return "registrar"
    case "unknown":
    default:
      // "unknown" means we couldn't classify the invocation type — safer to treat as
      // runtime_caller than to demote to registrar (which hides it in the callers list).
      return "runtime_caller"
  }
}

function isUnknownPlaceholderName(name: string): boolean {
  const n = name.trim().toLowerCase()
  return (
    !n ||
    n === "(unknown)" ||
    n === "unknown" ||
    n === "(unknown-registrar)" ||
    n === "unknown-registrar" ||
    n.includes("unknown registrar")
  )
}

/**
 * Extract a clean C function name from an immediateInvoker string.
 * The LLM sometimes sets immediateInvoker to a function-pointer expression like
 * "p_offldmgr_ctxt->offload_data[i].data_handler(...)  [offload_mgr_ext.c:1098]"
 * instead of the containing function name "_offldmgr_enhanced_data_handler".
 *
 * Strategy:
 * 1. If the string is already a valid C identifier, use it directly.
 * 2. If it contains a function-pointer expression (-> or []), recover the
 *    containing function from the dispatchChain: find the entry immediately
 *    before the dispatch expression and extract its C function name.
 * 3. If dispatchChain is incomplete, use LSP prepareCallHierarchy on the
 *    dispatchSite to find the containing function.
 */
async function resolveImmediateInvokerName(
  immediateInvoker: string,
  dispatchChain: string[],
  dispatchSite: { file: string; line: number } | undefined,
  client: ILanguageClient | null,
): Promise<string> {
  const trimmed = immediateInvoker.trim()
  // Already a valid C identifier — use as-is
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) return trimmed

  // Looks like a function-pointer expression — recover from dispatchChain.
  // Find the index of the dispatch expression in the chain, then take the entry
  // immediately before it.
  if (dispatchChain && dispatchChain.length >= 2) {
    // Find the chain entry that matches the dispatch expression (contains -> or [...])
    const dispatchIdx = dispatchChain.findIndex(
      (e) => (e.includes("->") || e.includes("[")) && e.includes("(")
    )
    if (dispatchIdx > 0) {
      // The entry immediately before the dispatch is the containing function
      const prevEntry = (dispatchChain[dispatchIdx - 1] ?? "").trim()
      // Extract the last C identifier before any [file:line] annotation
      // Pattern: "funcname  [file.c:line]" or "funcname()  →  _funcname  [file.c:line]"
      // Prefer the part after → (resolved name), otherwise the first identifier
      const arrowMatch = prevEntry.match(/→\s*([A-Za-z_][A-Za-z0-9_]*)/)
      if (arrowMatch && arrowMatch[1]) return arrowMatch[1]
      const identMatch = prevEntry.match(/^([A-Za-z_][A-Za-z0-9_]*)/)
      if (identMatch && identMatch[1]) return identMatch[1]
    }
  }

  // LSP fallback: if we have a dispatchSite and client, query for the containing function
  if (dispatchSite && client && dispatchSite.file && dispatchSite.line > 0) {
    try {
      const items = await client.prepareCallHierarchy(dispatchSite.file, dispatchSite.line - 1, 0)
      if (items?.[0]?.name) {
        const name = canonicalizeSymbol(items[0].name)
        if (name && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          return name
        }
      }
    } catch {
      // LSP query failed, continue to last resort
    }
  }

  // Last resort: extract first C identifier from the expression itself
  const m = trimmed.match(/\b([A-Za-z_][A-Za-z0-9_]*)\b/)
  return m ? m[1] : trimmed
}

async function runtimeFlowToCallers(
  payload: import("./reason-engine/runtime-flow-output.js").RuntimeFlowPayload,
  source: WaterfallStep,
  client: ILanguageClient | null,
): Promise<CallerEntry[]> {
  const out: CallerEntry[] = []
  const seen = new Set<string>()
  for (const flow of payload.runtimeFlows) {
    if (!flow) continue
    const rawInvoker = flow.immediateInvoker ?? ""
    const name = canonicalizeSymbol(
      await resolveImmediateInvokerName(rawInvoker, flow.dispatchChain ?? [], flow.dispatchSite, client)
    )
    if (!name || isUnknownPlaceholderName(name)) continue
    const key = `${name}|runtime_direct_call`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      name,
      filePath: preferSrcPath(flow.dispatchSite?.file ?? ""),
      lineNumber: flow.dispatchSite?.line ?? 0,
      callerRole: "runtime_caller",
      invocationType: "runtime_direct_call",
      confidence: 0.9,
      source,
    })
  }
  return out
}

function dbRuntimeNodesToCallers(
  nodes: Record<string, unknown>[],
  source: WaterfallStep,
): CallerEntry[] {
  const out: CallerEntry[] = []
  const seen = new Set<string>()
  for (const n of nodes) {
    // Prefer canonical_name (flat projected row primary key) then caller as fallback
    const name = canonicalizeSymbol(String(n["canonical_name"] ?? n["caller"] ?? ""))
    if (!name) continue
    // Read invocation type from the projected classification field (most specific),
    // then fall back to edge_kind, then the legacy call_kind field.
    // Bug fix: the field was previously read as "call_kind" (always undefined on flat rows).
    const rawType = String(
      n["runtime_caller_invocation_type_classification"] ??
      n["edge_kind"] ??
      n["call_kind"] ??
      "",
    )
    // Map raw edge kind strings to CallerInvocationType
    const invocationType = dbInvocationTypeToCallerType(rawType)
    const key = `${name}|${invocationType}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      name,
      filePath: preferSrcPath(String(n["file_path"] ?? n["filePath"] ?? "")),
      lineNumber: Number(n["line_number"] ?? n["lineNumber"] ?? 0),
      callerRole: roleFromInvocationType(invocationType),
      invocationType,
      confidence: Number(n["confidence"] ?? 0.7),
      source,
    })
  }
  return out
}

function dbStaticNodesToCallers(
  nodes: Record<string, unknown>[],
  _edges: Record<string, unknown>[],  // unused: flat projected rows encode caller directly
  targetApiName: string,
  source: WaterfallStep,
): CallerEntry[] {
  // The DB returns flat projected rows where each row encodes one caller relationship:
  //   canonical_name / caller → the caller function name
  //   callee                  → the target API being queried
  //   edge_kind               → relationship type ("calls", "runtime_calls", …)
  //   file_path / line_number → caller location
  //   confidence              → edge confidence
  //   viaRegistrationApi      → registration API if edge is registers_callback
  //
  // We filter out rows where canonical_name matches the target (those are the API node
  // itself, not callers), then convert each remaining row to a CallerEntry.
  const canonical = canonicalizeSymbol(targetApiName)
  const out: CallerEntry[] = []
  const seen = new Set<string>()

  for (const n of nodes) {
    // Primary: use canonical_name (the caller's name), fall back to "caller" field
    const name = canonicalizeSymbol(String(n["canonical_name"] ?? n["caller"] ?? n["symbol"] ?? n["name"] ?? ""))
    if (!name) continue
    // Skip the target API row itself (kind='api' or name matches target)
    if (canonicalizeSymbol(String(n["callee"] ?? "")) === canonical &&
        canonicalizeSymbol(String(n["caller"] ?? "")) === canonical) continue
    // Also skip if name === target (row is the target node, not a caller)
    if (name === canonical) continue

    const edgeKind = String(n["edge_kind"] ?? n["kind"] ?? "calls")
    const invocationType = staticEdgeKindToCallerType(edgeKind)
    const callerRole = roleFromInvocationType(invocationType)
    const key = `${name}|${invocationType}`
    if (seen.has(key)) continue
    seen.add(key)

    out.push({
      name,
      filePath: preferSrcPath(String(n["file_path"] ?? n["filePath"] ?? "")),
      lineNumber: Number(n["line_number"] ?? n["lineNumber"] ?? 0),
      callerRole,
      invocationType,
      confidence: Number(n["confidence"] ?? 0.6),
      viaRegistrationApi: n["viaRegistrationApi"] ? String(n["viaRegistrationApi"]) : undefined,
      source,
    })
  }
  return out
}

function indirectGraphToCallers(
  graph: import("./indirect-callers.js").IndirectCallerGraph,
  source: WaterfallStep,
): CallerEntry[] {
  const out: CallerEntry[] = []
  const seen = new Set<string>()

  for (const node of graph.nodes) {
    // If a resolved dispatch function is available, use it as the runtime invoker
    const chain = node.resolvedChain
    if (chain?.dispatch?.dispatchFunction) {
      const name = canonicalizeSymbol(chain.dispatch.dispatchFunction)
      const key = `${name}|runtime_dispatch_table_call`
      if (!seen.has(key)) {
        seen.add(key)
        out.push({
          name,
          filePath: preferSrcPath(chain.dispatch.dispatchFile ?? node.file),
          lineNumber: chain.dispatch.dispatchLine != null ? chain.dispatch.dispatchLine + 1 : node.line,
          callerRole: "runtime_caller",
          invocationType: "runtime_dispatch_table_call",
          confidence: confidenceLevelToScore(chain.confidenceLevel),
          viaRegistrationApi: node.classification?.registrationApi ?? node.name,
          source,
        })
      }
      continue
    }

    // No dispatch resolved — emit the registrar as the best available answer.
    // callerRole=registrar so the frontend knows this is NOT the runtime invoker.
    const name = canonicalizeSymbol(node.name)
    if (!name) continue
    const invocationType = classificationToCallerType(node.classification?.connectionKind)
    const key = `${name}|${invocationType}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      name,
      filePath: preferSrcPath(node.file),
      lineNumber: node.line,
      callerRole: "registrar",
      invocationType,
      confidence: chain ? confidenceLevelToScore(chain.confidenceLevel) : 0.5,
      viaRegistrationApi: node.classification?.registrationApi,
      source,
    })
  }

  return out
}

function incomingCallsToCallers(
  results: any[],
  source: WaterfallStep,
): CallerEntry[] {
  const out: CallerEntry[] = []
  const seen = new Set<string>()

  for (const call of results) {
    const from = call.from ?? call.caller
    if (!from) continue
    const name = canonicalizeSymbol(from.name ?? "")
    if (!name) continue
    const key = `${name}|direct_call`
    if (seen.has(key)) continue
    seen.add(key)
    const uri = from.uri ?? ""
    const filePath = uri.startsWith("file://") ? fileURLToPath(uri) : uri
    const line = (from.selectionRange?.start?.line ?? from.range?.start?.line ?? 0) + 1
    out.push({
      name,
      filePath: preferSrcPath(filePath),
      lineNumber: line,
      callerRole: "direct_caller",
      invocationType: "direct_call",
      confidence: 1.0,
      source,
    })
  }
  return out
}

// ── Type mapping helpers ──────────────────────────────────────────────────────

function dbInvocationTypeToCallerType(raw: string): CallerInvocationType {
  switch (raw) {
    // Projected classification values (most specific — from orchestrator-runner projection)
    case "runtime_direct_call":                return "runtime_direct_call"
    case "runtime_callback_registration_call": return "runtime_callback_registration_call"
    case "runtime_function_pointer_call":      return "runtime_function_pointer_call"
    case "runtime_dispatch_table_call":        return "runtime_dispatch_table_call"
    // Raw edge_kind values that db-lookup emits on runtime caller rows
    case "runtime_calls":
    case "indirect_calls":                     return "runtime_function_pointer_call"
    case "registers_callback":
    case "dispatches_to":                      return "interface_registration"
    case "calls":
    case "api_call":
    case "direct_call":                        return "direct_call"
    default:                                   return "unknown"
  }
}

function staticEdgeKindToCallerType(edgeKind: string): CallerInvocationType {
  switch (edgeKind) {
    case "calls":
    case "api_call":
    case "direct_call":          return "direct_call"
    // runtime_calls is a confirmed runtime relationship — emit as runtime caller, not registrar.
    case "runtime_calls":
    case "indirect_calls":       return "runtime_function_pointer_call"
    // Registration/dispatch edges → registrar
    case "registers_callback":
    case "dispatches_to":
    case "interface_registration": return "interface_registration"
    default:                       return "unknown"
  }
}

function classificationToCallerType(connectionKind?: string): CallerInvocationType {
  switch (connectionKind) {
    case "api_call":               return "direct_call"
    case "interface_registration": return "interface_registration"
    case "hw_interrupt":           return "runtime_function_pointer_call"
    case "ring_signal":            return "runtime_function_pointer_call"
    case "timer_callback":         return "runtime_callback_registration_call"
    default:                       return "interface_registration"
  }
}

function confidenceLevelToScore(level?: string): number {
  switch (level) {
    case "high":   return 0.9
    case "medium": return 0.7
    case "low":    return 0.4
    default:       return 0.5
  }
}

// ── Response builder ──────────────────────────────────────────────────────────

function buildResponse(
  targetApi: string,
  targetFile: string,
  targetLine: number,
  allEntries: CallerEntry[],
  stepUsed: WaterfallStep | "none",
  stepsAttempted: WaterfallStep[],
  aliasVariantsTriedForDb: boolean,
  aliasVariantsTried: string[],
  diagnostic?: GetCallersResponse["provenance"]["diagnostic"],
): GetCallersResponse {
  // Split into runtime callers and registrars
  const runtimeCallers = allEntries.filter((e) => e.callerRole !== "registrar")
  const registrars = allEntries.filter((e) => e.callerRole === "registrar")

  // Sort each group by confidence descending, then by name for stability
  const sortFn = (a: CallerEntry, b: CallerEntry) =>
    b.confidence !== a.confidence ? b.confidence - a.confidence : a.name.localeCompare(b.name)

  return {
    targetApi,
    targetFile,
    targetLine,
    callers: runtimeCallers.sort(sortFn),
    registrars: registrars.sort(sortFn),
    source: stepUsed,
    provenance: {
      stepsAttempted,
      stepUsed,
      aliasVariantsTriedForDb,
      aliasVariantsTried,
      ...(diagnostic ? { diagnostic } : {}),
    },
  }
}

// ── ICallerResolver binding ──────────────────────────────────────────────────
//
// Real-implementation binding for the port declared in ./ports.ts.
// Consumers should inject an ICallerResolver rather than import
// resolveCallers directly.

import type { ICallerResolver } from "./ports.js"

export const callerResolver: ICallerResolver = {
  resolveCallers,
}
