import type { ILanguageClient } from "../lsp/ports.js"
import type { IndexTracker } from "../tracking/index.js"
import type { UnifiedBackend } from "../backend/unified-backend.js"

/** All runtime dependencies needed to serve API tool calls. */
export interface BackendDeps {
  getClient: () => Promise<ILanguageClient>
  tracker: IndexTracker
  backend: UnifiedBackend
  /** Workspace root path — used by file/API routes for confinement. */
  workspaceRoot?: string
  /** Optional hook invoked during HTTP daemon graceful exit. */
  onGracefulShutdown?: () => Promise<void>
}
