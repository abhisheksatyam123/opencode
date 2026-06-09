/**
 * pattern-detector/detector.ts — Parser-based indirect caller detector.
 *
 * Given a target callback function, this module:
 *   1. Calls LSP references() to find all sites where the function is used.
 *   2. Reads the FULL source file at each site.
 *   3. Uses the C parser (findEnclosingCall) to find the enclosing call.
 *   4. Classifies by call name lookup in the registry (fast path).
 *   5. On registry miss: auto-classifier via LSP hover() + definition() (slow path).
 *   6. Extracts the dispatch key from the correct argument position.
 *
 * The parser handles multi-line calls, nested parens, strings, comments,
 * and macros — no fragile line-based regex needed.
 */

import { fileURLToPath } from "url"
import { findEnclosingCall, findEnclosingConstruct, walkAst } from "./c-parser.js"
import { CALL_PATTERNS, INIT_PATTERNS } from "./registry.js"
import { autoClassifyCall } from "./auto-classifier.js"
import type {
  ClassifiedSite,
  DetectorDeps,
  DetectorInput,
  CallPattern,
  InitPattern,
  PatternDetectionResult,
  PatternConnectionKind,
} from "./ports.js"
import type { FunctionCall } from "./c-parser.js"

// ---------------------------------------------------------------------------
// Core detection
// ---------------------------------------------------------------------------

/**
 * Detect indirect callers for a target callback function.
 *
 * Uses LSP references() to find all sites where the callback is referenced,
 * then uses the C parser to find the enclosing call and classify it.
 */
export async function detectIndirectCallers(
  input: DetectorInput,
  deps: DetectorDeps,
): Promise<PatternDetectionResult> {
  const { file, line, character, maxNodes = 50 } = input
  const { lspClient, readFile } = deps

  // Step 1: resolve target symbol via prepareCallHierarchy
  const seedItems = await lspClient.prepareCallHierarchy(file, line - 1, character - 1)
  const seed = seedItems?.[0] ?? null

  const seedName = seed?.name ?? "(unknown)"
  const seedFile = seed?.uri?.startsWith("file://")
    ? fileURLToPath(seed.uri)
    : (seed?.uri ?? file)

  // Step 2: find all reference sites via LSP references()
  const refs = await lspClient.references(file, line - 1, character - 1)
  if (!refs?.length) {
    return {
      seed: { name: seedName, file: seedFile, line },
      sites: [],
      matchedSites: [],
      unclassifiedSites: [],
    }
  }

  // Step 3: classify each reference site using the C parser
  const sites: ClassifiedSite[] = []
  const seenKeys = new Set<string>()

  for (const ref of refs) {
    if (sites.length >= maxNodes) break

    const refUri = ref.uri ?? ""
    const refLine = ref.range?.start?.line ?? 0
    const refChar = ref.range?.start?.character ?? 0
    const absPath = refUri.startsWith("file://") ? fileURLToPath(refUri) : refUri

    // Skip the definition site
    if (absPath === seedFile && refLine === line - 1) continue

    // Dedup by file:line
    const dedupKey = `${absPath}:${refLine}`
    if (seenKeys.has(dedupKey)) continue
    seenKeys.add(dedupKey)

    // Read the full source file and use the parser to find the enclosing call
    const source = readFile(absPath)
    if (!source) continue

    const classified = await classifyReferenceSite(source, refLine, refChar, seedName, absPath, deps)
    sites.push(classified)
  }

  const matchedSites = sites.filter((s) => s.matchedPattern !== null)
  const unclassifiedSites = sites.filter((s) => s.matchedPattern === null)

  return {
    seed: { name: seedName, file: seedFile, line },
    sites,
    matchedSites,
    unclassifiedSites,
  }
}

// ---------------------------------------------------------------------------
// Reference site classification
// ---------------------------------------------------------------------------

/**
 * Classify a single reference site using the C parser.
 *
 * 1. findEnclosingCall — handles function call registrations
 *    a. Registry fast-path: known call name → immediate classification
 *    b. Auto-classifier: unknown call name → LSP hover + definition
 * 2. findEnclosingConstruct — fallback for struct initializer dispatch tables
 * 3. null classification if neither matches
 */
