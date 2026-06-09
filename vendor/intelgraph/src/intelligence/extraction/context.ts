/**
 * context.ts — the ExtractionContext interface and implementation.
 *
 * The `ctx` object passed to every plugin invocation. It exposes the parsing
 * services (LSP, tree-sitter, ripgrep, workspace) plus typed fact builders
 * that construct Facts with provenance pre-tagged.
 *
 * Plugins use the builders by yielding their results:
 *
 *     async *extract(ctx) {
 *       for (const file of await ctx.workspace.walkFiles(...)) {
 *         const symbols = await ctx.lsp.documentSymbol(file, ctx.workspace.readFile(file)!)
 *         for (const sym of symbols.value ?? []) {
 *           yield ctx.symbol({ payload: { name: sym.name, kind: "function" } })
 *         }
 *       }
 *     }
 *
 * The runner consumes the AsyncIterable and emits each yielded fact into
 * the FactBus. ctx.symbol/edge/etc therefore stay synchronous: they only
 * build the envelope, never touch storage. This separates plugin
 * responsibility (build facts) from runner responsibility (emit, dedupe,
 * write).
 */

import type {
  AggregateFieldFactInput,
  EdgeFactInput,
  EvidenceFactInput,
  ObservationFactInput,
  SymbolFactInput,
  TypeFactInput,
} from "./facts.js"
import type {
  AggregateFieldFact,
  EdgeFact,
  EvidenceFact,
  ObservationFact,
  SymbolFact,
  TypeFact,
} from "./facts.js"
import type { SourceLocation } from "../contracts/common.js"
import type {
  LspService,
  TreeSitterService,
  RipgrepService,
  WorkspaceService,
} from "./services/index.js"
import { loggerPort } from "../../logging/logger.js"

const _log = loggerPort.child("extraction:context")

// Re-export the service interfaces so consumers of context.ts get the
// whole ctx surface from one import.
export type { LspService, TreeSitterService, RipgrepService, WorkspaceService }

// ---------------------------------------------------------------------------
// Operational helpers exposed on ctx
// ---------------------------------------------------------------------------

/**
 * A small in-snapshot key/value cache. Lifetime is one snapshot — when the
 * runner finishes the snapshot the cache is dropped. Plugins use it to
 * memoize expensive operations (e.g. "I already parsed this file") so the
 * core does not have to thread shared caches between plugins.
 */
export interface KeyedCache {
  get<T>(key: string): T | undefined
  set<T>(key: string, value: T): void
  has(key: string): boolean
  /**
   * Convenience: get if present, else compute, store, and return. The
   * compute function is called at most once per key per snapshot.
   */
  getOrCompute<T>(key: string, compute: () => Promise<T> | T): Promise<T>
}

/**
 * Per-plugin logger. Tags every message with the extractor name so the
 * aggregated runner report shows where messages came from.
 */
export interface PluginLogger {
  debug(message: string, context?: Record<string, unknown>): void
  info(message: string, context?: Record<string, unknown>): void
  warn(message: string, context?: Record<string, unknown>): void
  error(message: string, context?: Record<string, unknown>): void
}

/**
 * Per-plugin metrics sink. Counters and timings are aggregated by the
 * runner into the per-snapshot IngestReport.
 */
export interface PluginMetrics {
  count(name: string, n?: number): void
  timing(name: string, ms: number): void
}

// ---------------------------------------------------------------------------
// ExtractionContext — what plugins receive
// ---------------------------------------------------------------------------

/**
 * The object passed to every plugin's extract() generator. Plugins use this
 * to:
 *  - access parsing services (LSP, tree-sitter, ripgrep, workspace)
 *  - build typed facts via ctx.symbol/edge/evidence/observation
 *  - cache work within a snapshot
 *  - log and emit metrics
 *  - check for cancellation via ctx.signal
 *
 * Plugins should treat the ctx as read-only apart from calling its methods.
 * They must not stash references to it across snapshots — the runner builds
 * a fresh ctx per (plugin, snapshot) pair.
 */
export interface ExtractionContext {
  // --- Identity ---

  /** Snapshot the bus will write facts into. */
  readonly snapshotId: number
  /** Workspace root the plugin is operating on. */
  readonly workspaceRoot: string
  /**
   * Name of the plugin this ctx belongs to. Used for auto-provenance on
   * every emitted fact. Read-only.
   */
  readonly extractorName: string

  // --- Parsing services (full surface lands in Step 2) ---

  readonly lsp: LspService
  readonly treesitter: TreeSitterService
  readonly ripgrep: RipgrepService
  readonly workspace: WorkspaceService

