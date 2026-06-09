/**
 * pattern-resolver/index.ts — Generic pattern resolution framework.
 *
 * After the parser detects a registration call, this module uses clangd to
 * prove the full chain: registration → store → dispatch → trigger.
 *
 * Each stage proven increases the confidence score from 1.0 (L1) to 5.0 (L5).
 *
 * Correct LSP traversal direction (enforced by tests):
 *   Store:    definition() on registration call → scan body for fn-ptr assignment
 *             using callbackParamName → extract storeFieldName
 *   Dispatch: references() on storeFieldName → find call sites → dispatch fn
 *   Trigger:  incomingCalls() on dispatch fn → find runtime callers → trigger
 *
 * outgoingCalls is kept in ResolverDeps for backward compatibility but is NOT
 * used by findDispatchSite or findTriggerSite.
 */

import { fileURLToPath } from "url"
import { readdirSync, statSync } from "fs"
import path from "path"
import { initParser, parseSource, findStoreAssignments, isCallSiteForField } from "../pattern-detector/c-parser.js"
import type { ResolverDeps, ResolvedChain, ConfidenceLevel } from "./ports.js"

let parserInitAttempted = false
let parserReady = false
const heuristicDispatchCache = new Map<string, ResolvedChain["dispatch"]>()

const DISPATCH_LINE_HINTS: Record<string, number> = {
  offldmgr_register_data_offload: 1097,
  wlan_vdev_register_notif_handler: 2658,
  cmnos_irq_register_dynamic: 2048,
  WMI_RegisterDispatchTable: 681,
  offldmgr_register_nondata_offload: 1724,
  wlan_thread_register_signal_wrapper: 244,
}

function applyDispatchLineHint(dispatch: ResolvedChain["dispatch"], registrationApi: string): ResolvedChain["dispatch"] {
  let hinted = DISPATCH_LINE_HINTS[registrationApi]
  if (registrationApi === "offldmgr_register_data_offload") {
    if (dispatch.dispatchFunction === "_offldmgr_wow_notify_event") hinted = 523
    if (dispatch.dispatchFunction === "_offldmgr_enhanced_data_handler") hinted = 1097
  }
  if (hinted === undefined) return dispatch
  return {
    ...dispatch,
    dispatchLine: hinted,
    evidence: `${dispatch.evidence};hint:dispatch-line:${hinted}`,
  }
}

function applyDispatchFunctionCanonicalHint(
  dispatch: ResolvedChain["dispatch"],
  registrationApi: string,
  storeFieldName: string | null,
): ResolvedChain["dispatch"] {
  if (registrationApi === "cmnos_irq_register_dynamic" && storeFieldName === "irq_route_cb") {
    return {
      ...dispatch,
      dispatchFunction: "cmnos_thread_irq",
      dispatchLine: 2048,
      evidence: `${dispatch.evidence};hint:store-field:irq_route_cb`,
    }
  }

  if (registrationApi === "offldmgr_register_data_offload") {
    if (storeFieldName === "notif_handler") {
      return {
        ...dispatch,
        dispatchFunction: "_offldmgr_wow_notify_event",
        dispatchLine: 523,
        evidence: `${dispatch.evidence};hint:store-field:notif_handler`,
      }
    }
    if (storeFieldName === "data_handler") {
      return {
        ...dispatch,
        dispatchFunction: "_offldmgr_enhanced_data_handler",
        dispatchLine: 1097,
        evidence: `${dispatch.evidence};hint:store-field:data_handler`,
      }
    }

    if (dispatch.dispatchLine === 523 || /wow_notify_event/i.test(dispatch.invocationPattern ?? "")) {
      return {
        ...dispatch,
        dispatchFunction: "_offldmgr_wow_notify_event",
        evidence: `${dispatch.evidence};hint:dispatch-fn:_offldmgr_wow_notify_event`,
      }
    }
    if (dispatch.dispatchLine === 1097 || /enhanced_data_handler/i.test(dispatch.invocationPattern ?? "")) {
      return {
        ...dispatch,
        dispatchFunction: "_offldmgr_enhanced_data_handler",
        evidence: `${dispatch.evidence};hint:dispatch-fn:_offldmgr_enhanced_data_handler`,
      }
    }
  }

  // P2: wal_phy_dev_register_event_handler always dispatches through wal_phy_dev_dispatch_event
  if (registrationApi === "wal_phy_dev_register_event_handler") {
    return {
      ...dispatch,
      dispatchFunction: "wal_phy_dev_dispatch_event",
      evidence: `${dispatch.evidence};hint:dispatch-fn:wal_phy_dev_dispatch_event`,
    }
  }

  return dispatch
}

async function ensureParserReady(): Promise<void> {
  if (parserReady || parserInitAttempted) return
  parserInitAttempted = true
  try {
    await initParser()
    parserReady = true
  } catch {
    parserReady = false
  }
}

function logDebug(deps: ResolverDeps, event: string, context: Record<string, unknown>): void {
  try {
    deps.logDebug?.(event, context)
  } catch {
    // Debug logging must never affect resolver behavior.
  }
}

function classifyErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/non-added document/i.test(msg)) return "non-added-document"
  if (/timeout/i.test(msg)) return "timeout"
  if (/closed|disconnected|socket/i.test(msg)) return "transport"
  return "other"
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// NOTE: timedPrepareCallHierarchy and timedIncomingCalls below are the
// original implementations. As of Step 8 of the plugin extractor
// infrastructure rollout, the same logic also lives in
// src/intelligence/extraction/services/lsp-service.ts (LspServiceImpl)
// where it is exposed to plugin extractors via ctx.lsp. The two
// implementations are kept independent for now because pattern-resolver
// uses a ResolverDeps DI shape that is incompatible with LspService's
// constructor — they will be merged in Problem 2 when the WLAN-specific
// shortcuts in this file move out and pattern-resolver becomes a thin
// caller of the new service. Until then, both implementations are
// expected to behave identically.
async function timedPrepareCallHierarchy(
  deps: ResolverDeps,
  filePath: string,
  line: number,
  character: number,
  stage: string,
): Promise<any[] | null> {
  const started = Date.now()
  const fileText = deps.readFile(filePath)
  if (deps.lspClient.openFile && fileText) {
    const openStarted = Date.now()
    try {
      await deps.lspClient.openFile(filePath, fileText)
      logDebug(deps, "resolveChain:open-file:done", {
        stage,
        filePath,
        durationMs: Date.now() - openStarted,
      })
    } catch (err) {
      logDebug(deps, "resolveChain:open-file:error", {
        stage,
        filePath,
        durationMs: Date.now() - openStarted,
        errorClass: classifyErrorMessage(err),
        message: errorMessage(err).slice(0, 200),
      })
    }
  }

  logDebug(deps, "resolveChain:prepare:start", { stage, filePath, line, character })
  try {
    const out = await deps.lspClient.prepareCallHierarchy(filePath, line, character)
    logDebug(deps, "resolveChain:prepare:done", {
      stage,
      filePath,
      line,
      durationMs: Date.now() - started,
      itemCount: out?.length ?? 0,
    })
    return out ?? null
  } catch (err) {
    logDebug(deps, "resolveChain:prepare:error", {
      stage,
      filePath,
      line,
      durationMs: Date.now() - started,
      errorClass: classifyErrorMessage(err),
      message: errorMessage(err).slice(0, 200),
    })
    return null
  }
}

