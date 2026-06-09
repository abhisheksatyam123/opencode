/**
 * contract.ts — the IExtractor plugin contract.
 *
 * Plugins implement IExtractor. Their job is small: declare metadata, then
 * yield Facts via an async generator. Everything else (snapshot lifecycle,
 * deduplication, provenance tagging, schema validation, batched writes,
 * error isolation, telemetry, cancellation) is handled by the FactBus and
 * ExtractorRunner so plugin authors never have to think about it.
 *
 * The contract is intentionally tiny — three types and one helper.
 *
 * Position in the pipeline:
 *
 *   ingest-tool → ExtractorRunner → IExtractor.extract(ctx) → FactBus → GraphWriteSink
 *
 * For the full design, see /home/abhi/.claude/plans/zippy-mapping-flurry.md
 */

import type { ExtractionContext } from "./context.js"
import type { Fact } from "./facts.js"

// ---------------------------------------------------------------------------
// Capability vocabulary
// ---------------------------------------------------------------------------

/**
 * What kinds of facts an extractor declares it can produce. The runner uses
 * these to skip extractors whose capabilities are not needed by the active
 * intent set, and the FactBus tracks which capabilities a snapshot actually
 * exercised so query-time fallback (LLM advisor, etc.) knows what is
 * authoritatively absent vs. simply not yet attempted.
 *
 * The vocabulary is a closed enum on purpose. New capabilities are added
 * here as the system grows; plugins may not declare arbitrary strings.
 */
export type Capability =
  | "symbols" // function/struct/typedef/etc declarations
  | "types" // type information (signature, layout)
  | "aggregate-fields" // struct/union field information
  | "direct-calls" // call_expression edges from outgoingCalls
  | "incoming-calls" // reverse call edges
  | "callback-registration" // registers_callback edges
  | "dispatch-resolution" // dispatches_to edges
  | "field-access" // reads_field, writes_field
  | "macro-expansion" // uses_macro
  | "runtime-traces" // runtime_calls, observations
  | "log-events" // logs_event

// ---------------------------------------------------------------------------
// Workspace probe (minimal — full probe is Problem 5)
// ---------------------------------------------------------------------------

/**
 * Minimal workspace metadata an extractor can use to opt out of workspaces
 * it does not apply to. Will grow when Problem 5 (workspace probe + auto-
 * config) lands; for now it carries only what the existing code already
 * knows at activation time.
 */
export interface WorkspaceProbe {
  readonly workspaceRoot: string
  /** Whether compile_commands.json was found at the workspace root. */
  readonly hasCompileCommands: boolean
}

// ---------------------------------------------------------------------------
// Extractor metadata
// ---------------------------------------------------------------------------

/**
 * Static description of a plugin. Declared once per plugin; never mutated.
 *
 * Authoring guidance:
 *  - `name` should be kebab-case and stable. It appears in fact provenance
 *    and in the runner report. Renaming it after release breaks any cached
 *    snapshot whose facts cite the old name.
 *  - `version` is informational for now (Problem 1). Problem 7 will add
 *    semver enforcement and contract compatibility checking.
 *  - `capabilities` should list every kind the plugin can produce. Listing
 *    extra capabilities is forgiven; missing capabilities means the runner
 *    may skip the plugin when it would have been useful.
 *  - `appliesTo` is optional. If absent, the plugin runs on every workspace.
 *    Use it for project-specific plugins (e.g. WLAN-only) or language-
 *    specific ones once probe metadata grows in Problem 5.
 */
export interface ExtractorMetadata {
  readonly name: string
  readonly version: string
  readonly description?: string
  readonly capabilities: readonly Capability[]
  readonly appliesTo?: (probe: WorkspaceProbe) => boolean
}

// ---------------------------------------------------------------------------
// IExtractor — the plugin contract itself
// ---------------------------------------------------------------------------

/**
 * The whole plugin contract. Implementations are small: a metadata object
 * plus an async generator that yields Facts via the helpers on `ctx`.
 *
 * Plugins must NOT:
 *  - construct Fact objects directly (use ctx.symbol/edge/evidence/observation)
 *  - touch the storage backend directly
 *  - manage their own snapshot or transaction lifecycle
 *  - do their own deduplication, batching, or retry
 *  - hold long-lived state across snapshots (the bus is per-snapshot)
 *
 * Plugins MAY:
 *  - use ctx.lsp.*, ctx.treesitter.*, ctx.ripgrep.*, ctx.workspace.* freely
 *  - cache within a snapshot via ctx.cache
 *  - log via ctx.log and emit metrics via ctx.metrics
 *  - check ctx.signal.aborted to bail out early on cancellation
 *  - throw — the runner catches per-plugin and reports the error without
 *    failing the whole snapshot
 */
export interface IExtractor {
  readonly metadata: ExtractorMetadata
  extract(ctx: ExtractionContext): AsyncIterable<Fact>
}

// ---------------------------------------------------------------------------
// defineExtractor — identity helper
// ---------------------------------------------------------------------------

/**
 * Identity helper for plugin authors. Currently a no-op pass-through; exists
 * so future runtime checks (capability validation, version compatibility,
 * registration side-effects) can hook in without changing every plugin.
 *
 * Idiomatic usage:
 *
 *   export default defineExtractor({
 *     metadata: {
 *       name: "my-extractor",
 *       version: "0.1.0",
 *       capabilities: ["symbols", "direct-calls"],
 *     },
 *     async *extract(ctx) {
 *       for (const file of await ctx.workspace.walkFiles({ extensions: [".c"] })) {
 *         const symbols = await ctx.lsp.documentSymbol(file)
 *         for (const sym of symbols) {
 *           yield ctx.symbol({ payload: { ...sym, kind: "function" } })
 *         }
 *       }
 *     },
 *   })
 */
export function defineExtractor(extractor: IExtractor): IExtractor {
  return extractor
}
