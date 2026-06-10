/**
 * pattern-resolver/ports.ts — Types for pattern-family-specific resolution.
 *
 * After the parser classifies a registration call, pattern-specific resolvers
 * use additional clangd operations to prove the full chain:
 *   registration → store → dispatch → trigger
 *
 * Each stage proved increases confidence.
 */

export type ConfidenceLevel =
  | "registration_detected" // L1: callback is passed to registration API
  | "dispatch_key_extracted" // L2: the key that maps this callback in the store
  | "store_container_found" // L3: the array/list/struct that holds the callback
  | "dispatch_site_found" // L4: the function that iterates and calls the callback
  | "runtime_trigger_found" // L5: the external event that drives the dispatch

export interface ResolvedChain {
  /** Registration site — always present (from the existing detector). */
  registration: {
    apiName: string
    callbackArgIndex: number
    dispatchKey: string | null
    file: string
    line: number
    sourceText: string
  }

  /** Store container — the struct/array/list holding the callback pointer. */
  store: {
    containerType: string | null // e.g., "struct WMI_EVT_DISPATCH", "offload_data[i]"
    containerFile: string | null
    containerLine: number | null
    confidence: "high" | "medium" | "low"
    evidence: string | null
    /**
     * The field name used in the store assignment, extracted from the
     * registration API body. Used as the target for references() lookup
     * to find the dispatch call site.
     * e.g. "data_handler", "handler", "irq_route_cb"
     */
    storeFieldName: string | null
  }

  /** Dispatch site — the function that iterates the store and invokes the callback. */
  dispatch: {
    dispatchFunction: string | null // e.g., "wmi_event_dispatch", "_offldmgr_enhanced_data_handler"
    dispatchFile: string | null
    dispatchLine: number | null
    invocationPattern: string | null // e.g., "handler(ctx, event, len)", "data_handler(...)"
    confidence: "high" | "medium" | "low"
    evidence: string | null
  }

  /** Runtime trigger — the external event that drives the dispatch site. */
  trigger: {
    triggerKind: string | null // e.g., "hardware_interrupt", "wmi_event", "timer_expiry"
    triggerKey: string | null // e.g., "WMI_SERVICE_READY_EVENTID", "A_INUM_WSI"
    triggerFile: string | null
    triggerLine: number | null
    confidence: "high" | "medium" | "low"
    evidence: string | null
  }

  /** Achieved confidence level. */
  confidenceLevel: ConfidenceLevel

  /** Structured confidence score: 1.0 (L1) → 5.0 (L5). */
  confidenceScore: number
}

/** Dependencies for pattern resolvers — extended LSP client. */
export interface ResolverDeps {
  /** LSP client with all operations needed for resolution. */
  lspClient: {
    definition: (file: string, line: number, char: number) => Promise<any[]>
    references: (file: string, line: number, char: number) => Promise<any[]>
    outgoingCalls: (file: string, line: number, char: number) => Promise<any[]>
    /** Find all callers of the function at the given position. */
    incomingCalls: (file: string, line: number, char: number) => Promise<any[]>
    prepareCallHierarchy: (file: string, line: number, char: number) => Promise<any[]>
    documentSymbol: (file: string) => Promise<any[]>
    hover: (file: string, line: number, char: number) => Promise<any>
    openFile?: (file: string, text: string) => Promise<boolean>
  }
  /** Read a source file for parser-based analysis. */
  readFile: (filePath: string) => string
  /** Optional debug logger for staged resolver diagnostics. */
  logDebug?: (event: string, context: Record<string, unknown>) => void
}
