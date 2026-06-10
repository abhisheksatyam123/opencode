/**
 * AppCommandMap — the full typed command registry for the production RequestBus.
 *
 * This file is the authoritative TypeScript source for all command kinds.
 * It is assembled here (not in composition-root.ts) so that modules that only
 * need to SEND commands can import the map without importing composition-root.
 *
 * Contract: project/specification/intelgraph-command-map.md
 *
 * Status markers (see spec note for details):
 *   [stub]  — type shape not yet finalized
 *   [draft] — types defined, handler not yet wired
 *   [live]  — handler wired, old shim removed
 */

import type { Command } from "./types.js"

// ── Fence types (must not change shape) ───────────────────────────────────────
// Imported from their authoritative locations; not redefined here.
import type { QueryRequest, NormalizedQueryResponse } from "../intelligence/contracts/orchestrator.js"

// ── Supporting payload/response types ─────────────────────────────────────────
// These will move to per-module ports.ts files as each module migrates.
// Defined here temporarily so the map compiles before modules are refactored.

export type SnapshotId = number

export interface BeginSnapshotRequest {
  workspaceRoot: string
  label?: string
}

export interface FailSnapshotRequest {
  id: SnapshotId
  err: Error
}

export interface GetLatestSnapshotRequest {
  workspaceRoot: string
}

export interface DbLookupResult {
  hit: boolean
  rows: Array<Record<string, unknown>>
}

export interface IngestRequest {
  workspaceRoot: string
  snapshotId: number
  signal?: AbortSignal
}

export interface RunnerReport {
  snapshotId: number
  plugins: Array<{
    name: string
    status: "ok" | "error" | "skipped"
    factsYielded: number
    durationMs: number
    errorMessage?: string
  }>
  totalFacts: number
  durationMs: number
}

export interface ExtractFileRequest {
  workspaceRoot: string
  filePath: string
  snapshotId: number
}

export interface FileExtractionReport {
  factsYielded: number
  durationMs: number
}

export interface ToolDispatchRequest {
  toolName: string
  input: unknown
  requestId: string
}

export interface ToolDispatchResult {
  text: string
  isError?: boolean
}

// ── AppCommandMap ─────────────────────────────────────────────────────────────

export type AppCommandMap = {
  // Query layer — [draft]
  query: Command<"query", QueryRequest, NormalizedQueryResponse>
  "db.lookup": Command<"db.lookup", QueryRequest, DbLookupResult>

  // Ingest / extraction layer — [draft]
  ingest: Command<"ingest", IngestRequest, RunnerReport>
  "ingest.extractFile": Command<"ingest.extractFile", ExtractFileRequest, FileExtractionReport>

  // Snapshot lifecycle — [draft]
  "snapshot.begin": Command<"snapshot.begin", BeginSnapshotRequest, SnapshotId>
  "snapshot.commit": Command<"snapshot.commit", SnapshotId, void>
  "snapshot.fail": Command<"snapshot.fail", FailSnapshotRequest, void>
  "snapshot.getLatest": Command<"snapshot.getLatest", GetLatestSnapshotRequest, SnapshotId | null>

  // LSP / infrastructure — [stub]
  "lsp.getClient": Command<"lsp.getClient", void, unknown> // ILanguageClient | null — typed once lsp/ports.ts exists

  // Tool dispatch — [stub]
  "tool.dispatch": Command<"tool.dispatch", ToolDispatchRequest, ToolDispatchResult>
}
