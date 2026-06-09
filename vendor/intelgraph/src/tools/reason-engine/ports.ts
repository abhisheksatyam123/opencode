/**
 * Reason-engine port.
 *
 * The reason engine resolves "why is this API invoked at runtime?" for
 * a target symbol by combining static evidence with an LLM-assisted
 * proposal-generation + validation loop. It owns an LLM cache on disk
 * so repeated queries don't re-invoke the LLM.
 *
 * Production impl: src/tools/reason-engine/index.ts, exposed as
 * `reasonEngine: IReasonEngine` at the bottom of that file.
 *
 * Fake impl: src/tools/fakes/reason-engine.fake.ts — returns seeded
 * reason paths and records calls for assertion.
 */

import type { ILanguageClient } from "../../lsp/ports.js"
import type { LlmReasoningConfig } from "./llm-advisor.js"
import type { ReasonPath } from "./contracts.js"
import type { ReasonEngineInput } from "./index.js"

export interface ReasonEngineResult {
  reasonPaths: ReasonPath[]
  usedLlm: boolean
  rejected: number
  cacheHit: boolean
  cacheMismatchedFiles: string[]
}

export interface IReasonEngine {
  run(
    client: ILanguageClient,
    input: ReasonEngineInput,
    llmConfig?: LlmReasoningConfig,
  ): Promise<ReasonEngineResult>
}

export type { ReasonEngineInput, LlmReasoningConfig, ReasonPath }
