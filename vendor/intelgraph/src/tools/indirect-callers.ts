/**
 * indirect-callers.ts — LSP evidence collector with parser-based classification.
 *
 * Strategy: use LSP to gather raw evidence (reference sites), then use the
 * C parser (findEnclosingCall) to classify each site by its enclosing call name.
 *
 * No regex line-matching. No LLM. Pure LSP + parser.
 */

import { readFileSync } from "fs"
import { fileURLToPath } from "url"
import path from "path"
import type { ILanguageClient } from "../lsp/ports.js"
import { findEnclosingCall, findEnclosingConstruct } from "./pattern-detector/index.js"
import { CALL_PATTERNS, INIT_PATTERNS, classifyGenericStructFieldCallback } from "./pattern-detector/index.js"
import { initParser } from "./pattern-detector/c-parser.js"
import type { FunctionCall } from "./pattern-detector/index.js"
import { resolveChain } from "./pattern-resolver/index.js"
import type { ResolvedChain } from "./pattern-resolver/ports.js"
import { collectAllDispatchChains } from "../plugins/clangd-core/packs/index.js"
import type { DispatchChainTemplate } from "../plugins/clangd-core/packs/types.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IndirectCallerNode {
  /** Enclosing function name at the reference site. */
  name: string
  /** Absolute file path of the enclosing function. */
  file: string
  /** 1-based line of the reference site. */
  line: number
  /** Source text of the enclosing call (from parser). */
  sourceText: string
  /** Pattern classification (null if no pattern matched). */
  classification: {
    patternName: string
    registrationApi: string
    dispatchKey: string
    connectionKind: string
  } | null
  /** Full resolved chain (registration → store → dispatch → trigger). null if not resolved. */
  resolvedChain: ResolvedChain | null
}

export interface IndirectCallerGraph {
  /** Resolved target symbol name. */
  seed: { name: string; file: string; line: number } | null
  /** All reference sites with their enclosing functions. */
  nodes: IndirectCallerNode[]
}

// ---------------------------------------------------------------------------
// LSP evidence collector (parser-based classification)
// ---------------------------------------------------------------------------

/**
 * Collect raw LSP evidence for a target symbol:
 *   1. Resolve the symbol name via prepareCallHierarchy.
 *   2. Try incomingCalls first (direct callers).
 *   3. If empty (fn-ptr callback — never called directly), fall back to
 *      textDocument/references to find argument-passing sites, then resolve
 *      the enclosing function at each site.
 *
 * At each reference site, the C parser finds the enclosing call and classifies
 * it by call name lookup in the pattern registry.
 */