async function classifyReferenceSite(
  source: string,
  refLine0: number,
  refChar0: number,
  callbackName: string,
  filePath: string,
  deps: DetectorDeps,
): Promise<ClassifiedSite> {
  // Try function call first (most patterns)
  const call = findEnclosingCall(source, refLine0, refChar0)
  if (call) {
    // Registry fast-path
    const registryResult = classifyFunctionCallFromRegistry(call, callbackName, filePath, refLine0, refChar0)
    if (registryResult.matchedPattern !== null) return registryResult

    // Auto-classifier slow-path (only when deps.autoClassifier is provided)
    if (deps.autoClassifier) {
      const autoResult = await autoClassifyCall(
        call,
        callbackName,
        filePath,
        refLine0,
        refChar0,
        deps.autoClassifier,
      )
      if (autoResult) return autoResult
    }

    // Return the unclassified call site (enclosingCall is set for diagnostics)
    return registryResult
  }

  // Try struct initializer (WMI dispatch table, etc.)
  const construct = findEnclosingConstruct(source, refLine0, refChar0)
  if (construct && construct.nodeType === "initializer_list") {
    return classifyInitializer(construct, callbackName, filePath, refLine0, refChar0)
  }

  // No enclosing call or initializer found
  return {
    callbackName,
    filePath,
    line: refLine0,
    character: refChar0,
    sourceText: source.split(/\r?\n/)[refLine0]?.trim().slice(0, 200) ?? "",
    matchedPattern: null,
    dispatchKey: null,
    connectionKind: "custom",
    viaRegistrationApi: null,
    enclosingCall: call ?? construct,
  }
}

/**
 * Classify a function call against the call-name registry (fast path).
 * Returns a ClassifiedSite with matchedPattern=null if not in registry.
 */
function classifyFunctionCallFromRegistry(
  call: FunctionCall,
  callbackName: string,
  filePath: string,
  refLine0: number,
  refChar0: number,
): ClassifiedSite {
  const pattern = CALL_PATTERNS.find((p) => p.registrationApi === call.name)

  if (pattern) {
    const dispatchKey = extractKeyFromCall(call, pattern.keyArgIndex)
    return {
      callbackName,
      filePath,
      line: refLine0,
      character: refChar0,
      sourceText: call.fullText,
      matchedPattern: pattern,
      dispatchKey,
      connectionKind: pattern.connectionKind,
      viaRegistrationApi: pattern.registrationApi,
      enclosingCall: call,
    }
  }

  // Not in registry — return unclassified (auto-classifier may upgrade this)
  return {
    callbackName,
    filePath,
    line: refLine0,
    character: refChar0,
    sourceText: call.fullText,
    matchedPattern: null,
    dispatchKey: null,
    connectionKind: "custom",
    viaRegistrationApi: null,
    enclosingCall: call,
  }
}

/**
 * Classify a struct initializer.
 *
 * Two passes:
 *
 *   1. **Registered INIT_PATTERNS** — fast path for project-specific shapes
 *      contributed by pattern packs (e.g. WLAN's `WMI_RegisterDispatchTable`).
 *      Each registered pattern is matched by checking a marker arg against
 *      a regex and pulling a dispatch key from a fixed arg position.
 *
 *   2. **Generic struct-field-callback fallback** — load-bearing for any
 *      project (Linux, FreeBSD, Zephyr, …) that registers callbacks by
 *      assigning them to struct fields, e.g.:
 *
 *          static const struct file_operations memory_fops = {
 *              .read  = read_mem,
 *              .write = write_mem,
 *              ...
 *          };
 *
 *      This fallback uses tree-sitter to walk up from the initializer node,
 *      find which `.field = callbackName` designates the callback, and read
 *      the enclosing declaration to recover the container variable
 *      (`memory_fops`) and the struct type (`struct file_operations`). The
 *      result is a synthetic InitPattern with zero per-struct hardcoding.
 */
