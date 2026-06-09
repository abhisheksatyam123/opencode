/**
 * pattern-detector/ports.ts — Types for the parser-based indirect caller detector.
 */

import type { ILanguageClient } from "../../lsp/ports.js"
import type { FunctionCall } from "./c-parser.js"

/** Connection kind — how the callback is invoked at runtime. */
export type PatternConnectionKind =
  | "api_call"                // direct fn-ptr invocation
  | "hw_interrupt"            // hardware interrupt routed to callback
  | "event"                   // event/message dispatch table
  | "ring_signal"             // signal/ring-based dispatch
  | "interface_registration"  // ops/vtable registration
  | "custom"                  // unknown mechanism

/**
 * A call-name based classification rule.
 * Matched by the function name returned from the C parser.
 */
export interface CallPattern {
  /** Unique pattern name. */
  name: string
  /** Registration API name (the call name). */
  registrationApi: string
  /** Connection kind produced by this pattern. */
  connectionKind: PatternConnectionKind
  /** 0-based argument index that contains the dispatch key. */
  keyArgIndex: number
  /** Description of what the key represents. */
  keyDescription: string
}

/**
 * A struct-initializer classification rule.
 * Matched by checking if a reference falls inside an initializer list
 * that contains a specific marker in the given argument position.
 */
export interface InitPattern {
  /** Unique pattern name. */
  name: string
  /** Registration table name. */
  registrationApi: string
  /** Connection kind. */
  connectionKind: PatternConnectionKind
  /** 0-based arg index that must contain the marker. */
  markerArgIndex: number
  /** Regex the marker arg must match. */
  markerRegex: RegExp
  /** 0-based arg index for the dispatch key (the CMDID). */
  keyArgIndex: number
  /** Description of the key. */
  keyDescription: string
}

/** Classification result for a single reference site. */
export interface ClassifiedSite {
  /** The callback function name at this site. */
  callbackName: string
  /** Absolute file path of the reference site. */
  filePath: string
  /** 0-based line number of the reference site. */
  line: number
  /** 0-based character offset. */
  character: number
  /** Source text of the enclosing call/construct (trimmed). */
  sourceText: string
  /** Which pattern matched. null if no pattern matched. */
  matchedPattern: CallPattern | InitPattern | null
  /** Extracted dispatch key. null if no match. */
  dispatchKey: string | null
  /** Connection kind. */
  connectionKind: PatternConnectionKind
  /** Registration API name. null if no match. */
  viaRegistrationApi: string | null
  /** The enclosing call/construct found by the parser. null if parser found nothing. */
  enclosingCall: FunctionCall | null
  /**
   * Parameter name in the registration API body that holds the target callback.
   * Set by the auto-classifier; absent for registry-based classifications.
   * Passed to resolveChain() as callbackParamName.
   */
  callbackParamName?: string
  /**
   * 0-based index of the callback arg in the registration call.
   * Set by the auto-classifier; absent for registry-based classifications.
   */
  callbackArgIndex?: number
}

/** Result of pattern detection for a target function. */
export interface PatternDetectionResult {
  /** Resolved target symbol. */
  seed: { name: string; file: string; line: number } | null
  /** All classified reference sites. */
  sites: ClassifiedSite[]
  /** Sites where a pattern matched (indirect callers). */
  matchedSites: ClassifiedSite[]
  /** Sites where no pattern matched (unclassified). */
  unclassifiedSites: ClassifiedSite[]
}

/** Input to the detector. */
export interface DetectorInput {
  /** Target file path. */
  file: string
  /** 1-based line number. */
  line: number
  /** 1-based character offset. */
  character: number
  /** Maximum number of sites to process. */
  maxNodes?: number
}

/** Dependencies injected into the detector. */
export interface DetectorDeps {
  /** LSP client for references() and prepareCallHierarchy(). */
  lspClient: Pick<ILanguageClient, "references" | "prepareCallHierarchy">
  /** Read a FULL source file (for parser-based enclosing call detection). */
  readFile: (filePath: string) => string
  /**
   * Optional auto-classifier deps. When provided, unknown registration calls
   * (not in the registry) are classified via LSP hover() + definition().
   * When absent, unknown calls fall through to unclassified (backward compat).
   */
  autoClassifier?: {
    lspClientFull: {
      hover: (file: string, line: number, char: number) => Promise<any>
      definition: (file: string, line: number, char: number) => Promise<any[]>
    }
    readFile: (filePath: string) => string
  }
}
