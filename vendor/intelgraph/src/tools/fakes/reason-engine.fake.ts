import type {
  IReasonEngine,
  ReasonEngineInput,
  ReasonEngineResult,
  LlmReasoningConfig,
} from "../reason-engine/ports.js"
import type { ILanguageClient } from "../../lsp/ports.js"
import type { ReasonPath } from "../reason-engine/contracts.js"

/**
 * In-memory IReasonEngine. Returns a seeded result by symbol; default
 * result is empty reasonPaths, no LLM, cacheMiss.
 *
 * Tests can seed specific responses with `seedResult(symbol, result)`.
 */
export class FakeReasonEngine implements IReasonEngine {
  private seeds = new Map<string, ReasonEngineResult>()
  readonly calls: Array<{ input: ReasonEngineInput; llmConfig?: LlmReasoningConfig }> = []

  seedResult(targetSymbol: string, result: ReasonEngineResult): void {
    this.seeds.set(targetSymbol, result)
  }

  /** Shortcut: seed just the reason paths; other fields default sensibly. */
  seedPaths(targetSymbol: string, reasonPaths: ReasonPath[]): void {
    this.seedResult(targetSymbol, {
      reasonPaths,
      usedLlm: false,
      rejected: 0,
      cacheHit: false,
      cacheMismatchedFiles: [],
    })
  }

  async run(
    _client: ILanguageClient,
    input: ReasonEngineInput,
    llmConfig?: LlmReasoningConfig,
  ): Promise<ReasonEngineResult> {
    this.calls.push({ input, llmConfig })
    const hit = this.seeds.get(input.targetSymbol)
    if (hit) return hit
    return {
      reasonPaths: [],
      usedLlm: false,
      rejected: 0,
      cacheHit: false,
      cacheMismatchedFiles: [],
    }
  }
}