function classifyInitializer(
  init: FunctionCall,
  callbackName: string,
  filePath: string,
  refLine0: number,
  refChar0: number,
): ClassifiedSite {
  // ── Pass 1: registered INIT_PATTERNS (project-specific fast path) ──────
  for (const pattern of INIT_PATTERNS) {
    if (init.args.length > pattern.markerArgIndex) {
      const markerArg = init.args[pattern.markerArgIndex].trim()
      if (pattern.markerRegex.test(markerArg)) {
        const dispatchKey = init.args.length > pattern.keyArgIndex
          ? init.args[pattern.keyArgIndex].trim()
          : null
        return {
          callbackName,
          filePath,
          line: refLine0,
          character: refChar0,
          sourceText: init.fullText,
          matchedPattern: pattern,
          dispatchKey,
          connectionKind: pattern.connectionKind,
          viaRegistrationApi: pattern.registrationApi,
          enclosingCall: init,
        }
      }
    }
  }

  // ── Pass 2: generic struct-field-callback fallback (zero hardcoding) ───
  const genericMatch = classifyGenericStructFieldCallback(
    init,
    callbackName,
    filePath,
    refLine0,
    refChar0,
  )
  if (genericMatch) return genericMatch

  // ── No match ───────────────────────────────────────────────────────────
  return {
    callbackName,
    filePath,
    line: refLine0,
    character: refChar0,
    sourceText: init.fullText,
    matchedPattern: null,
    dispatchKey: null,
    connectionKind: "custom",
    viaRegistrationApi: null,
    enclosingCall: init,
  }
}

// ---------------------------------------------------------------------------
// Generic struct-field-callback fallback
// ---------------------------------------------------------------------------

/**
 * Detect the dominant Linux pattern of registering a callback by assigning
 * it to a struct field at file scope, e.g.:
 *
 *     static const struct file_operations memory_fops = {
 *         .read  = read_mem,
 *         .write = write_mem,
 *     };
 *
 * Walks the tree-sitter AST upward from the initializer to find:
 *   - the `.field = callback` designator that holds OUR callback
 *   - the enclosing `init_declarator` (gives the container variable name)
 *   - the enclosing `declaration` (gives the struct type spelling)
 *
 * Returns a synthetic ClassifiedSite with:
 *   - `viaRegistrationApi` set to the container variable (so downstream
 *     chain resolution can find calls like `register_chrdev(M, "mem", &memory_fops)`)
 *   - `dispatchKey` set to the field name (`read`, `write`, …)
 *   - `connectionKind` derived from the struct type via a small token
 *     heuristic (no per-struct hardcoding)
 *
 * Returns null when:
 *   - no `tsNode` is attached to the initializer (parser fallback path)
 *   - the callback identifier isn't found inside any initializer pair
 *   - the AST shape doesn't expose a recognizable enclosing declaration
 */
