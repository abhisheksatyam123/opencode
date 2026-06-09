import type { ICallerResolver, CallerResolutionQuery } from "../ports.js"
import type { GetCallersResponse } from "../get-callers.js"
import type { ILanguageClient } from "../../lsp/ports.js"
import type { IndexTracker } from "../../tracking/index.js"
import type { UnifiedBackend } from "../../backend/unified-backend.js"
import type { OrchestratorRunnerDeps } from "../../intelligence/contracts/orchestrator-runner-deps.js"

/**
 * In-memory ICallerResolver. Returns a seeded response per (file, line,
 * character) tuple; default response is an empty waterfall.
 *
 * The real resolver walks a 5-step fallback chain (LLM → runtime DB →
 * static DB → LSP → direct calls). Tests that need to assert "which
 * step won" can inspect `resolveCallers`'s response.source field; the
 * fake respects whatever value the test seeds.
 */
export class FakeCallerResolver implements ICallerResolver {
  private seeds = new Map<string, GetCallersResponse>()
  readonly calls: Array<{
    args: CallerResolutionQuery
    backendPresent: boolean
    depsPresent: boolean
  }> = []

  /** Register a response for a specific query. Keyed by (file, line, character). */
  seed(query: CallerResolutionQuery, response: GetCallersResponse): void {
    this.seeds.set(this.key(query), response)
  }

  async resolveCallers(
    _client: ILanguageClient,
    _tracker: IndexTracker,
    backend: UnifiedBackend | null,
    intelligenceDeps: OrchestratorRunnerDeps | null,
    args: CallerResolutionQuery,
  ): Promise<GetCallersResponse> {
    this.calls.push({
      args,
      backendPresent: backend !== null,
      depsPresent: intelligenceDeps !== null,
    })
    const hit = this.seeds.get(this.key(args))
    if (hit) return hit
    return {
      targetApi: "",
      targetFile: args.file,
      targetLine: args.line,
      callers: [],
      registrars: [],
      source: "none",
      provenance: {
        stepsAttempted: [],
        stepUsed: "none",
        aliasVariantsTriedForDb: false,
        aliasVariantsTried: [],
      },
    }
  }

  private key(q: CallerResolutionQuery): string {
    return `${q.file}:${q.line}:${q.character}`
  }
}
