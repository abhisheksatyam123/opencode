/**
 * AppEventMap — the full typed event registry for the production EventBus.
 *
 * Contract: project/specification/intelgraph-event-map.md
 *
 * Status markers:
 *   [stub]  — payload type not yet finalized
 *   [draft] — payload type defined, emitter not yet wired
 *   [live]  — emitter wired, at least one observer registered
 */

import type { BusEvent } from "./types.js"

// ── Payload types ─────────────────────────────────────────────────────────────

// Persistence layer — [draft]
export interface SnapshotBegan {
  id: number
  workspaceRoot: string
  label?: string
}

export interface SnapshotCommitted {
  id: number
  workspaceRoot: string
  durationMs: number
  totalFacts: number
}

export interface SnapshotFailed {
  id: number
  workspaceRoot: string
  errorMessage: string
}

// Extraction layer — [draft]
export interface PluginStarted {
  name: string
  version: string
  snapshotId: number
}

export interface PluginCompleted {
  name: string
  snapshotId: number
  factsYielded: number
  durationMs: number
  metrics: Record<string, number>
}

export interface PluginFailed {
  name: string
  snapshotId: number
  errorMessage: string
  durationMs: number
}

export interface ExtractionCompleted {
  snapshotId: number
  workspaceRoot: string
  totalFacts: number
  totalPlugins: number
  durationMs: number
}

// Orchestrator / query layer — [stub]
export interface EnrichmentStarted {
  requestId: string
  kind: "clangd" | "c_parser" | "llm"
  intent: string
}

export interface EnrichmentCompleted {
  requestId: string
  kind: string
  success: boolean
  durationMs: number
}

// Tool / transport layer — [draft]
export interface ToolCallReceived {
  toolName: string
  requestId: string
}

export interface ToolCallResponded {
  toolName: string
  requestId: string
  durationMs: number
  outcome: "ok" | "error"
}

// LSP / infrastructure — [stub]
export interface LspConnected {
  workspaceRoot: string
  port: number
  durationMs: number
}

export interface LspDisconnected {
  workspaceRoot: string
  reason: "graceful" | "error"
  errorMessage?: string
}

// ── AppEventMap ───────────────────────────────────────────────────────────────

export type AppEventMap = {
  // Persistence layer
  "snapshot.began":       BusEvent<"snapshot.began",       SnapshotBegan>
  "snapshot.committed":   BusEvent<"snapshot.committed",   SnapshotCommitted>
  "snapshot.failed":      BusEvent<"snapshot.failed",      SnapshotFailed>

  // Extraction layer
  "plugin.started":       BusEvent<"plugin.started",       PluginStarted>
  "plugin.completed":     BusEvent<"plugin.completed",     PluginCompleted>
  "plugin.failed":        BusEvent<"plugin.failed",        PluginFailed>
  "extraction.completed": BusEvent<"extraction.completed", ExtractionCompleted>

  // Orchestrator / query layer
  "enrichment.started":   BusEvent<"enrichment.started",   EnrichmentStarted>
  "enrichment.completed": BusEvent<"enrichment.completed", EnrichmentCompleted>

  // Tool / transport layer
  "toolCall.received":    BusEvent<"toolCall.received",    ToolCallReceived>
  "toolCall.responded":   BusEvent<"toolCall.responded",   ToolCallResponded>

  // LSP / infrastructure
  "lsp.connected":        BusEvent<"lsp.connected",        LspConnected>
  "lsp.disconnected":     BusEvent<"lsp.disconnected",     LspDisconnected>
}
