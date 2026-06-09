/**
 * Port for the DB-row → node-protocol serialization boundary.
 *
 * The concrete implementation (`src/intelligence/query-node-adapter.ts`)
 * converts a `NormalizedQueryResponse` (raw DB rows) into a strongly-typed
 * `NodeProtocolResponse` that downstream consumers (the TUI, future web UIs,
 * LSP clients) can trust to satisfy `nodeResponseSchema`.
 *
 * Fake impl: `fakes/query-node-adapter.fake.ts` — returns schema-valid
 * minimal responses without running the row-to-protocol machinery.
 *
 * The 4 helper mappers (`mapEdgeKindVerbose`, `mapRowEdgeKindToProtocolEdgeKind`,
 * `protoEdgeKindToLegacyKind`, `mapRowDerivationToSources`) stay as
 * module-level exports on the concrete impl — they are independent
 * utilities covered by their own test files under
 * `test/contracts/schemas/`.
 */

import type { NodeProtocolResponse } from "./node-protocol.js"
import type { NormalizedQueryResponse, QueryRequest } from "./orchestrator.js"
import type { LegacyFlatResponse } from "../query-node-adapter.js"

export type { LegacyFlatResponse }

export interface IQueryNodeAdapter {
  /**
   * Serialize a successful/enriched/not-found `NormalizedQueryResponse`
   * into a `NodeProtocolResponse`. The output MUST satisfy
   * `nodeResponseSchema`; the real impl enforces this with `.parse()`.
   */
  toNodeResponse(req: QueryRequest, res: NormalizedQueryResponse): NodeProtocolResponse

  /**
   * Build an `error`-status `NodeProtocolResponse` from a list of error
   * messages. Used when the request itself fails validation or the
   * downstream query throws — before any row could be fetched.
   */
  toNodeErrorResponse(args: { intent?: string; snapshotId?: number; errors: string[] }): NodeProtocolResponse

  /**
   * Flatten a `NodeProtocolResponse` into the legacy `{nodes, edges}`
   * shape the TUI frontend consumes. Preserves the full protocol payload
   * under `nodeProtocol` as a forward-compat escape hatch.
   */
  toLegacyFlatResponse(proto: NodeProtocolResponse): LegacyFlatResponse
}
