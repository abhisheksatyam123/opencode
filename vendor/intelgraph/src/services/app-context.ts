/**
 * app-context.ts — Transport-agnostic application context.
 *
 * Replaces `BackendDeps` as the composition root for services.
 * No transport coupling, no ToolDef, no Promise<string> business logic.
 */

import type { ILanguageClient } from "../lsp/ports.js"
import type { IndexTracker } from "../tracking/index.js"
import type { UnifiedBackend } from "../backend/unified-backend.js"
import type { OrchestratorRunnerDeps } from "../intelligence/contracts/orchestrator-runner-deps.js"
import type { IDbFoundation } from "../intelligence/contracts/db-foundation.js"

/**
 * Shared application context passed to all service functions.
 * Adapters (CLI, HTTP) build this once at startup and pass it through.
 */
export interface AppContext {
  /** Resolves the active LSP language client. */
  getClient: () => Promise<ILanguageClient>
  /** File-index tracker for workspace state. */
  tracker: IndexTracker
  /** Unified backend (symbol resolution, file ops). */
  backend: UnifiedBackend
  /** Absolute path to the workspace root. */
  workspaceRoot: string
  /** Optional shutdown hook called on graceful exit. */
  onShutdown?: () => Promise<void>
  /**
   * Intelligence query orchestrator deps.
   * Null when the intelligence backend has not been initialized yet.
   */
  intelligenceDeps: OrchestratorRunnerDeps | null
  /**
   * Database foundation for snapshot management.
   * Null when the intelligence backend has not been initialized yet.
   */
  dbFoundation: IDbFoundation | null
}