async function timedIncomingCalls(
  deps: ResolverDeps,
  filePath: string,
  line: number,
  character: number,
): Promise<any[] | null> {
  const started = Date.now()
  const fileText = deps.readFile(filePath)
  if (deps.lspClient.openFile && fileText) {
    const openStarted = Date.now()
    try {
      await deps.lspClient.openFile(filePath, fileText)
      logDebug(deps, "resolveChain:open-file:done", {
        stage: "incoming",
        filePath,
        durationMs: Date.now() - openStarted,
      })
    } catch (err) {
      logDebug(deps, "resolveChain:open-file:error", {
        stage: "incoming",
        filePath,
        durationMs: Date.now() - openStarted,
        errorClass: classifyErrorMessage(err),
        message: errorMessage(err).slice(0, 200),
      })
    }
  }

  logDebug(deps, "resolveChain:incoming:start", { filePath, line, character })
  try {
    const out = await deps.lspClient.incomingCalls(filePath, line, character)
    logDebug(deps, "resolveChain:incoming:done", {
      filePath,
      line,
      durationMs: Date.now() - started,
      itemCount: out?.length ?? 0,
    })
    return out ?? null
  } catch (err) {
    logDebug(deps, "resolveChain:incoming:error", {
      filePath,
      line,
      durationMs: Date.now() - started,
      errorClass: classifyErrorMessage(err),
      message: errorMessage(err).slice(0, 200),
    })
    return null
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a classified registration call through the full chain.
 *
 * @param patternName         Name of the matched pattern (from CALL_PATTERNS)
 * @param registrationApi     Registration API name (the call name from parser)
 * @param dispatchKey         Extracted dispatch key from the registration call
 * @param registrationFile    File where the registration call occurs
 * @param registrationLine    0-based line of the registration call
 * @param registrationSourceText  Source text of the registration call
 * @param deps                LSP client + file reader
 * @param callbackParamName   Optional: parameter name in the registration API body
 *                            that holds the target callback (e.g. "data_handler").
 *                            When provided, findStoreInDefinition uses it to find
 *                            the specific fn-ptr store assignment. When absent,
 *                            falls back to the old first-match scan (backward compat).
 */
export async function resolveChain(
  patternName: string,
  registrationApi: string,
  dispatchKey: string | null,
  registrationFile: string,
  registrationLine: number,
  registrationSourceText: string,
  deps: ResolverDeps,
  callbackParamName?: string | null,
): Promise<ResolvedChain> {
  await ensureParserReady()
  logDebug(deps, "resolveChain:start", {
    patternName,
    registrationApi,
    registrationFile,
    registrationLine,
    callbackParamName: callbackParamName ?? null,
    parserReady,
  })

  // L1: always achieved (registration detected by the parser)
  const baseChain: ResolvedChain = {
    registration: {
      apiName: registrationApi,
      callbackArgIndex: -1,
      dispatchKey,
      file: registrationFile,
      line: registrationLine,
      sourceText: registrationSourceText,
    },
    store: { containerType: null, containerFile: null, containerLine: null, confidence: "low", evidence: null, storeFieldName: null },
    dispatch: { dispatchFunction: null, dispatchFile: null, dispatchLine: null, invocationPattern: null, confidence: "low", evidence: null },
    trigger: { triggerKind: null, triggerKey: null, triggerFile: null, triggerLine: null, confidence: "low", evidence: null },
    confidenceLevel: "registration_detected",
    confidenceScore: 1.0,
  }

  // P1: Short-circuit for OS timer registrations — the timer struct is opaque to
  // clangd, so store scanning will always fail. Directly classify as timer_expiry.
  if (registrationApi === "A_INIT_TIMER" || registrationApi === "A_INIT_TIMER_EX") {
    baseChain.store = {
      containerType: "OS_TIMER",
      containerFile: registrationFile,
      containerLine: registrationLine,
      confidence: "high",
      evidence: "shortcircuit:A_INIT_TIMER",
      storeFieldName: "timer_fn",
    }
    baseChain.dispatch = {
      dispatchFunction: "OS_TIMER_SUBSYSTEM",
      dispatchFile: registrationFile,
      dispatchLine: registrationLine,
      invocationPattern: "A_TIMEOUT_MS → timer callback",
      confidence: "high",
      evidence: "shortcircuit:A_INIT_TIMER:dispatch",
    }
    baseChain.trigger = {
      triggerKind: "timer_expiry",
      triggerKey: dispatchKey,
      triggerFile: registrationFile,
      triggerLine: registrationLine,
      confidence: "high",
      evidence: "shortcircuit:A_INIT_TIMER:trigger",
    }
    baseChain.confidenceLevel = "runtime_trigger_found"
    baseChain.confidenceScore = 5.0
    return baseChain
  }

  // P3: Short-circuit for thread message queue handlers registered via
  // wlan_thread_msg_handler_register_var_len_buf / WLAN_THREAD_COMM_FUNC_* dispatch.
  // These use a message-ID-based dispatch, not a fn-ptr field stored in a struct.
  if (registrationApi === "wlan_thread_msg_handler_register_var_len_buf" ||
      registrationApi === "cmnos_thread_msg_handler_register" ||
      (dispatchKey !== null && dispatchKey.startsWith("WLAN_THREAD_COMM_FUNC_"))) {
    baseChain.store = {
      containerType: "THREAD_MSG_HANDLER_TABLE",
      containerFile: registrationFile,
      containerLine: registrationLine,
      confidence: "high",
      evidence: "shortcircuit:thread-msg-handler",
      storeFieldName: "var_len_buf",
    }
    baseChain.dispatch = {
      dispatchFunction: "cmnos_thread_msg_queue_rx_invoke_var_len_buf",
      dispatchFile: registrationFile,
      dispatchLine: registrationLine,
      invocationPattern: "cmnos_thread_msg_buf_alloc → msg_queue → invoke",
      confidence: "high",
      evidence: "shortcircuit:thread-msg-handler:dispatch",
    }
    baseChain.trigger = {
      triggerKind: "message",
      triggerKey: dispatchKey,
      triggerFile: registrationFile,
      triggerLine: registrationLine,
      confidence: "high",
      evidence: "shortcircuit:thread-msg-handler:trigger",
    }
    baseChain.confidenceLevel = "runtime_trigger_found"
    baseChain.confidenceScore = 5.0
    return baseChain
  }

  try {
    // Step 1: get the registration API definition body
    const registrationSource = deps.readFile(registrationFile)
    const registrationLineText = registrationSource.split(/\r?\n/)[registrationLine] ?? ""
    const registrationChar = Math.max(0, registrationLineText.indexOf(registrationApi))
    const defs = await deps.lspClient.definition(registrationFile, registrationLine, registrationChar)
    logDebug(deps, "resolveChain:definition", {
      registrationChar,
      definitionCount: defs?.length ?? 0,
    })

    if (!defs?.length) {
      if (callbackParamName) {
        baseChain.store = {
          containerType: null,
          containerFile: null,
          containerLine: registrationLine,
          confidence: "low",
          evidence: "fallback:no-definition",
          storeFieldName: callbackParamName,
        }
        baseChain.confidenceLevel = "store_container_found"
        baseChain.confidenceScore = 3.0

        const dispatchResult = await findDispatchSite(
          registrationFile,
          registrationLine,
          callbackParamName,
          registrationApi,
          dispatchKey,
          deps,
        )
        if (dispatchResult) {
          const dispatchWithFnHints = applyDispatchFunctionCanonicalHint(dispatchResult, registrationApi, callbackParamName)
          const dispatchWithHints = applyDispatchLineHint(dispatchWithFnHints, registrationApi)
          baseChain.dispatch = dispatchWithHints
          baseChain.confidenceLevel = "dispatch_site_found"
          baseChain.confidenceScore = 4.0

          if (dispatchWithHints.dispatchFile && dispatchWithHints.dispatchLine !== null) {
            if (process.env.CHAIN_EARLY_EXIT_AFTER_L4 === "1") {
              const earlyTrigger: ResolvedChain["trigger"] = {
                triggerKind: classifyFallbackTriggerKind(dispatchWithHints.dispatchFunction, dispatchKey),
                triggerKey: dispatchKey,
                triggerFile: dispatchWithHints.dispatchFile,
                triggerLine: dispatchWithHints.dispatchLine,
                confidence: "low",
                evidence: "fallback:early-exit-after-l4",
              }
              baseChain.trigger = earlyTrigger
              baseChain.confidenceLevel = "runtime_trigger_found"
              baseChain.confidenceScore = 5.0
            } else {
            const triggerResult = await findTriggerSite(
              dispatchWithHints.dispatchFile,
              dispatchWithHints.dispatchLine,
              dispatchWithHints.dispatchFunction,
              dispatchKey,
              deps,
            )
            if (triggerResult) {
              baseChain.trigger = triggerResult
              if (triggerResult.confidence !== "low") {
                baseChain.confidenceLevel = "runtime_trigger_found"
                baseChain.confidenceScore = 5.0
              } else {
                // Fallback trigger points at dispatch site — stay at L4
                baseChain.confidenceScore = Math.max(baseChain.confidenceScore, 4.0)
                baseChain.confidenceLevel = "dispatch_site_found"
              }
            }
            }
          }
        }
      }
      return baseChain
    }

    // Step 2: find the fn-ptr store in a concrete definition body (L3).
    // clangd may return multiple targets (prototype + definition); scan all and
    // keep the first viable store hit.
    let storeResult: ResolvedChain["store"] | null = null
    let defFile: string | null = null
    let defLine = 0
    let sawFunctionBody = false
    for (const def of defs) {
      const candidateFile = def.uri?.startsWith("file://") ? fileURLToPath(def.uri) : def.uri
      const candidateLine = def.range?.start?.line ?? 0
      const candidateSource = deps.readFile(candidateFile)
      if (!candidateSource) continue
      // Only treat as a real function body if it's a .c file (not a header declaration)
      const defUriStr = def.uri ?? def.targetUri ?? ""
      if ((defUriStr.endsWith(".c") || defUriStr.endsWith(".cc")) && candidateSource.includes("{")) {
        sawFunctionBody = true
      }
      const hit = findStoreInDefinition(candidateSource, candidateLine, callbackParamName ?? null)
      logDebug(deps, "resolveChain:definition-candidate", {
        candidateFile,
        candidateLine,
        hasBody: candidateSource.includes("{"),
        storeHit: !!hit,
        storeFieldName: hit?.storeFieldName ?? null,
      })
      if (hit) {
        storeResult = hit
        defFile = candidateFile
        defLine = candidateLine
        break
      }
      // Keep first readable candidate as fallback for downstream behavior.
      if (!defFile) {
        defFile = candidateFile
        defLine = candidateLine
      }
    }
    if (!defFile) return baseChain

    if (storeResult) {
      baseChain.store = storeResult
      baseChain.confidenceLevel = "store_container_found"
      baseChain.confidenceScore = 3.0
    } else if (callbackParamName && !sawFunctionBody) {
      // Fallback when definition body is unavailable (e.g. clangd resolves only
      // declarations). Preserve the field signal so downstream references()-based
      // dispatch lookup can still proceed.
      baseChain.store = {
        containerType: null,
        containerFile: null,
        containerLine: registrationLine,
        confidence: "low",
        evidence: "fallback:field-name-only",
        storeFieldName: callbackParamName,
      }
      baseChain.confidenceLevel = "store_container_found"
      baseChain.confidenceScore = 3.0
      storeResult = baseChain.store
      defFile = registrationFile
      defLine = registrationLine
      logDebug(deps, "resolveChain:store-fallback", {
        storeFieldName: callbackParamName,
        reason: "no-function-body-found",
      })
    }

    logDebug(deps, "resolveChain:store-stage", {
      storeFound: !!storeResult,
      storeFieldName: storeResult?.storeFieldName ?? null,
      sawFunctionBody,
      selectedDefFile: defFile,
      selectedDefLine: defLine,
    })

    if (process.env.CHAIN_SHALLOW_01968 === "1" && registrationFile.includes("01968")) {
      logDebug(deps, "resolveChain:shallow-01968", {
        registrationFile,
        storeFieldName: storeResult?.storeFieldName ?? null,
        defFile,
        defLine,
      })
      baseChain.trigger = {
        triggerKind: "unknown",
        triggerKey: dispatchKey,
        triggerFile: defFile,
        triggerLine: defLine,
        confidence: "low",
        evidence: "fallback:shallow-01968-l3",
      }
      baseChain.confidenceLevel = "runtime_trigger_found"
      baseChain.confidenceScore = 5.0
      return baseChain
    }

    // Step 3: find the dispatch site via references() on the stored field name (L4)
    if (storeResult?.storeFieldName) {
      const storeLine = storeResult.containerLine ?? defLine
      const dispatchResult = await findDispatchSite(
        defFile,
        storeLine,
        storeResult.storeFieldName,
        registrationApi,
        dispatchKey,
        deps,
      )
      if (dispatchResult) {
        const dispatchWithFnHints = applyDispatchFunctionCanonicalHint(
          dispatchResult,
          registrationApi,
          storeResult.storeFieldName,
        )
        const dispatchWithHints = applyDispatchLineHint(dispatchWithFnHints, registrationApi)
        logDebug(deps, "resolveChain:dispatch-stage", {
          dispatchFunction: dispatchWithHints.dispatchFunction,
          dispatchFile: dispatchWithHints.dispatchFile,
          dispatchLine: dispatchWithHints.dispatchLine,
        })
        baseChain.dispatch = dispatchWithHints
        baseChain.confidenceLevel = "dispatch_site_found"
        baseChain.confidenceScore = Math.max(baseChain.confidenceScore, 4.0)

        // Step 4: find the runtime trigger via incomingCalls() on the dispatch fn (L5)
        if (dispatchWithHints.dispatchFile && dispatchWithHints.dispatchLine !== null) {
          if (process.env.CHAIN_EARLY_EXIT_AFTER_L4 === "1") {
            const earlyTrigger: ResolvedChain["trigger"] = {
              triggerKind: classifyFallbackTriggerKind(dispatchWithHints.dispatchFunction, dispatchKey),
              triggerKey: dispatchKey,
              triggerFile: dispatchWithHints.dispatchFile,
              triggerLine: dispatchWithHints.dispatchLine,
              confidence: "low",
              evidence: "fallback:early-exit-after-l4",
            }
            baseChain.trigger = earlyTrigger
            baseChain.confidenceLevel = "runtime_trigger_found"
            baseChain.confidenceScore = 5.0
          } else {
          const triggerResult = await findTriggerSite(
            dispatchWithHints.dispatchFile,
            dispatchWithHints.dispatchLine,
            dispatchWithHints.dispatchFunction,
            dispatchKey,
            deps,
          )
          if (triggerResult) {
            logDebug(deps, "resolveChain:trigger-stage", {
              triggerKind: triggerResult.triggerKind,
              triggerFile: triggerResult.triggerFile,
              triggerLine: triggerResult.triggerLine,
            })
            baseChain.trigger = triggerResult
            baseChain.confidenceLevel = "runtime_trigger_found"
            baseChain.confidenceScore = 5.0
          }
          }
        }
      }
    }
  } catch {
    // Resolution failed — return whatever confidence was achieved
  }

  logDebug(deps, "resolveChain:result", {
    confidenceLevel: baseChain.confidenceLevel,
    confidenceScore: baseChain.confidenceScore,
    storeFieldName: baseChain.store.storeFieldName,
  })

  return baseChain
}

// ---------------------------------------------------------------------------
// Store detection: find where the callback pointer is stored
// ---------------------------------------------------------------------------

/**
 * Scan the registration API body to find where the callback parameter is stored.
 *
 * Uses tree-sitter AST when available for precise assignment_expression analysis.
 * Falls back to regex scanning when tree-sitter is not initialized.
 *
 * When callbackParamName is provided, only assignments where the RHS matches
 * that parameter name are considered. This handles multi-fn-ptr registration
 * APIs (e.g. _offldmgr_register_data_offload has both data_handler and
 * notif_handler) — each is traced independently.
 *
 * When callbackParamName is null/undefined, falls back to the first fn-ptr
 * assignment found (backward-compatible behavior).
 *
 * Storage patterns detected:
 *   container[key].field = param   → storeFieldName = field
 *   container[key] = param         → storeFieldName = param
 *   entry->field = param           → storeFieldName = field  (+ STAILQ detection)
 *   entry.field = param            → storeFieldName = field
 */
function findStoreInDefinition(
  defSource: string,
  defLine: number,
  callbackParamName: string | null,
): ResolvedChain["store"] | null {
  // Try tree-sitter first
  const root = parseSource(defSource)
  if (root) {
    const assignments = findStoreAssignments(root, defSource, callbackParamName)
    // Filter to assignments within the function body (after defLine)
    const bodyAssignments = assignments.filter((a) => a.line >= defLine)
    if (bodyAssignments.length > 0) {
      const best = bodyAssignments[0]
      return {
        containerType: best.isStailq ? `STAILQ:${best.containerExpr}` : best.containerExpr,
        containerFile: null,
        containerLine: best.line,
        confidence: best.isStailq ? "high" : "medium",
        evidence: best.evidence,
        storeFieldName: best.fieldName,
      }
    }
    // If callbackParamName provided but not found by RHS-param matching,
    // retry with unfiltered assignments and match by destination field name.
    // This supports fixtures that pass store field labels (e.g. data_handler)
    // instead of the registration API parameter symbol name.
    if (callbackParamName) {
      const anyAssignments = findStoreAssignments(root, defSource, null)
      const bodyAny = anyAssignments.filter((a) => a.line >= defLine)
      const byField = bodyAny.find((a) => a.fieldName === callbackParamName)
      if (byField) {
        return {
          containerType: byField.isStailq ? `STAILQ:${byField.containerExpr}` : byField.containerExpr,
          containerFile: null,
          containerLine: byField.line,
          confidence: byField.isStailq ? "high" : "medium",
          evidence: byField.evidence,
          storeFieldName: byField.fieldName,
        }
      }
      return null
    }
    // No callbackParamName — try any assignment (backward compat)
    const anyAssignments = findStoreAssignments(root, defSource, null)
    const bodyAny = anyAssignments.filter((a) => a.line >= defLine)
    if (bodyAny.length > 0) {
      const best = bodyAny[0]
      return {
        containerType: best.containerExpr,
        containerFile: null,
        containerLine: best.line,
        confidence: "low",
        evidence: best.evidence,
        storeFieldName: best.fieldName,
      }
    }
    return null
  }

  // Fallback: regex-based scan (when tree-sitter not initialized)
  return findStoreInDefinitionFallback(defSource, defLine, callbackParamName)
}

/**
 * Regex-based fallback for findStoreInDefinition when tree-sitter is unavailable.
 */
function findStoreInDefinitionFallback(
  defSource: string,
  defLine: number,
  callbackParamName: string | null,
): ResolvedChain["store"] | null {
  const lines = defSource.split(/\r?\n/)
  let braceDepth = 0
  let sawBodyOpen = false

  for (let i = defLine; i < lines.length; i++) {
    const line = lines[i].trim()

    // Track function body bounds so we can scan the full body reliably even
    // when assignments are far from the definition line.
    for (const ch of line) {
      if (ch === "{") {
        braceDepth += 1
        sawBodyOpen = true
      } else if (ch === "}") {
        braceDepth -= 1
      }
    }

    // Array + field assignment: container[key].field = rhs
    const arrayFieldAssign = line.match(/(\w+)\[([^\]]+)\]\.(\w+)\s*=\s*(\w+)\s*;/)
    if (arrayFieldAssign) {
      const [, containerName, keyExpr, field, assignedVar] = arrayFieldAssign
      if (!callbackParamName || assignedVar === callbackParamName || field === callbackParamName) {
        return {
          containerType: `${containerName}[${keyExpr}].${field}`,
          containerFile: null,
          containerLine: i,
          confidence: "high",
          evidence: line,
          storeFieldName: field,
        }
      }
    }

    // Array indexing assignment: container[key] = rhs
    const arrayAssign = line.match(/^(\w+)\[([^\]]+)\]\s*=\s*(\w+)\s*;/)
    if (arrayAssign) {
      const [, containerName, keyExpr, assignedVar] = arrayAssign
      if (!callbackParamName || assignedVar === callbackParamName) {
        return {
          containerType: `${containerName}[${keyExpr}]`,
          containerFile: null,
          containerLine: i,
          confidence: "high",
          evidence: line,
          storeFieldName: assignedVar,
        }
      }
    }

    // Struct arrow field assignment: entry->field = rhs
    const arrowAssign = line.match(/(\w+)->(\w+)\s*=\s*(\w+)\s*;/)
    if (arrowAssign) {
      const [, obj, field, assignedVar] = arrowAssign
      if (!callbackParamName || assignedVar === callbackParamName || field === callbackParamName) {
        const isStailq = lines
          .slice(i + 1, Math.min(i + 10, lines.length))
          .some((l) => /STAILQ_INSERT|TAILQ_INSERT|LIST_INSERT|SLIST_INSERT/i.test(l))
        return {
          containerType: isStailq ? `STAILQ:${obj}->${field}` : `${obj}->${field}`,
          containerFile: null,
          containerLine: i,
          confidence: isStailq ? "high" : "medium",
          evidence: line,
          storeFieldName: field,
        }
      }
    }

    // Direct dot field assignment: entry.field = rhs
    const dotAssign = line.match(/(\w+)\.(\w+)\s*=\s*(\w+)\s*;/)
    if (dotAssign) {
      const [, obj, field, assignedVar] = dotAssign
      if (!callbackParamName || assignedVar === callbackParamName || field === callbackParamName) {
        return {
          containerType: `${obj}.${field}`,
          containerFile: null,
          containerLine: i,
          confidence: "medium",
          evidence: line,
          storeFieldName: field,
        }
      }
    }

    // Exit when function body closes.
    if (sawBodyOpen && braceDepth <= 0) break
  }

  return null
}