  // --- Fact builders (auto-tag with producedBy = [extractorName]) ---

  /**
   * Build and enqueue a SymbolFact into the FactBus. Returns the constructed
   * fact for plugin convenience (e.g. when the plugin wants to attach
   * evidence to it later by canonical key).
   */
  symbol(input: SymbolFactInput): SymbolFact

  /** Build and enqueue a TypeFact. */
  type(input: TypeFactInput): TypeFact

  /** Build and enqueue an AggregateFieldFact. */
  aggregateField(input: AggregateFieldFactInput): AggregateFieldFact

  /** Build and enqueue an EdgeFact. */
  edge(input: EdgeFactInput): EdgeFact

  /** Build and enqueue an EvidenceFact attached to an existing fact. */
  evidence(input: EvidenceFactInput): EvidenceFact

  /** Build and enqueue an ObservationFact. */
  observation(input: ObservationFactInput): ObservationFact

  /**
   * Convenience for constructing a SourceLocation. Centralized so plugins
   * never have to remember the field naming (filePath vs file vs path,
   * line vs lineNumber, etc.).
   */
  location(filePath: string, line: number, column?: number): SourceLocation

  // --- Operational helpers ---

  readonly cache: KeyedCache
  readonly log: PluginLogger
  readonly metrics: PluginMetrics
  readonly signal: AbortSignal
}

// ---------------------------------------------------------------------------
// Implementations
// ---------------------------------------------------------------------------
//
// All concrete classes for the helpers exposed via ExtractionContext.
// They're small, single-purpose, and have no dependencies on the storage
// layer or the FactBus — the bus consumes the facts a plugin yields, but
// the context itself never touches the bus directly.

/**
 * In-snapshot keyed cache. Lifetime is one ExtractionContext instance
 * (which is scoped to one plugin invocation on one snapshot).
 */
export class InMemoryKeyedCache implements KeyedCache {
  private readonly store = new Map<string, unknown>()

  get<T>(key: string): T | undefined {
    return this.store.get(key) as T | undefined
  }

  set<T>(key: string, value: T): void {
    this.store.set(key, value as unknown)
  }

  has(key: string): boolean {
    return this.store.has(key)
  }

  async getOrCompute<T>(key: string, compute: () => Promise<T> | T): Promise<T> {
    if (this.store.has(key)) {
      return this.store.get(key) as T
    }
    const value = await compute()
    this.store.set(key, value as unknown)
    return value
  }
}

/**
 * Logger that prefixes every message with the extractor name. Plugins
 * call ctx.log.debug/info/warn/error; the runner can configure where the
 * output goes (console, file, structured sink). Default writes JSON-ish
 * lines to the console.error stream so they don't interleave with normal
 * JSON-RPC stdout traffic.
 */
export class PrefixedPluginLogger implements PluginLogger {
  constructor(
    private readonly extractorName: string,
    private readonly sink: (
      level: "debug" | "info" | "warn" | "error",
      line: string,
    ) => void = defaultLogSink,
  ) {}

  debug(message: string, context: Record<string, unknown> = {}): void {
    this.emit("debug", message, context)
  }
  info(message: string, context: Record<string, unknown> = {}): void {
    this.emit("info", message, context)
  }
  warn(message: string, context: Record<string, unknown> = {}): void {
    this.emit("warn", message, context)
  }
  error(message: string, context: Record<string, unknown> = {}): void {
    this.emit("error", message, context)
  }

  private emit(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    context: Record<string, unknown>,
  ): void {
    const ctxJson = Object.keys(context).length > 0 ? " " + JSON.stringify(context) : ""
    this.sink(level, `[${this.extractorName}] ${message}${ctxJson}`)
  }
}

function defaultLogSink(
  level: "debug" | "info" | "warn" | "error",
  line: string,
): void {
  if (level === "error") {
    _log.error(line)
  } else if (level === "warn") {
    _log.warn(line)
  } else if (level === "info") {
    _log.info(line)
  } else {
    _log.debug(line)
  }
}

/**
 * Per-plugin metrics sink. Counters and timings accumulate locally; the
 * runner drains them via snapshot() at the end of the plugin invocation
 * and folds them into the IngestReport.
 */
export class InMemoryPluginMetrics implements PluginMetrics {
  private readonly counters = new Map<string, number>()
  private readonly timings = new Map<string, { count: number; totalMs: number }>()

