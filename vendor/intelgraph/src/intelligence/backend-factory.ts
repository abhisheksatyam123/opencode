/**
 * backend-factory.ts — wires up an IntelligenceBackend backed by
 * SQLite (via Drizzle + better-sqlite3).
 *
 * This is the only backend factory — intelgraph has zero external
 * service dependencies for its intelligence layer.
 *
 * The backend talks to a local .intelgraph/intelligence.db file (legacy:
 * .intelgraph/intelligence.db) or :memory: in tests. The path is passed
 * directly as a string by init.ts, which reads INTELLIGENCE_DB_PATH from env.
 */

import type { IntelligenceBackend, LspClientForExtraction } from "./backend-types.js"
import type { OrchestratorRunnerDeps } from "./orchestrator-runner.js"
import type { IExtractionAdapter } from "./contracts/extraction-adapter.js"
import { ClangdExtractionAdapter } from "./db/extraction/clangd-extraction-adapter.js"
import type { SqliteClient } from "./db/sqlite/client.js"
import { createSqliteStore } from "./db/sqlite/factory.js"
import { SqliteGraphProjectionService } from "./db/sqlite/projection-service.js"
import { IndirectCallerIngestionService } from "./db/ingestion/indirect-caller-ingestion-service.js"
import type { IIndirectCallerIngestion } from "./contracts/indirect-caller-ingestion.js"
import type { IDbFoundation } from "./contracts/db-foundation.js"

export type { IntelligenceBackend, LspClientForExtraction }

/**
 * Extended IntelligenceBackend shape that carries the SqliteClient
 * handle so init.ts can close it on shutdown.
 */
export interface SqliteIntelligenceBackend extends IntelligenceBackend {
  readonly sqliteClient: SqliteClient
}

export async function createIntelligenceBackend(
  dbPath: string,
  enrichers: Pick<OrchestratorRunnerDeps, "clangdEnricher" | "cParserEnricher" | "llmEnricher">,
  lspClient?: LspClientForExtraction,
): Promise<SqliteIntelligenceBackend> {
  const { client: sqliteClient, foundation: db, sink, lookup } = createSqliteStore({ path: dbPath })
  await db.initSchema()
  const projection = new SqliteGraphProjectionService()

  const extractor: IExtractionAdapter = new ClangdExtractionAdapter(
    lspClient ?? {
      documentSymbol: async () => [],
      incomingCalls: async () => [],
      outgoingCalls: async () => [],
    },
    sink,
  )

  // The indirect-caller ingestion service needs a SymbolFinder (hasSymbol)
  // and a GraphWriteSink. SqliteGraphStore implements both.
  const ingestion = new IndirectCallerIngestionService(sink, sink)

  const deps: OrchestratorRunnerDeps = {
    persistence: {
      dbLookup: lookup,
      authoritativeStore: {
        persistEnrichment: async (_request, result) => result.persistedRows,
      },
      graphProjection: projection,
    },
    ...enrichers,
  }

  return {
    deps,
    db: db as IDbFoundation,
    ingestion: ingestion as IIndirectCallerIngestion,
    extractor,
    sink,
    sqliteClient,
    close: async () => {
      sqliteClient.close()
    },
  }
}
