/**
 * Explicit cross-module boundary for non-intelligence modules.
 *
 * Tools/core code should import from this module (or from
 * intelligence/contracts/* for pure types), not from internal
 * implementation paths.
 */
export { QUERY_INTENTS, validateQueryRequest } from "./contracts/query-request.js"
export { executeOrchestratedQuery } from "./orchestrator-runner.js"
export { diffGraphJson } from "./db/sqlite/graph-export.js"
export { setDbFoundation, getDbFoundation, setIngestDeps, setExtractFileDeps } from "./tools/index.js"
export { queryNodeAdapter } from "./query-node-adapter.js"
export { createRipgrepService } from "./ripgrep-service.js"
export type { RipgrepService } from "./ripgrep-service.js"