export async function collectIndirectCallers(
  client: ILanguageClient,
  args: { file: string; line: number; character: number; maxNodes?: number; resolve?: boolean },
): Promise<IndirectCallerGraph> {
  // Ensure tree-sitter is initialized so the generic struct-field-callback
  // classifier can walk AST parents from initializer_list nodes. Without
  // this, findEnclosingConstruct falls back to the char-based parser which
  // does not set tsNode, and the generic classifier short-circuits.
  await initParser()

  const maxNodes = args.maxNodes ?? 50
  const shouldResolve = args.resolve ?? false
  const filePath = args.file
  const line     = args.line - 1      // 0-based for LSP
  let   charPos  = args.character - 1 // 0-based for LSP (may be refined below)

  // Open the file so clangd can parse it (required before any position queries)
  let sourceText = ""
  try {
    sourceText = readFileSafe(filePath)
    if (sourceText) {
      const isFirstOpen = await client.openFile(filePath, sourceText)
      // Always wait for the file to be ready, whether first open or re-open
      await waitForFileReady(client, filePath, 20000)
    }
  } catch { /* proceed anyway — clangd may have it indexed */ }

  // If character=1 (default), auto-detect the function name position on the line.
  // clangd's prepareCallHierarchy requires the cursor to be ON the function name token,
  // not on the return type or line start. Scanning for the identifier at the given line
  // makes the tool robust regardless of what character offset the caller passes.
  if (charPos <= 0 && sourceText) {
    const sourceLine = sourceText.split(/\r?\n/)[line] ?? ""
    const fnNameChar = findFunctionNameChar(sourceLine)
    if (fnNameChar >= 0) charPos = fnNameChar
  }

  // Step 1: resolve target symbol (with retry for background index loading)
  let seedItems: any[] | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    seedItems = await client.prepareCallHierarchy(filePath, line, charPos)
    if (seedItems?.length) break
    if (attempt < 2) await new Promise((r) => setTimeout(r, 2000))
  }
  const seed = seedItems?.[0] ?? null
  if (!seed) return { seed: null, nodes: [] }

  const seedName = seed.name ?? "(unknown)"
  const seedFile = seed.uri?.startsWith("file://")
    ? fileURLToPath(seed.uri)
    : (seed.uri ?? filePath)

  // Step 2: try direct incoming calls
  const rawCalls = await client.incomingCalls(filePath, line, charPos)
  const nodes: IndirectCallerNode[] = []

  if (rawCalls?.length) {
    for (const call of rawCalls) {
      if (nodes.length >= maxNodes) break
      const from = call.from ?? call.caller
      if (!from) continue
      const fromFile = from.uri?.startsWith("file://") ? fileURLToPath(from.uri) : (from.uri ?? "")
      const fromLine0 = from.selectionRange?.start?.line ?? from.range?.start?.line ?? 0
      const fromLine1 = fromLine0 + 1

      // Use fromRanges (actual call sites inside the enclosing function) for classification.
      // fromRanges contains the positions where the callback is referenced — these are the
      // registration call sites we want to classify, not the enclosing function definition.
      const fromRanges: Array<{ line: number; character: number }> = (call.fromRanges ?? [])
        .map((r: any) => ({ line: r.start?.line ?? 0, character: r.start?.character ?? 0 }))

      // Try each fromRange for classification; use the first that matches a pattern
      let classified = { sourceText: "", match: null as any }
      for (const refPos of fromRanges) {
        const candidate = classifyReference(fromFile, refPos.line, refPos.character, seedName)
        if (candidate.match) {
          classified = candidate
          break
        }
        // Keep the last non-empty sourceText as fallback
        if (candidate.sourceText && !classified.sourceText) {
          classified = candidate
        }
      }
      // If no fromRanges or none matched, fall back to the enclosing function definition line
      if (!classified.match && fromRanges.length === 0) {
        classified = classifyReference(fromFile, fromLine0, 0, seedName)
      }

      let chain: ResolvedChain | null = null
      if (shouldResolve && classified.match) {
        chain = await resolveChain(
          classified.match.patternName,
          classified.match.registrationApi,
          classified.match.dispatchKey,
          fromFile,
          fromRanges[0]?.line ?? fromLine0,
          classified.sourceText,
          {
            lspClient: client,
            readFile: readFileSafe,
          },
        )
      }

      // ── Dispatch chain template fallback ───────────────────────────
      // When classification matched but chain resolution failed (no
      // store → dispatch → trigger), check if the registration API has
      // a pre-built dispatch chain template from the sub-plugin pack.
      // Templates encode architecturally-fixed dispatch paths (e.g.
      // request_irq → do_IRQ → handle_irq_event → handler).
      if (classified.match && !chain) {
        chain = tryDispatchChainTemplate(
          classified.match.registrationApi,
          classified.match.dispatchKey,
          seedName,
          classified.match.connectionKind,
        )
      }

      nodes.push({
        name:       from.name ?? "(unknown)",
        file:       fromFile,
        line:       fromLine1,
        sourceText: classified.sourceText,
        classification: classified.match,
        resolvedChain: chain,
      })
    }
    return {
      seed: { name: seedName, file: seedFile, line: args.line },
      nodes,
    }
  }

  // Step 3: fn-ptr fallback — symbol is only passed as an argument, never called directly.
  // Use references to find all argument-passing sites, then resolve the enclosing function.
  const refs = await client.references(filePath, line, charPos)
  const seenEnclosing = new Set<string>()

  for (const ref of refs ?? []) {
    if (nodes.length >= maxNodes) break

    const refUri  = ref.uri ?? ""
    const refLine = ref.range?.start?.line ?? 0
    const refChar = ref.range?.start?.character ?? 0
    const absPath = refUri.startsWith("file://") ? fileURLToPath(refUri) : refUri

    // Skip the definition site
    if (absPath === seedFile && refLine === line) continue

    try {
      const enclosing = await client.prepareCallHierarchy(absPath, refLine, refChar)
      const enc = enclosing?.[0]
      if (!enc) continue

      const encFile = enc.uri?.startsWith("file://") ? fileURLToPath(enc.uri) : (enc.uri ?? absPath)
      const encLine0 = enc.selectionRange?.start?.line ?? enc.range?.start?.line ?? refLine
      const encChar0 = enc.selectionRange?.start?.character ?? enc.range?.start?.character ?? 0
      const encLine1 = encLine0 + 1
      const key = `${encFile}:${enc.name ?? ""}:${encLine1}`
      if (seenEnclosing.has(key)) continue
      seenEnclosing.add(key)

      // Use parser to classify the reference site
      const classified = classifyReference(absPath, refLine, refChar, seedName)
      let chain: ResolvedChain | null = null
      if (shouldResolve && classified.match) {
        chain = await resolveChain(
          classified.match.patternName,
          classified.match.registrationApi,
          classified.match.dispatchKey,
          absPath,
          refLine,
          classified.sourceText,
          {
            lspClient: client,
            readFile: readFileSafe,
          },
        )
      }
      // Dispatch chain template fallback (same as above)
      if (classified.match && !chain) {
        chain = tryDispatchChainTemplate(
          classified.match.registrationApi,
          classified.match.dispatchKey,
          seedName,
          classified.match.connectionKind,
        )
      }
      nodes.push({
        name:       enc.name ?? "(unknown)",
        file:       encFile,
        line:       encLine1,
        sourceText: classified.sourceText,
        classification: classified.match,
        resolvedChain: chain,
      })
    } catch {
      // prepareCallHierarchy may fail for macro-expanded sites — skip
    }
  }

  return {
    seed: { name: seedName, file: seedFile, line: args.line },
    nodes,
  }
}

