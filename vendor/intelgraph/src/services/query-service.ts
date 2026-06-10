/**
 * query-service.ts — Transport-agnostic intelligence query service.
 *
 * Extracted from the `intelligence_query` transport-tool execute handler
 * (src/tools/index.ts:736-781). Returns typed NodeProtocolResponse
 * instead of a serialized string — adapters (HTTP, CLI) handle
 * serialization themselves.
 *
 * No transport imports. No ToolDef. No Promise<string> business logic.
 */

import { validateQueryRequest, executeOrchestratedQuery, queryNodeAdapter } from "../intelligence/public-api.js"
import type { NodeProtocolResponse } from "../intelligence/contracts/node-protocol.js"
import type { AppContext } from "./app-context.js"

// ── Public types ──────────────────────────────────────────────────────────────

/** Successful query result — a typed node-protocol response. */
export type QueryResponse = NodeProtocolResponse

/** Failed query result. */
export interface QueryError {
  ok: false
  errors: string[]
}

/** Union returned by executeQuery. */
export type QueryResult = QueryResponse | QueryError

// ── Service function ──────────────────────────────────────────────────────────

/**
 * Execute an intelligence query against the workspace graph.
 *
 * @param req  Raw (unvalidated) request object — typically parsed from
 *             JSON body (HTTP) or CLI flags.
 * @param ctx  Application context providing intelligence deps and workspace info.
 * @returns    Typed NodeProtocolResponse on success, or QueryError on failure.
 */
export async function executeQuery(req: unknown, ctx: AppContext): Promise<QueryResult> {
  // 1. Guard: intelligence backend must be initialized.
  if (!ctx.intelligenceDeps) {
    return { ok: false, errors: ["intelligence backend not initialized"] }
  }

  // 2. Auto-resolve snapshotId to latest ready snapshot when 0 or absent.
  let resolvedReq = req
  const reqObj = req as Record<string, unknown>
  if (!reqObj.snapshotId || (typeof reqObj.snapshotId === "number" && reqObj.snapshotId <= 0)) {
    if (ctx.dbFoundation) {
      try {
        const latest = await ctx.dbFoundation.getLatestReadySnapshot(ctx.workspaceRoot)
        if (latest?.snapshotId) {
          resolvedReq = { ...reqObj, snapshotId: latest.snapshotId }
        }
      } catch {
        // Use req as-is if snapshot resolution fails.
      }
    }
  }

  // 3. Validate the request.
  const validated = validateQueryRequest(resolvedReq)
  if (!validated.ok) {
    return { ok: false, errors: validated.errors }
  }

  // 4. Execute and shape the response.
  try {
    const res = await executeOrchestratedQuery(validated.value, ctx.intelligenceDeps)
    const nodeProto = queryNodeAdapter.toNodeResponse(validated.value, res)
    // Return the typed NodeProtocolResponse directly.
    // Adapters (HTTP/CLI) are responsible for serialization.
    return nodeProto
  } catch (err) {
    return {
      ok: false,
      errors: [err instanceof Error ? err.message : String(err)],
    }
  }
}
