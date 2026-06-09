import type { IQueryNodeAdapter, LegacyFlatResponse } from "../query-node-adapter.js"
import type { NodeProtocolResponse } from "../node-protocol.js"
import { nodeResponseSchema } from "../node-protocol.js"
import type { NormalizedQueryResponse, QueryRequest } from "../orchestrator.js"

/**
 * In-memory IQueryNodeAdapter. Returns minimal schema-valid
 * `NodeProtocolResponse` envelopes with empty item lists, regardless of
 * the rows in the input `NormalizedQueryResponse`.
 *
 * Suitable for:
 *   - contract-test suites
 *   - consumer unit tests that need IQueryNodeAdapter without exercising
 *     the full row-to-protocol mapping machinery
 *
 * NOT suitable for: asserting real row-to-node conversion semantics —
 * those live in `test/unit/query-node-adapter.test.ts` and the schema
 * coverage under `test/contracts/schemas/`.
 */
export class FakeQueryNodeAdapter implements IQueryNodeAdapter {
  readonly calls: Array<{ kind: string; args: unknown }> = []

  toNodeResponse(req: QueryRequest, res: NormalizedQueryResponse): NodeProtocolResponse {
    this.calls.push({ kind: "toNodeResponse", args: { req, res } })
    const snapshotId = req.snapshotId > 0 ? req.snapshotId : 1
    return nodeResponseSchema.parse({
      protocol_version: "1.1",
      schema_capabilities: [],
      trace_id: "fake-trace",
      intent: req.intent,
      status: res.status,
      data: { items: [] },
      meta: {
        snapshot_id: snapshotId,
        workspace_root: "fake-workspace",
        total_estimate: 0,
        cursor: null,
        sort: "confidence_desc_name_asc",
      },
      errors: [],
    })
  }

  toNodeErrorResponse(args: { intent?: string; snapshotId?: number; errors: string[] }): NodeProtocolResponse {
    this.calls.push({ kind: "toNodeErrorResponse", args })
    const snapshotId = typeof args.snapshotId === "number" && args.snapshotId > 0 ? args.snapshotId : 1
    const intent = args.intent ?? "who_calls_api"
    return nodeResponseSchema.parse({
      protocol_version: "1.1",
      schema_capabilities: [],
      trace_id: "fake-trace",
      intent,
      status: "error",
      data: { items: [] },
      meta: {
        snapshot_id: snapshotId,
        workspace_root: "fake-workspace",
        total_estimate: 0,
        cursor: null,
        sort: "confidence_desc_name_asc",
      },
      errors: args.errors.map((message) => ({
        code: "INTERNAL_ERROR" as const,
        message,
        retryable: true,
      })),
    })
  }

  toLegacyFlatResponse(proto: NodeProtocolResponse): LegacyFlatResponse {
    this.calls.push({ kind: "toLegacyFlatResponse", args: { proto } })
    return {
      status: proto.status,
      data: { nodes: [], edges: [] },
      provenance: { trace_id: proto.trace_id, intent: proto.intent },
      nodeProtocol: proto,
    }
  }
}