// ---------------------------------------------------------------------------
// Parser-based classification
// ---------------------------------------------------------------------------

interface ClassificationResult {
  sourceText: string
  match: {
    patternName: string
    registrationApi: string
    dispatchKey: string
    connectionKind: string
  } | null
}

/**
 * Classify a reference site by reading the full source file and using the
 * C parser to find the enclosing call/construct.
 *
 * Two passes for struct initializers:
 *   1. Project-specific INIT_PATTERNS (WLAN dispatch table etc.)
 *   2. Generic struct-field-callback fallback that handles ANY
 *      `.field = callbackName` assignment in ANY struct
 *      (Linux file_operations, net_device_ops, irq_chip, …) — uses
 *      tree-sitter to recover the container type and variable name with
 *      zero per-struct hardcoding.
 */
function classifyReference(
  filePath: string,
  refLine0: number,
  refChar0: number,
  callbackName: string,
): ClassificationResult {
  const source = readFileSafe(filePath)
  if (!source) {
    return { sourceText: "", match: null }
  }

  // Try function call (covers most registration patterns)
  const call = findEnclosingCall(source, refLine0, refChar0)
  if (call) {
    return classifyFunctionCall(call)
  }

  // Try struct initializer (WMI dispatch table, file_operations, etc.)
  const construct = findEnclosingConstruct(source, refLine0, refChar0)
  if (construct && construct.nodeType === "initializer_list") {
    return classifyInitializer(construct, callbackName, filePath, refLine0, refChar0)
  }

  // ── Pass 3: function-body fn-ptr assignment ─────────────────────────
  // Handles patterns like `current->restart_block.fn = do_no_restart_syscall`
  // where a callback is assigned to a struct field inside a function body
  // (not a file-scope initializer). Uses tree-sitter to find the nearest
  // assignment_expression containing the callback identifier.
  const assignResult = classifyFnBodyAssignment(source, refLine0, refChar0, callbackName)
  if (assignResult.match) return assignResult

  // No enclosing call, initializer, or assignment
  const fallbackText = source.split(/\r?\n/)[refLine0]?.trim().slice(0, 200) ?? ""
  return { sourceText: fallbackText, match: null }
}

