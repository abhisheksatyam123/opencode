// ---------------------------------------------------------------------------
// InvocationReason
//
// Answers: "Why is this callback invoked at runtime?"
//
// Three-layer model:
//
//   Layer A — Registration gate
//     Who called the registration API, and what conditions put the handler
//     into the dispatch table.
//
//   Layer B — Dispatch site
//     The function that iterates the dispatch table and calls the handler.
//     This is the fn-ptr call site: `table[i].fn(args)`.
//
//   Layer C — Runtime trigger
//     The external event that drives the dispatch site.
//     E.g. "incoming RX data packet from hardware", "WMI command from host",
//     "OS timer fires", "PHY power-state change".
//
// The registrar alone is NOT the invocation reason.
// The invocation reason is Layer C + the path through B to the target.
// ---------------------------------------------------------------------------

export interface DispatchSite {
  /** File containing the fn-ptr call. */
  file: string
  /** 1-based line number of the fn-ptr call. */
  line: number
  /** Short code snippet showing the call (e.g. `table[i].fn(args)`). */
  snippet: string
}

export interface RegistrationGate {
  /** Function that calls the registration API. */
  registrarFn: string
  /** The registration API name (e.g. `offldmgr_register_data_offload`). */
  registrationApi: string
  /**
   * Runtime conditions that must be true for the handler to be dispatched.
   * E.g. ["vdev_bitmap & (1<<vdev_id)", "proto_type & data_type", "active_mode || WOW_STATE"]
   */
  conditions: string[]
}

export interface InvocationReason {
  /**
   * Human-readable description of the external event that causes the handler
   * to be called.
   * E.g. "Incoming RX data packet from hardware matched BPF filter criteria"
   *      "WMI command WMI_BPF_SET_VDEV_INSTRUCTIONS_CMDID received from host"
   *      "OS timer bpf_traffic_timer fires after APF_ADAPTIVE_TO_NON_APF_TIMER_MS"
   *      "PHY power-state change event (pre/post sleep/wake)"
   *      "Vdev state-change notification (up/down/delete)"
   */
  runtimeTrigger: string

  /**
   * Ordered list of function names from the runtime trigger to the target,
   * inclusive of both endpoints.
   * E.g. ["offloadif_data_ind", "_offldmgr_protocol_data_handler",
   *        "_offldmgr_enhanced_data_handler", "wlan_bpf_filter_offload_handler"]
   */
  dispatchChain: string[]

  /**
   * The specific call site where the fn-ptr stored by the registration API
   * is actually invoked.
   */
  dispatchSite: DispatchSite

  /**
   * The registration gate: who put the handler into the dispatch table
   * and under what conditions it is active.
   */
  registrationGate?: RegistrationGate
}

/**
 * Canonical invoker-centric record for frontend and cache consumers.
 * Registration fields are intentionally excluded here.
 */
export interface RuntimeFlowRecord {
  /** Target API/callback symbol being invoked. */
  targetApi: string
  /** Human-readable external trigger. */
  runtimeTrigger: string
  /** Ordered runtime invocation chain ending at targetApi. */
  dispatchChain: string[]
  /** Concrete source location where indirect invocation happens. */
  dispatchSite: DispatchSite
  /** Final function in dispatchChain that directly invokes targetApi. */
  immediateInvoker: string
}

// ---------------------------------------------------------------------------
// ReasonPath
//
// One complete indirect-caller reason path for a target symbol.
// Combines the invocation reason (why it's called) with evidence and
// provenance metadata.
// ---------------------------------------------------------------------------

export interface ReasonPath {
  targetSymbol: string

  // --- Invocation reason (the core answer) ---
  /**
   * Full invocation reason: runtime trigger + dispatch chain + dispatch site
   * + registration gate.  This is the primary output the user cares about.
   */
  invocationReason?: InvocationReason
  /** Canonical invoker-centric shape for consumers. */
  runtimeFlow?: RuntimeFlowRecord

  // --- Legacy / compatibility fields (kept for existing cache entries) ---
  registrarFn?: string
  registrationApi?: string
  storageFieldPath?: string
  dispatchSite?: { file: string; line: number }

  gates: string[]
  evidence: Array<{ role: string; file: string; line: number }>
  provenance: "deterministic" | "llm_validated"
  confidence: { score: number; reasons: string[] }

  /**
   * Parameter name in the registration API body that holds the target callback.
   * e.g. "data_handler" in _offldmgr_register_data_offload body.
   * Set by the auto-classifier; absent in LLM-derived entries.
   */
  callbackParamName?: string

  /**
   * 0-based index of the callback arg in the registration call.
   * e.g. 2 for _offldmgr_register_data_offload(type, name, data_handler, ...)
   * Set by the auto-classifier; absent in LLM-derived entries.
   */
  callbackArgIndex?: number
}

// ---------------------------------------------------------------------------
// LlmDbEntry — persisted cache entry
// ---------------------------------------------------------------------------

export interface LlmDbEntry {
  connectionKey: string
  targetSymbol: string
  reasonPaths: ReasonPath[]
  requiredFiles: string[]
  hashManifest: Record<string, string>
  createdAt: string
  schemaVersion: string
}