export function classifyGenericStructFieldCallback(
  init: FunctionCall,
  callbackName: string,
  filePath: string,
  refLine0: number,
  refChar0: number,
): ClassifiedSite | null {
  const root = init.tsNode
  if (!root || typeof root !== "object") return null

  // Step 1: find the `initializer_pair` that designates our callback.
  // tree-sitter-c emits these as `initializer_pair` with a `designator`
  // child (a `field_designator` like `.read`) and a `value` child (an
  // `identifier` like `read_mem`).
  let designatedField: string | null = null
  walkAst(root, (node: any) => {
    if (designatedField) return
    if (node.type !== "initializer_pair") return

    // Check whether any descendant identifier equals callbackName
    let containsCallback = false
    walkAst(node, (m: any) => {
      if (containsCallback) return
      if (m.type === "identifier" && m.text === callbackName) containsCallback = true
    })
    if (!containsCallback) return

    // Pull the designator's field name. The grammar exposes designators
    // as a child sequence; field designators look like `.fieldname`.
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)
      if (!child) continue
      if (child.type === "field_designator") {
        designatedField = (child.text as string).replace(/^\./, "").trim()
        return
      }
      // `subscript_designator` ([N] = ...) is an array index — also valid,
      // captured separately so we don't conflate field/array dispatch.
      if (child.type === "subscript_designator") {
        designatedField = (child.text as string).trim()
        return
      }
    }
  })
  if (!designatedField) return null

  // Step 2: walk upward to find the enclosing declaration → struct type
  // and the init_declarator → variable name.
  //
  // Caveat: tree-sitter-c does not expand kernel attribute macros like
  // `__maybe_unused`, `__read_mostly`, `__attribute__((...))`, so the
  // grammar mis-parses
  //
  //     static const struct file_operations __maybe_unused mem_fops = {…}
  //
  // and `init_declarator.declarator` ends up being `__maybe_unused`
  // instead of `mem_fops`. We work around this by reading the full
  // init_declarator text and taking the last identifier before `=` —
  // that is always the actual variable name regardless of how many
  // unknown attribute macros are wedged in front of it.
  let containerVar: string | null = null
  let containerType: string | null = null
  let parent: any = root.parent
  while (parent) {
    if (parent.type === "init_declarator" && containerVar === null) {
      const fullText = (parent.text as string | undefined) ?? ""
      // Take everything before the first `=` (the LHS of the init), then
      // pull out every identifier and use the last one. Identifiers that
      // start with `__` are usually kernel attribute macros — drop them
      // when there is a non-attribute identifier available, otherwise
      // fall back to the last identifier of any kind.
      const lhs = fullText.split("=")[0] ?? fullText
      const idents = lhs.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) ?? []
      const nonAttr = idents.filter((id) => !id.startsWith("__"))
      containerVar = (nonAttr[nonAttr.length - 1] ?? idents[idents.length - 1]) ?? null
    }
    if (parent.type === "declaration") {
      const typeNode = parent.childForFieldName?.("type")
      if (typeNode && typeof typeNode.text === "string") {
        containerType = typeNode.text.trim()
      }
      break
    }
    parent = parent.parent
  }

  if (!containerType && !containerVar) return null

  // Step 3: synthesize a pattern + classified site
  const synthetic: InitPattern = {
    name: `auto-struct-field:${(containerType ?? "struct").replace(/\s+/g, "_")}.${designatedField}`,
    registrationApi: containerVar ?? containerType ?? "struct_init",
    connectionKind: deriveConnectionKindFromStructType(containerType ?? ""),
    markerArgIndex: 0,
    markerRegex: /.*/,
    keyArgIndex: 0,
    keyDescription: `${containerType ?? "struct"}.${designatedField}`,
  }

  return {
    callbackName,
    filePath,
    line: refLine0,
    character: refChar0,
    sourceText: init.fullText,
    matchedPattern: synthetic,
    dispatchKey: designatedField,
    connectionKind: synthetic.connectionKind,
    viaRegistrationApi: synthetic.registrationApi,
    enclosingCall: init,
  }
}

/**
 * Map a struct type spelling to a PatternConnectionKind via a small token
 * heuristic. Intentionally generic — every project that uses *_ops or
 * *_operations naming gets `interface_registration` for free, IRQ chips
 * get `hw_interrupt`, work_struct/timer get `event`, and the rest fall
 * through to a sensible default. Adding a project-specific struct type
 * here is allowed but kept rare on purpose.
 */
function deriveConnectionKindFromStructType(typeSpelling: string): PatternConnectionKind {
  const t = typeSpelling.toLowerCase()
  if (/irq_chip|irq_domain_ops|interrupt_controller/.test(t)) return "hw_interrupt"
  if (/work_struct|workqueue|tasklet|delayed_work/.test(t))   return "event"
  if (/timer_list|hrtimer|posix_clock/.test(t))               return "event"
  if (/notifier_block|atomic_notifier|raw_notifier/.test(t))  return "event"
  if (/_ops\b|_operations\b/.test(t))                         return "interface_registration"
  return "interface_registration"
}

// ---------------------------------------------------------------------------
// Key extraction
// ---------------------------------------------------------------------------

/**
 * Extract the dispatch key from a function call at the given argument index.
 * Returns trimmed key text or null if the index is out of range.
 */
function extractKeyFromCall(call: FunctionCall, keyArgIndex: number): string | null {
  if (keyArgIndex >= 0 && keyArgIndex < call.args.length) {
    return call.args[keyArgIndex].trim()
  }
  return null
}