  count(name: string, n: number = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + n)
  }

  timing(name: string, ms: number): void {
    const existing = this.timings.get(name)
    if (existing) {
      existing.count += 1
      existing.totalMs += ms
    } else {
      this.timings.set(name, { count: 1, totalMs: ms })
    }
  }

  /**
   * Drain the accumulated metrics into a plain object. Called by the
   * runner once per plugin per snapshot.
   */
  snapshot(): {
    counters: Record<string, number>
    timings: Record<string, { count: number; totalMs: number; avgMs: number }>
  } {
    const counters: Record<string, number> = {}
    for (const [k, v] of this.counters.entries()) counters[k] = v
    const timings: Record<string, { count: number; totalMs: number; avgMs: number }> = {}
    for (const [k, v] of this.timings.entries()) {
      timings[k] = {
        count: v.count,
        totalMs: v.totalMs,
        avgMs: v.count > 0 ? v.totalMs / v.count : 0,
      }
    }
    return { counters, timings }
  }
}

// ---------------------------------------------------------------------------
// ExtractionContextImpl — the concrete class
// ---------------------------------------------------------------------------

export interface ExtractionContextOptions {
  snapshotId: number
  workspaceRoot: string
  extractorName: string
  lsp: LspService
  treesitter: TreeSitterService
  ripgrep: RipgrepService
  workspace: WorkspaceService
  signal?: AbortSignal
  logSink?: (
    level: "debug" | "info" | "warn" | "error",
    line: string,
  ) => void
}

/**
 * Concrete ExtractionContext. Constructed once per (plugin, snapshot)
 * pair by the ExtractorRunner. The fact builders return facts with
 * `producedBy: [extractorName]` already set; plugins yield those facts
 * and the runner emits them into the FactBus.
 */
export class ExtractionContextImpl implements ExtractionContext {
  readonly snapshotId: number
  readonly workspaceRoot: string
  readonly extractorName: string

  readonly lsp: LspService
  readonly treesitter: TreeSitterService
  readonly ripgrep: RipgrepService
  readonly workspace: WorkspaceService

  readonly cache: KeyedCache
  readonly log: PluginLogger
  readonly metrics: PluginMetrics
  readonly signal: AbortSignal

  // Public so the runner can drain metrics after extraction completes.
  readonly _metricsImpl: InMemoryPluginMetrics

  constructor(opts: ExtractionContextOptions) {
    this.snapshotId = opts.snapshotId
    this.workspaceRoot = opts.workspaceRoot
    this.extractorName = opts.extractorName
    this.lsp = opts.lsp
    this.treesitter = opts.treesitter
    this.ripgrep = opts.ripgrep
    this.workspace = opts.workspace
    this.cache = new InMemoryKeyedCache()
    this.log = new PrefixedPluginLogger(opts.extractorName, opts.logSink)
    this._metricsImpl = new InMemoryPluginMetrics()
    this.metrics = this._metricsImpl
    this.signal = opts.signal ?? new AbortController().signal
  }

  // -------------------------------------------------------------------------
  // Fact builders
  //
  // Each builder constructs a fully-formed Fact with the envelope filled
  // in (producedBy = [this.extractorName], confidence defaulting to 1.0).
  // The plugin yields the returned fact; the runner pumps it through the
  // FactBus, which validates, dedupes, batches, and writes.
  // -------------------------------------------------------------------------

  symbol(input: SymbolFactInput): SymbolFact {
    return {
      kind: "symbol",
      payload: input.payload,
      producedBy: [this.extractorName],
      confidence: input.confidence ?? 1.0,
    }
  }

  type(input: TypeFactInput): TypeFact {
    return {
      kind: "type",
      payload: input.payload,
      producedBy: [this.extractorName],
      confidence: input.confidence ?? 1.0,
    }
  }

  aggregateField(input: AggregateFieldFactInput): AggregateFieldFact {
    return {
      kind: "aggregate-field",
      payload: input.payload,
      producedBy: [this.extractorName],
      confidence: input.confidence ?? 1.0,
    }
  }

  edge(input: EdgeFactInput): EdgeFact {
    return {
      kind: "edge",
      payload: input.payload,
      producedBy: [this.extractorName],
      confidence: input.confidence ?? input.payload.confidence ?? 1.0,
    }
  }

  evidence(input: EvidenceFactInput): EvidenceFact {
    return {
      kind: "evidence",
      payload: input.payload,
      attachedTo: input.attachedTo,
      producedBy: [this.extractorName],
      confidence: input.confidence ?? 1.0,
    }
  }

  observation(input: ObservationFactInput): ObservationFact {
    return {
      kind: "observation",
      payload: input.payload,
      producedBy: [this.extractorName],
      confidence: input.confidence ?? 1.0,
    }
  }

  location(filePath: string, line: number, column?: number): SourceLocation {
    return { filePath, line, column }
  }
}