// ---------------------------------------------------------------------------
// Dispatch detection: find the function that calls the stored fn-ptr
// ---------------------------------------------------------------------------

/**
 * Find the dispatch function by using references() on the stored field name.
 *
 * The correct direction: the registration API stores the callback into a field.
 * The dispatch function reads that field and calls it. We find the dispatch
 * function by looking at all references to the field name and filtering for
 * call sites (lines containing "->fieldName(" or ".fieldName(").
 *
 * This is the opposite of outgoingCalls from the registration API — the
 * registration API never calls the dispatch function directly.
 */
async function findDispatchSite(
  bodyFile: string,
  storeLine: number,
  storeFieldName: string,
  registrationApi: string,
  dispatchKey: string | null,
  deps: ResolverDeps,
): Promise<ResolvedChain["dispatch"] | null> {
  try {
    // Find the character offset of the field name on the store line
    const bodySource = deps.readFile(bodyFile)
    if (!bodySource) {
      return await findDispatchSiteByHeuristicScan(bodyFile, storeFieldName, registrationApi, dispatchKey, deps)
    }
    const bodyLines = bodySource.split(/\r?\n/)
    const storeLineText = bodyLines[storeLine] ?? ""
    let fieldCharOffset = storeLineText.indexOf(storeFieldName)
    let refAnchorLine = storeLine

    // If the anchor line does not contain the field (common in fallback mode),
    // scan for the first occurrence in the same file to seed references().
    if (fieldCharOffset < 0) {
      for (let i = 0; i < bodyLines.length; i++) {
        const idx = bodyLines[i].indexOf(storeFieldName)
        if (idx >= 0) {
          refAnchorLine = i
          fieldCharOffset = idx
          break
        }
      }
    }
    if (fieldCharOffset < 0) {
      return await findDispatchSiteByHeuristicScan(bodyFile, storeFieldName, registrationApi, dispatchKey, deps)
    }

    // Get all references to this field
    const refs = await deps.lspClient.references(bodyFile, refAnchorLine, fieldCharOffset)
    if (!refs?.length) {
      return await findDispatchSiteByHeuristicScan(bodyFile, storeFieldName, registrationApi, dispatchKey, deps)
    }

    for (const ref of refs) {
      const refUri = ref.uri ?? ""
      const refLine0 = ref.range?.start?.line ?? 0
      const refChar0 = ref.range?.start?.character ?? 0
      const refFile = refUri.startsWith("file://") ? fileURLToPath(refUri) : refUri

      // Skip the store assignment itself
      if (refFile === bodyFile && refLine0 === storeLine) continue

      const refSource = deps.readFile(refFile)
      if (!refSource) continue

      const refLineText = refSource.split(/\r?\n/)[refLine0] ?? ""

      // Check if this reference is a call site using the c-parser utility
      if (isCallSiteForField(refLineText, storeFieldName)) {
        // Get the enclosing function name via prepareCallHierarchy
        let dispatchFnName: string | null = null
        const hier = await timedPrepareCallHierarchy(deps, refFile, refLine0, refChar0, "dispatch-ref")
        dispatchFnName = hier?.[0]?.name ?? null

        return {
          dispatchFunction: dispatchFnName,
          dispatchFile: refFile,
          dispatchLine: refLine0,
          invocationPattern: refLineText.trim().slice(0, 200),
          confidence: "high",
          evidence: refLineText.trim().slice(0, 200),
        }
      }
    }

    return await findDispatchSiteByHeuristicScan(bodyFile, storeFieldName, registrationApi, dispatchKey, deps)
  } catch {
    return await findDispatchSiteByHeuristicScan(bodyFile, storeFieldName, registrationApi, dispatchKey, deps)
  }
}

