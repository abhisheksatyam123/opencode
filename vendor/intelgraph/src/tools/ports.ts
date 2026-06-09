/**
 * Canonical tools-module ports.
 *
 * The `tools` module is the IntelGraph tool registry and its orchestration
 * helpers. Its internals mix genuinely pure utilities (formatters,
 * schemas) with stateful dispatch (the composition root's bindings for
 * UnifiedBackend and OrchestratorRunnerDeps) and with subsystem-sized
 * services (indirect-caller analysis, reason engine, caller waterfall).
 *
 * This file declares ports for the stateful / service-sized pieces.
 * Pure utilities stay as free functions in their home files — they
 * don't need an abstraction layer.
 *
 * Port inventory (all end up bound in src/tools/dispatch.ts for
 * production; fakes live in src/tools/fakes/):
 *
 *   IToolDispatcher          — backend + intelligence-deps wiring
 *   IIndirectCallerCache     — persistent cache for indirect-caller results
 *   IIndirectCallerProvider  — collect + format indirect-caller graphs
 *   ICallerResolver          — 5-step caller-resolution waterfall
 *
 * The reason engine keeps its own module-local port at
 * `src/tools/reason-engine/ports.ts`, since its contract shape is
 * self-contained and has no consumers outside the tools module.
 */

import type { ILanguageClient } from "../lsp/ports.js"
import type { IndexTracker } from "../tracking/index.js"
import type { UnifiedBackend } from "../backend/unified-backend.js"
import type { OrchestratorRunnerDeps } from "../intelligence/contracts/orchestrator-runner-deps.js"
import type {
  IndirectCallerGraph,
  IndirectCallerNode,
} from "./indirect-callers.js"
import type { GetCallersResponse } from "./get-callers.js"
import type { CachedIndirectCallers } from "./indirect-caller-cache.js"

// ── IToolDispatcher ──────────────────────────────────────────────────────────

/**
 * Owns the composition-root wiring for the tools module: which
 * UnifiedBackend is bound (for LSP-backed tools) and which
 * OrchestratorRunnerDeps is bound (for intelligence-backed tools).
 *
 * Production impl: the named functions in src/tools/dispatch.ts bundled
 * into a `toolDispatcher: IToolDispatcher` constant.
 *
 * Fake impl: FakeToolDispatcher records setter calls and supplies
 * configured backends without any real LSP/DB dependency.
 */
export interface IToolDispatcher {
  /** Bind the UnifiedBackend that LSP-facing tools use. Called once at boot. */
  setUnifiedBackend(backend: UnifiedBackend): void
  /** Bind the OrchestratorRunnerDeps that intelligence-facing tools use. */
  setIntelligenceDeps(deps: OrchestratorRunnerDeps): void
  /** Read the currently bound deps, or null if setIntelligenceDeps has not been called. */
  getIntelligenceDeps(): OrchestratorRunnerDeps | null
  /** Return the bound backend or throw if none has been wired. */
  unifiedBackendOrThrow(): UnifiedBackend
  /** Inflight-dedup key for indirect-caller requests. Pure function; kept here for cohesion with the dispatcher's dedup map. */
  inflightIndirectCallerKey(workspaceRoot: string, cacheKey: string): string
  /** Open the file in the LSP client (if not already open), wait for parse to settle, then run `fn`. */
  withFile(client: ILanguageClient, filePath: string, fn: () => Promise<string>): Promise<string>
}

// ── IIndirectCallerCache ─────────────────────────────────────────────────────

/**
 * Persistent cache for indirect-caller-graph computations. The
 * production impl writes JSON files under
 * <workspace>/.intelgraph-indirect-caller-cache/; the fake keeps
 * everything in an in-memory map.
 *
 * Staleness: reads include a list of evidence files. If any of those
 * files' SHA-256 has changed since the entry was written, `read()`
 * returns null and the caller re-computes.
 */
export interface IIndirectCallerCache {
  /** Hash the query triple (file + line + character) into a cache key. */
  computeKey(file: string, line: number, character: number): string
  /** Return cached result or null if missing / stale / schema-mismatched. */
  read(workspaceRoot: string, cacheKey: string, evidenceFiles: string[]): CachedIndirectCallers | null
  /** Persist a result. Overwrites any existing entry at the same key. */
  write(workspaceRoot: string, cacheKey: string, result: unknown, evidenceFiles: string[]): void
  /** Remove every cached entry for this workspace. Idempotent. */
  clear(workspaceRoot: string): void
}

// ── IIndirectCallerProvider ──────────────────────────────────────────────────

export interface IndirectCallerQuery {
  file: string
  line: number
  character: number
  maxNodes?: number
  resolve?: boolean
}

/**
 * The service that turns a location (file + line + char) into an
 * indirect-caller graph — combining LSP call-hierarchy evidence with
 * parser-driven registration classification.
 *
 * Production impl: src/tools/indirect-callers.ts, exposed as
 * `indirectCallerProvider: IIndirectCallerProvider` in dispatch.ts.
 *
 * Fake impl: FakeIndirectCallerProvider returns seeded graphs.
 */
export interface IIndirectCallerProvider {
  collectIndirectCallers(
    client: ILanguageClient,
    args: IndirectCallerQuery,
  ): Promise<IndirectCallerGraph>

  formatIndirectCallerTree(graph: IndirectCallerGraph, workspaceRoot: string): string
}

export type { IndirectCallerGraph, IndirectCallerNode }

// ── ICallerResolver ──────────────────────────────────────────────────────────

export interface CallerResolutionQuery {
  file: string
  line: number
  character: number
  snapshotId?: number
  maxNodes?: number
  resolve?: boolean
}

/**
 * The five-step caller-resolution waterfall: LLM → runtime DB →
 * static DB → LSP → direct calls. Encapsulates the fallback order so
 * tool implementations don't re-invent it.
 *
 * Production impl: src/tools/get-callers.ts.
 * Fake impl: FakeCallerResolver returns a seeded response and records
 * the query.
 */
export interface ICallerResolver {
  resolveCallers(
    client: ILanguageClient,
    tracker: IndexTracker,
    backend: UnifiedBackend | null,
    intelligenceDeps: OrchestratorRunnerDeps | null,
    args: CallerResolutionQuery,
  ): Promise<GetCallersResponse>
}

export type { GetCallersResponse }
