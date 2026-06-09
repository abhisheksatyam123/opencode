/**
 * backend-types.ts — storage-agnostic types for the intelligence backend.
 *
 * Extracted from backend-factory.ts to stay storage-agnostic. They describe the
 * IntelligenceBackend shape every storage implementation must satisfy and
 * the narrow LSP client surface that ingest paths actually depend on.
 */

import type { IDbFoundation } from "./contracts/db-foundation.js"
import type { IExtractionAdapter } from "./contracts/extraction-adapter.js"
import type { IIndirectCallerIngestion } from "./contracts/indirect-caller-ingestion.js"
import type { OrchestratorRunnerDeps } from "./orchestrator-runner.js"
import type { GraphWriteSink } from "./db/graph-rows.js"

export interface LspClientForExtraction {
  documentSymbol: (filePath: string) => Promise<Record<string, unknown>[]>
  incomingCalls: (
    filePath: string,
    line: number,
    char: number,
  ) => Promise<Record<string, unknown>[]>
  outgoingCalls: (
    filePath: string,
    line: number,
    char: number,
  ) => Promise<Record<string, unknown>[]>
}

export interface IntelligenceBackend {
  deps: OrchestratorRunnerDeps
  db: IDbFoundation
  ingestion: IIndirectCallerIngestion
  extractor: IExtractionAdapter
  /** Sink the ingest pipeline writes facts through. */
  sink: GraphWriteSink
  close(): Promise<void>
}