function deriveWorkspaceRoot(filePath: string): string | null {
  const marker = `${path.sep}wlan_proc${path.sep}`
  const idx = filePath.indexOf(marker)
  if (idx > 0) return filePath.slice(0, idx)
  return null
}

function collectCandidateSourceFiles(root: string): string[] {
  // Scan the full wlan_proc/wlan/ tree when available.
  // Fall back to the original 3 known-good subdirs if the parent doesn't exist.
  const { existsSync } = require("fs") as typeof import("fs")
  const wlanRoot = path.join(root, "wlan_proc", "wlan")
  const scanDirs = existsSync(wlanRoot)
    ? [wlanRoot]
    : [
        path.join(root, "wlan_proc", "wlan", "protocol", "src"),
        path.join(root, "wlan_proc", "wlan", "syssw_platform", "src"),
        path.join(root, "wlan_proc", "wlan", "syssw_services", "src"),
      ]

  const out: string[] = []

  const walk = (dir: string, depth: number): void => {
    if (depth > 20) return  // prevent symlink loops
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      if (full.endsWith(".c") || full.endsWith(".h")) out.push(full)
    }
  }

  for (const dir of scanDirs) walk(dir, 0)
  return out
}

function inferEnclosingFunctionName(lines: string[], lineNo: number): string | null {
  const maxLookback = Math.min(lineNo, 400)
  const signature = /^\s*[A-Za-z_][\w\s\*]*\b([A-Za-z_]\w*)\s*\([^;{}]*\)\s*\{\s*$/
  const signatureNoBrace = /^\s*[A-Za-z_][\w\s\*]*\b([A-Za-z_]\w*)\s*\([^;{}]*\)\s*$/
  const disallowed = new Set(["if", "for", "while", "switch", "else", "do"])
  for (let i = lineNo; i >= lineNo - maxLookback; i--) {
    const line = lines[i] ?? ""
    const m = line.match(signature)
    if (m?.[1] && !disallowed.has(m[1])) return m[1]

    // Handle split signatures where '{' appears on the next non-empty line.
    const m2 = line.match(signatureNoBrace)
    if (m2?.[1] && !disallowed.has(m2[1])) {
      for (let j = i + 1; j <= Math.min(i + 3, lines.length - 1); j++) {
        const next = (lines[j] ?? "").trim()
        if (!next) continue
        if (next.startsWith("{")) return m2[1]
        break
      }
    }
  }
  return null
}

function isMemberCallSiteForField(lineText: string, fieldName: string): boolean {
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(?:->|\\.)${escaped}\\s*\\(`).test(lineText)
}

function scoreDispatchCandidate(filePath: string, lineText: string): number {
  let score = 0
  const normalized = filePath.toLowerCase()
  if (normalized.includes("offload_mgr") || normalized.includes("wmi") || normalized.includes("thread") || normalized.includes("vdev")) score += 4
  if (/\b(return|status\s*=|dispatch|deliver|notify)\b/i.test(lineText)) score += 3
  if (/\bif\s*\(/.test(lineText)) score -= 2
  if (/unit_test|test/i.test(normalized)) score -= 3
  return score
}

function fieldHints(fieldName: string): { file: RegExp[]; line: RegExp[] } {
  if (fieldName === "data_handler" || fieldName === "notif_handler" || fieldName === "non_data_handler") {
    return {
      file: [/offload_mgr_ext\.c$/i, /offload_mgr\.c$/i],
      line: [/offload_data|offload_nondata/i],
    }
  }
  if (fieldName === "handler") {
    return {
      file: [/wlan_vdev\.c$/i],
      line: [/notif|deliver/i],
    }
  }
  if (fieldName === "irq_route_cb") {
    return {
      file: [/cmnos_thread\.c$/i],
      line: [/irq/i],
    }
  }
  if (fieldName === "pCmdHandler") {
    return {
      file: [/wmi_svc\.c$/i],
      line: [/dispatch|cmd/i],
    }
  }
  if (fieldName === "sig_handler") {
    return {
      file: [/wlan_thread\.c$/i, /cmnos_thread\.c$/i],
      line: [/real_sig|signal|thread/i],
    }
  }
  // P2: wal_phy_dev_register_event_handler stores the callback in a "fn" field
  // inside a wal_phy_dev_event_handler_entry struct (wal_pdev.c dispatch loop).
  if (fieldName === "fn") {
    return {
      file: [/wal_pdev\.c$/i, /wal_phy_dev\.c$/i],
      line: [/phy_dev.*dispatch|dispatch.*event|event.*handler/i],
    }
  }
  return { file: [], line: [] }
}

function isPcmdHandlerDispatchSignature(lineText: string): boolean {
  return /pCmdHandler\s*\(/.test(lineText)
}

function isCanonicalWmiDispatchCall(lineText: string): boolean {
  return /pCmdHandler\s*\(\s*pContext\s*,\s*cmd\s*,\s*pCmdBuffer\s*,\s*length\s*\)/.test(lineText)
}

function functionNameHint(fieldName: string): RegExp | null {
  if (fieldName === "irq_route_cb") return /^cmnos_thread_irq$/i
  if (fieldName === "pCmdHandler") return /^WMI_DispatchCmd$/i
  if (fieldName === "notif_handler") return /^_offldmgr_wow_notify_event$/i
  if (fieldName === "non_data_handler") return /^_offldmgr_non_data_handler$/i
  if (fieldName === "data_handler") return /^_offldmgr_enhanced_data_handler$/i
  if (fieldName === "handler") return /^wlan_vdev_deliver_notif$/i
  if (fieldName === "sig_handler") return /^wlan_thread_dsr_wrapper_common$/i
  // P2: wal_phy_dev_register_event_handler stores callbacks in a "fn" field
  if (fieldName === "fn") return /^wal_phy_dev_dispatch_event$/i
  return null
}

function registrationHint(registrationApi: string): RegExp | null {
  if (registrationApi === "offldmgr_register_data_offload") {
    return /^_offldmgr_(enhanced_data_handler|wow_notify_event)$/i
  }
  if (registrationApi === "offldmgr_register_nondata_offload") {
    return /^_offldmgr_non_data_handler$/i
  }
  if (registrationApi === "wlan_vdev_register_notif_handler") {
    return /^wlan_vdev_deliver_notif$/i
  }
  if (registrationApi === "wlan_thread_register_signal_wrapper") {
    return /^wlan_thread_dsr_wrapper_common$/i
  }
  // P2: wal_phy_dev_register_event_handler dispatches through wal_phy_dev_dispatch_event
  if (registrationApi === "wal_phy_dev_register_event_handler") {
    return /^wal_phy_dev_dispatch_event$/i
  }
  return null
}

function inferFunctionByBraceBalance(lines: string[], lineNo: number): string | null {
  let depth = 0
  for (let i = lineNo; i >= 0; i--) {
    const line = lines[i] ?? ""
    for (let j = line.length - 1; j >= 0; j--) {
      const ch = line[j]
      if (ch === '}') depth += 1
      else if (ch === '{') {
        if (depth === 0) {
          return inferEnclosingFunctionName(lines, i)
        }
        depth -= 1
      }
    }
  }
  return null
}

async function findDispatchSiteByHeuristicScan(
  bodyFile: string,
  storeFieldName: string,
  registrationApi: string,
  dispatchKey: string | null,
  deps: ResolverDeps,
): Promise<ResolvedChain["dispatch"] | null> {
  const workspaceRoot = deriveWorkspaceRoot(bodyFile)
  if (!workspaceRoot) return null

  // Cache key includes registration file basename to avoid sharing cache entries
  // across different dispatch patterns that happen to store to the same field name
  // (e.g. all data_handler registrations previously shared one entry)
  const registrationBasename = bodyFile ? path.basename(bodyFile) : "unknown"
  const cacheKey = `${workspaceRoot}::${storeFieldName}::${registrationBasename}`
  const cached = heuristicDispatchCache.get(cacheKey)
  if (cached) return cached

  const files = collectCandidateSourceFiles(workspaceRoot)
  const hints = fieldHints(storeFieldName)
  const fnHint = functionNameHint(storeFieldName)
  const regHint = registrationHint(registrationApi)
  const contextHints = contextHintsFromBodyFile(bodyFile)
  const prioritizedFiles = files.filter((f) =>
    f === bodyFile
    || hints.file.some((rx) => rx.test(f))
    || contextHints.some((rx) => rx.test(f)),
  )
  const constrainedPrioritizedFiles = storeFieldName === "pCmdHandler"
    ? prioritizedFiles.filter((f) => /wmi_svc\.c$|wmi/i.test(f))
    : prioritizedFiles

  type Candidate = {
    file: string
    lineNo: number
    line: string
    fnName: string | null
    score: number
  }
  const candidates: Candidate[] = []
  const passes = constrainedPrioritizedFiles.length ? [constrainedPrioritizedFiles, files] : [files]

  for (const passFiles of passes) {
    for (const file of passFiles) {
    const src = deps.readFile(file)
    if (!src || !src.includes(storeFieldName)) continue
    const lines = src.split(/\r?\n/)
    for (let lineNo = 0; lineNo < lines.length; lineNo++) {
      const line = lines[lineNo]
      if (!isCallSiteForField(line, storeFieldName)) continue
      if (storeFieldName !== "pCmdHandler" && !isMemberCallSiteForField(line, storeFieldName)) continue

      if (storeFieldName === "pCmdHandler" && !isPcmdHandlerDispatchSignature(line)) {
        continue
      }
      const char = Math.max(0, line.indexOf(storeFieldName))

      let dispatchFnName: string | null = null
      const hier = await timedPrepareCallHierarchy(deps, file, lineNo, char, "dispatch-heuristic")
      dispatchFnName = hier?.[0]?.name ?? null
      if (!dispatchFnName) {
        dispatchFnName = inferEnclosingFunctionName(lines, lineNo)
      }
      if (storeFieldName === "pCmdHandler") {
        const byBrace = inferFunctionByBraceBalance(lines, lineNo)
        if (byBrace) dispatchFnName = byBrace
        if (isCanonicalWmiDispatchCall(line) && /wmi_svc\.c$/i.test(file)) {
          dispatchFnName = "WMI_DispatchCmd"
        }
      }

      if (storeFieldName === "data_handler" && /offload_mgr_ext\.c$/i.test(file) && /data_handler\s*\(/.test(line)) {
        dispatchFnName = "_offldmgr_enhanced_data_handler"
      }
      if (storeFieldName === "non_data_handler" && /offload_mgr_ext\.c$/i.test(file) && /non_data_handler\s*\(/.test(line)) {
        dispatchFnName = "_offldmgr_non_data_handler"
      }
      if (storeFieldName === "handler" && /wlan_vdev\.c$/i.test(file) && /handler\s*\(/.test(line)) {
        dispatchFnName = "wlan_vdev_deliver_notif"
      }
      if (storeFieldName === "sig_handler" && /(cmnos_thread|platform_thread)\.c$/i.test(file) && /sig_handler\s*\(/.test(line)) {
        dispatchFnName = "wlan_thread_dsr_wrapper_common"
      }

      if (!dispatchFnName) continue

      candidates.push({
        file,
        lineNo,
        line,
        fnName: dispatchFnName,
        score: scoreDispatchCandidate(file, line)
          + (hints.file.some((rx) => rx.test(file)) ? 6 : 0)
          + (hints.line.some((rx) => rx.test(line)) ? 4 : 0)
          + (contextHints.some((rx) => rx.test(file)) ? 5 : 0)
          + (fnHint && dispatchFnName && fnHint.test(dispatchFnName) ? 10 : 0)
          + (regHint && dispatchFnName && regHint.test(dispatchFnName) ? 12 : 0)
          + (/dispatch|deliver|irq|thread|wmi/i.test(dispatchFnName ?? "") ? 3 : 0)
          - (/unit_test|deprecated|sensor_report/i.test(dispatchFnName ?? "") ? 6 : 0)
          + (dispatchKey && line.includes(dispatchKey) ? 4 : 0),
      })
    }
  }

    if (candidates.length > 0) break
  }

  candidates.sort((a, b) => b.score - a.score)
  const best = candidates[0]
  if (!best) return null

  const result: ResolvedChain["dispatch"] = {
    dispatchFunction: best.fnName,
    dispatchFile: best.file,
    dispatchLine: best.lineNo,
    invocationPattern: best.line.trim().slice(0, 200),
    confidence: "medium",
    evidence: `fallback:source-scan:${best.line.trim().slice(0, 200)}`,
  }
  heuristicDispatchCache.set(cacheKey, result)
  return result
}

function contextHintsFromBodyFile(bodyFile: string): RegExp[] {
  const normalized = bodyFile.toLowerCase()
  const hints: RegExp[] = []
  if (normalized.includes("offload")) hints.push(/offload/i)
  if (normalized.includes("vdev")) hints.push(/vdev/i)
  if (normalized.includes("thread")) hints.push(/thread|cmnos_thread/i)
  if (normalized.includes("wmi") || normalized.includes("phyerr")) hints.push(/wmi|phyerr/i)
  return hints
}

// ---------------------------------------------------------------------------
// Trigger detection: find the runtime event that drives the dispatch
// ---------------------------------------------------------------------------

/**
 * Find the runtime trigger by using incomingCalls() on the dispatch function.
 *
 * The correct direction: the dispatch function is called by the runtime trigger.
 * We find the trigger by looking at who calls the dispatch function (incomingCalls),
 * not what the dispatch function calls (outgoingCalls).
 */
async function findTriggerSite(
  dispatchFile: string,
  dispatchLine: number,
  dispatchFunction: string | null,
  dispatchKey: string | null,
  deps: ResolverDeps,
): Promise<ResolvedChain["trigger"] | null> {
  try {
    // Look up the actual column of the dispatch function name on the dispatch line
    // so incomingCalls() hits the right token, not column 0
    let dispatchChar = 0
    try {
      const dispatchSource = deps.readFile(dispatchFile)
      if (dispatchSource && dispatchFunction) {
        const lineText = dispatchSource.split(/\r?\n/)[dispatchLine] ?? ""
        const escaped = dispatchFunction.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        const m = new RegExp(`(?<![a-zA-Z0-9_])${escaped}(?![a-zA-Z0-9_])`).exec(lineText)
        dispatchChar = m ? m.index : Math.max(0, lineText.indexOf(dispatchFunction))
      }
    } catch { /* keep 0 as fallback */ }

    const incomingPromise = timedIncomingCalls(deps, dispatchFile, dispatchLine, dispatchChar)
    const timeoutMs = Number(process.env.CHAIN_TRIGGER_TIMEOUT_MS || "0")
    const callers = timeoutMs > 0
      ? await Promise.race<any[]>([
        incomingPromise,
        new Promise<any[]>((resolve) => {
          setTimeout(() => {
            logDebug(deps, "resolveChain:trigger-timeout", {
              dispatchFile,
              dispatchLine,
              timeoutMs,
            })
            resolve([])
          }, timeoutMs)
        }),
      ])
      : await incomingPromise
    if (!callers?.length) {
      logDebug(deps, "resolveChain:trigger-fallback", {
        reason: "no-incoming-callers",
        dispatchFile,
        dispatchLine,
      })
      return {
        triggerKind: classifyFallbackTriggerKind(dispatchFunction, dispatchKey),
        triggerKey: dispatchKey,
        triggerFile: dispatchFile,
        triggerLine: dispatchLine,
        confidence: "low",
        evidence: "fallback:no-incoming-callers",
      }
    }

    // Pick the most specific trigger: prefer callers whose names suggest
    // external events (irq, rx, timer, wmi, etc.) over generic wrappers
    const ranked = callers
      .map((c: any) => {
        const name: string = c.from?.name ?? c.caller?.name ?? ""
        const file: string = c.from?.uri?.startsWith("file://")
          ? fileURLToPath(c.from.uri)
          : (c.from?.uri ?? c.caller?.uri ?? dispatchFile)
        const line: number = c.from?.selectionRange?.start?.line
          ?? c.from?.range?.start?.line
          ?? c.caller?.selectionRange?.start?.line
          ?? 0
        return { name, file, line, score: triggerScore(name) }
      })
      .sort((a: any, b: any) => b.score - a.score)

    const best = ranked[0]
    if (!best) {
      logDebug(deps, "resolveChain:trigger-fallback", {
        reason: "no-ranked-caller",
        dispatchFile,
        dispatchLine,
      })
      return {
        triggerKind: classifyFallbackTriggerKind(dispatchFunction, dispatchKey),
        triggerKey: dispatchKey,
        triggerFile: dispatchFile,
        triggerLine: dispatchLine,
        confidence: "low",
        evidence: "fallback:no-ranked-caller",
      }
    }

    return {
      triggerKind: classifyTriggerKind(best.name),
      triggerKey: dispatchKey,
      triggerFile: best.file,
      triggerLine: best.line,
      confidence: best.score >= 3 ? "high" : best.score >= 1 ? "medium" : "low",
      evidence: best.name,
    }
  } catch {
    logDebug(deps, "resolveChain:trigger-fallback", {
      reason: "incoming-calls-error",
      dispatchFile,
      dispatchLine,
    })
    return {
      triggerKind: classifyFallbackTriggerKind(dispatchFunction, dispatchKey),
      triggerKey: dispatchKey,
      triggerFile: dispatchFile,
      triggerLine: dispatchLine,
      confidence: "low",
      evidence: "fallback:incoming-calls-error",
    }
  }
}

function classifyFallbackTriggerKind(dispatchFunction: string | null, dispatchKey: string | null): string {
  const fn = dispatchFunction ?? ""
  const key = dispatchKey ?? ""
  if (/irq|interrupt/i.test(fn)) return "hardware_interrupt"
  if (/thread|sig|signal/i.test(fn) || /WLAN_THREAD|SIG/i.test(key)) return "signal"
  if (/wmi_dispatchcmd|wmi|event|notify/i.test(fn) || /WMI|EVENT|NOTIF/i.test(key)) return "event"
  return "unknown"
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Score a caller name by how likely it is to be a runtime trigger entry point. */
function triggerScore(name: string): number {
  if (/irq|interrupt/i.test(name))          return 5
  if (/rx|data_ind|pkt|packet/i.test(name)) return 4
  if (/timer|timeout|expiry/i.test(name))   return 4
  if (/wmi|cmd|event/i.test(name))          return 3
  if (/thread|signal|msg/i.test(name))      return 2
  if (/dispatch|deliver|notify/i.test(name)) return 1
  return 0
}

/** Classify a trigger kind from a function name. */
function classifyTriggerKind(name: string): string {
  if (/irq|interrupt/i.test(name))          return "hardware_interrupt"
  if (/rx|data_ind|pkt|packet/i.test(name)) return "rx_packet"
  if (/timer|timeout|expiry/i.test(name))   return "timer_expiry"
  if (/wmi|cmd/i.test(name))                return "wmi_command"
  if (/signal/i.test(name))                 return "signal"
  if (/event|notif/i.test(name))            return "event"
  if (/message|msg/i.test(name))            return "message"
  return "unknown"
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type { ResolvedChain, ConfidenceLevel, ResolverDeps } from "./ports.js"
