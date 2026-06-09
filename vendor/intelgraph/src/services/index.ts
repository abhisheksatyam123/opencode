/**
 * services/index.ts — Barrel re-export for the transport-agnostic service layer.
 *
 * Adapters (HTTP, CLI) import from here; they must not import from
 * transport tool definitions or ToolDef contracts.
 */

export type { AppContext } from "./app-context.js"
export { executeQuery } from "./query-service.js"
export type { QueryResult, QueryResponse, QueryError } from "./query-service.js"