/**
 * Classify a function-body fn-ptr assignment like:
 *   current->restart_block.fn = do_no_restart_syscall
 *   timer->function = my_timer_fn
 *   ops->read = my_read
 *
 * Uses tree-sitter to find the assignment_expression containing the
 * callback identifier and extract the LHS field path.
 */
function classifyFnBodyAssignment(
  source: string,
  refLine0: number,
  _refChar0: number,
  callbackName: string,
): ClassificationResult {
  // Get the source line containing the reference
  const lines = source.split(/\r?\n/)
  const line = lines[refLine0] ?? ""

  // Quick regex check: does the line contain `= callbackName` (or `, callbackName`)?
  // This avoids expensive tree-sitter parsing for lines that clearly aren't assignments.
  if (!line.includes(callbackName)) {
    return { sourceText: line.trim().slice(0, 200), match: null }
  }

  // Check if the line looks like an assignment: `<lhs> = callbackName`
  // The LHS is the field path (e.g. "current->restart_block.fn",
  // "ops->read", "timer->function").
  const assignRegex = new RegExp(
    `([a-zA-Z_][a-zA-Z0-9_]*(?:->|\\.)(?:[a-zA-Z_][a-zA-Z0-9_]*(?:->|\\.))*[a-zA-Z_][a-zA-Z0-9_]*)\\s*=\\s*${callbackName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
  )
  const m = line.match(assignRegex)
  if (!m) {
    return { sourceText: line.trim().slice(0, 200), match: null }
  }

  const fieldPath = m[1]  // e.g. "current->restart_block.fn"
  // Extract the last field name as the dispatch key
  const parts = fieldPath.split(/->|\./)
  const fieldName = parts[parts.length - 1] ?? fieldPath
  // Extract the container expression (everything before the last field)
  const containerExpr = parts.slice(0, -1).join("->") || fieldPath

  return {
    sourceText: line.trim().slice(0, 200),
    match: {
      patternName: `auto-fn-body-assign:${fieldPath}`,
      registrationApi: containerExpr,
      dispatchKey: fieldName,
      connectionKind: "api_call",
    },
  }
}

/**
 * Classify a function call against the call-name registry.
 */
function classifyFunctionCall(call: FunctionCall): ClassificationResult {
  const pattern = CALL_PATTERNS.find((p) => p.registrationApi === call.name)

  if (pattern) {
    const dispatchKey = pattern.keyArgIndex < call.args.length
      ? call.args[pattern.keyArgIndex].trim()
      : null
    return {
      sourceText: call.fullText,
      match: {
        patternName: pattern.name,
        registrationApi: pattern.registrationApi,
        dispatchKey: dispatchKey ?? "",
        connectionKind: pattern.connectionKind,
      },
    }
  }

  return { sourceText: call.fullText, match: null }
}

/**
 * Classify a struct initializer.
 *
 * Pass 1: project-specific INIT_PATTERNS (WLAN's WMI dispatch table, etc.).
 * Pass 2: generic struct-field-callback fallback — handles any
 *         `.field = callbackName` assignment in ANY struct shape, by
 *         walking the tree-sitter AST upward to recover the container
 *         variable + struct type. Zero per-struct hardcoding.
 */
function classifyInitializer(
  init: FunctionCall,
  callbackName: string,
  filePath: string,
  refLine0: number,
  refChar0: number,
): ClassificationResult {
  // ── Pass 1: registered INIT_PATTERNS ──────────────────────────────────
  for (const pattern of INIT_PATTERNS) {
    if (init.args.length > pattern.markerArgIndex) {
      const markerArg = init.args[pattern.markerArgIndex].trim()
      if (pattern.markerRegex.test(markerArg)) {
        const dispatchKey = init.args.length > pattern.keyArgIndex
          ? init.args[pattern.keyArgIndex].trim()
          : null
        return {
          sourceText: init.fullText,
          match: {
            patternName: pattern.name,
            registrationApi: pattern.registrationApi,
            dispatchKey: dispatchKey ?? "",
            connectionKind: pattern.connectionKind,
          },
        }
      }
    }
  }

  // ── Pass 2: generic struct-field-callback fallback ────────────────────
  const generic = classifyGenericStructFieldCallback(
    init,
    callbackName,
    filePath,
    refLine0,
    refChar0,
  )
  if (generic && generic.matchedPattern) {
    return {
      sourceText: generic.sourceText,
      match: {
        patternName: generic.matchedPattern.name,
        registrationApi: generic.viaRegistrationApi ?? "",
        dispatchKey: generic.dispatchKey ?? "",
        connectionKind: generic.connectionKind,
      },
    }
  }

  return { sourceText: init.fullText, match: null }
}

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

/** Map trigger kind to endpoint kind for the TUI mediated-paths contract. */
function triggerKindToEndpointKind(triggerKind: string): string {
  switch (triggerKind) {
    case "hardware_interrupt": return "hw_irq_or_ring"
    case "signal": return "signal"
    case "event": return "host_event"
    case "message": return "host_event"
    case "timer_expiry": return "timer"
    default: return "unknown"
  }
}

/**
 * Format the indirect caller graph as plain text.
 * This is the output for lsp_indirect_callers when LLM is disabled.
 */
export function formatIndirectCallerTree(
  graph: IndirectCallerGraph,
  root: string,
): string {
  if (!graph.seed) return "No callers found — symbol not resolved by clangd."
  const seedName = graph.seed.name

  if (!graph.nodes.length) {
    return `Callers of ${seedName}:\n  (none found)\n\n` +
      `Tip: run lsp_reason_chain on this position to use LLM+cache analysis.`
  }

  const lines: string[] = [`Callers of ${seedName}  (${graph.nodes.length} reference sites found):`]
  lines.push(`  Note: these are raw LSP reference sites. Run lsp_reason_chain for full invocation reason.`)
  lines.push("")

  for (const node of graph.nodes) {
    const rel = root ? path.relative(root, node.file) : node.file
    const tag = node.classification ? ` [${node.classification.registrationApi}:${node.classification.dispatchKey}]` : ""
    lines.push(`  <- ${node.name}  at ${rel}:${node.line}${tag}`)
    if (node.sourceText) {
      lines.push(`     ${node.sourceText}`)
    }
    // Show resolved chain if available
    if (node.resolvedChain) {
      const chain = node.resolvedChain
      lines.push(`     confidence: L${chain.confidenceScore} (${chain.confidenceLevel})`)
      if (chain.store.containerType) {
        lines.push(`     store: ${chain.store.containerType} (${chain.store.confidence})`)
      }
      if (chain.dispatch.dispatchFunction) {
        const dispatchRel = chain.dispatch.dispatchFile
          ? path.relative(root, chain.dispatch.dispatchFile)
          : "?"
        lines.push(`     dispatch: ${chain.dispatch.dispatchFunction} at ${dispatchRel}:${(chain.dispatch.dispatchLine ?? 0) + 1} (${chain.dispatch.confidence})`)
      }
      if (chain.trigger.triggerKind) {
        lines.push(`     trigger: ${chain.trigger.triggerKind}${chain.trigger.triggerKey ? ` [${chain.trigger.triggerKey}]` : ""} (${chain.trigger.confidence})`)
      }
    }
  }

  // If any nodes have resolved chains, emit structured mediated-paths-json
  // that the TUI parser can consume directly (Gate G8).
  const nodesWithChains = graph.nodes.filter((n) => n.resolvedChain)
  if (nodesWithChains.length > 0) {
    const mediatedPaths = nodesWithChains.map((node) => {
      const chain = node.resolvedChain!
      // Build endpoint from trigger or dispatch
      const endpointId = chain.trigger.triggerKey
        ?? chain.dispatch.dispatchFunction
        ?? node.classification?.dispatchKey
        ?? node.name
      const endpointKind = chain.trigger.triggerKind
        ? triggerKindToEndpointKind(chain.trigger.triggerKind)
        : chain.dispatch.dispatchFunction ? "dispatch" : "registration"
      const endpointLabel = chain.trigger.triggerKind ?? chain.dispatch.dispatchFunction ?? node.classification?.registrationApi

      // Build stages from registration + dispatch
      const stages: Array<{ ownerSymbol: string; mechanism: string }> = []
      stages.push({
        ownerSymbol: node.classification?.registrationApi ?? node.name,
        mechanism: "registration",
      })
      if (chain.store.containerType) {
        stages.push({
          ownerSymbol: chain.store.containerType,
          mechanism: "store",
        })
      }
      if (chain.dispatch.dispatchFunction) {
        stages.push({
          ownerSymbol: chain.dispatch.dispatchFunction,
          mechanism: "dispatch",
        })
      }

      return {
        targetSymbol: seedName,
        endpoint: {
          endpointId,
          endpointKind,
          endpointLabel,
          file: chain.trigger.triggerFile ?? chain.dispatch.dispatchFile ?? node.file,
          line: ((chain.trigger.triggerLine ?? chain.dispatch.dispatchLine ?? node.line - 1)) + 1,
        },
        stages,
      }
    })

    const jsonBlock = JSON.stringify(mediatedPaths, null, 2)
    lines.push("")
    lines.push("---mediated-paths-json---")
    lines.push(jsonBlock)
    lines.push("---end-mediated-paths-json---")
  }

  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Dispatch chain template fallback
// ---------------------------------------------------------------------------

/** Lazily loaded dispatch chain template map (populated on first use). */
let _dispatchTemplateMap: Map<string, DispatchChainTemplate> | null = null

function getDispatchTemplateMap(): Map<string, DispatchChainTemplate> {
  if (!_dispatchTemplateMap) {
    _dispatchTemplateMap = collectAllDispatchChains()
  }
  return _dispatchTemplateMap
}

/**
 * Try to build a ResolvedChain from a pre-built dispatch chain template.
 *
 * When the LSP-based resolver (resolveChain) fails to find the
 * store/dispatch/trigger stages — common for kernel macros/inlines —
 * this function checks if the registration API has a known dispatch
 * chain template contributed by a sub-plugin pack.
 *
 * Two lookup strategies:
 *   1. Exact match on registrationApi (e.g. "request_irq")
 *   2. Struct-field match: if the registrationApi came from the generic
 *      struct-field classifier (e.g. "mem_fops"), try
 *      `__struct_field:<connectionKind>.<dispatchKey>` to find
 *      VFS/net_device_ops dispatch templates
 */
function tryDispatchChainTemplate(
  registrationApi: string,
  dispatchKey: string,
  callbackName: string,
  connectionKind: string,
): ResolvedChain | null {
  const map = getDispatchTemplateMap()

  // Strategy 1: exact match on registration API name
  let tmpl = map.get(registrationApi)

  // Strategy 2: struct-field match using the synthetic key format
  // The generic classifier produces registrationApi = container variable
  // (e.g. "mem_fops") and dispatchKey = field name (e.g. "read").
  // The template uses `__struct_field:file_operations.read`.
  // We try common struct types when connectionKind = "interface_registration".
  if (!tmpl && connectionKind === "interface_registration" && dispatchKey) {
    const structFieldCandidates = [
      `__struct_field:file_operations.${dispatchKey}`,
      `__struct_field:net_device_ops.${dispatchKey}`,
      `__struct_field:block_device_operations.${dispatchKey}`,
      `__struct_field:seq_operations.${dispatchKey}`,
      `__struct_field:inode_operations.${dispatchKey}`,
    ]
    for (const key of structFieldCandidates) {
      tmpl = map.get(key)
      if (tmpl) break
    }
  }

  if (!tmpl) return null

  // Build the chain by replacing %CALLBACK% and %KEY% placeholders
  const chain = tmpl.chain.map((s) =>
    s.replace(/%CALLBACK%/g, callbackName).replace(/%KEY%/g, dispatchKey),
  )

  // Construct a ResolvedChain compatible with the existing formatter.
  // The chain has at least 2 entries: [... dispatch stages ..., callback].
  // The second-to-last entry is the immediate dispatch function.
  const dispatchFn = chain.length >= 3 ? chain[chain.length - 2] : chain[0]
  const triggerDesc = tmpl.triggerDescription
    .replace(/%KEY%/g, dispatchKey)
    .replace(/%CALLBACK%/g, callbackName)

  return {
    confidenceScore: 4,
    confidenceLevel: "dispatch_site_found" as const,
    registration: {
      apiName: registrationApi,
      callbackArgIndex: 0,
      dispatchKey,
      file: "",
      line: 0,
      sourceText: triggerDesc,
    },
    store: {
      containerType: registrationApi,
      containerFile: null,
      containerLine: null,
      confidence: "medium" as const,
      evidence: `dispatch-chain-template:${tmpl.registrationApi}`,
      storeFieldName: dispatchKey,
    },
    dispatch: {
      dispatchFunction: dispatchFn,
      dispatchFile: null,
      dispatchLine: null,
      invocationPattern: null,
      confidence: "medium" as const,
      evidence: `template-chain:[${chain.join(" → ")}]`,
    },
    trigger: {
      triggerKind: tmpl.triggerKind,
      triggerKey: dispatchKey,
      triggerFile: null,
      triggerLine: null,
      confidence: "medium" as const,
      evidence: triggerDesc,
    },
  }
}

function readFileSafe(filePath: string): string {
  try {
    return readFileSync(filePath, "utf8")
  } catch {
    return ""
  }
}

/**
 * Find the character offset of the first C identifier on a source line that
 * looks like a function name (preceded by a return type, not a keyword).
 *
 * This is needed because clangd's prepareCallHierarchy requires the cursor to
 * be ON the function name token, not on the return type or line start.
 *
 * Strategy: scan the line for the last identifier before the first '(' that
 * is not a C keyword. This handles:
 *   void foo(...)                → finds 'foo'
 *   static int bar(...)          → finds 'bar'
 *   OFFLOAD_STATUS _handler(...) → finds '_handler'
 *   enum cmnos_sig_proc_next fn( → finds 'fn'
 *
 * Returns -1 if no function name found.
 */
function findFunctionNameChar(line: string): number {
  const C_KEYWORDS = new Set([
    "void", "int", "char", "short", "long", "float", "double", "unsigned",
    "signed", "static", "extern", "const", "volatile", "inline", "struct",
    "union", "enum", "typedef", "return", "if", "else", "for", "while",
    "do", "switch", "case", "break", "continue", "goto", "sizeof",
    "A_STATUS", "A_UINT32", "A_UINT64", "A_INT32", "A_BOOL",
    "OFFLOAD_STATUS", "wlan_status_t",
  ])

  // Find the position of the first '(' — the function name is just before it
  const parenIdx = line.indexOf("(")
  if (parenIdx < 0) return -1

  // Scan backward from '(' to find the identifier
  let end = parenIdx - 1
  while (end >= 0 && /\s/.test(line[end])) end--
  if (end < 0) return -1

  let start = end
  while (start > 0 && /[\w]/.test(line[start - 1])) start--

  const name = line.slice(start, end + 1)
  if (!name || C_KEYWORDS.has(name) || /^\d/.test(name)) return -1

  return start
}

/**
 * Wait until clangd reports the file as idle (fully parsed).
 * First waits for the file to enter a non-idle state (parsing/building AST),
 * then waits for it to return to idle.
 */
async function waitForFileReady(client: ILanguageClient, filePath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs

  // Phase 1: wait for clangd to start parsing (up to 3s)
  const parseStart = Date.now() + 3000
  while (Date.now() < parseStart) {
    const state = client.indexTracker.fileState(filePath)
    if (state && state !== "idle") break
    await new Promise((r) => setTimeout(r, 100))
  }

  // Phase 2: wait for parsing to complete
  while (Date.now() < deadline) {
    const state = client.indexTracker.fileState(filePath)
    if (state === "idle" || state === undefined) return
    await new Promise((r) => setTimeout(r, 200))
  }
}
