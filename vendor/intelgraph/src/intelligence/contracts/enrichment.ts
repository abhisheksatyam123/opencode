/**
 * enrichment.ts — Enricher port interfaces and the orchestration state machine.
 *
 * Contains the enricher source hierarchy, FallbackPolicy, the enricher
 * interfaces (ClangdEnricher, CParserEnricher, LlmEnricher), and the
 * decideOrchestrationAction / shouldRunLlmFallback functions.
 * Extracted from orchestrator.ts to give this concern its own file.
 */

import type { QueryRequest } from "./query-request.js"

// ── Enricher source types ────────────────────────────────────────────────────

export type DeterministicEnricherSource = "clangd" | "c_parser" | "ts_core" | "rust_core"
export type EnricherSource = DeterministicEnricherSource | "llm"

// ── FallbackPolicy ───────────────────────────────────────────────────────────

export interface FallbackPolicy {
  /**
   * Ordered list of deterministic enrichers to try. May be empty (e.g. for
   * language workspaces with no deterministic enricher — LLM runs directly).
   */
  deterministicOrder: readonly DeterministicEnricherSource[]
  llmLastResort: boolean
  maxDeterministicPasses: number
}

export const DEFAULT_FALLBACK_POLICY: FallbackPolicy = {
  deterministicOrder: ["clangd", "c_parser"],
  llmLastResort: true,
  maxDeterministicPasses: 2,
}

// ── Enrichment types ─────────────────────────────────────────────────────────

export interface EnrichmentAttempt {
  source: EnricherSource
  status: "success" | "failed" | "skipped"
  reason?: string
}

export interface EnrichmentResult {
  attempts: EnrichmentAttempt[]
  persistedRows: number
}

export interface EnricherContext {
  policy: FallbackPolicy
  priorAttempts: EnrichmentAttempt[]
}

// ── Enricher port interfaces ──────────────────────────────────────────────────

export interface ClangdEnricher {
  readonly source: "clangd"
  enrich(request: QueryRequest, ctx: EnricherContext): Promise<EnrichmentResult>
}

export interface CParserEnricher {
  readonly source: "c_parser"
  enrich(request: QueryRequest, ctx: EnricherContext): Promise<EnrichmentResult>
}

export interface LlmEnricher {
  readonly source: "llm"
  canRun(request: QueryRequest, ctx: EnricherContext): boolean
  enrich(request: QueryRequest, ctx: EnricherContext): Promise<EnrichmentResult>
}

// ── Orchestration state machine ───────────────────────────────────────────────

export type OrchestrationAction =
  | { type: "return_hit" }
  | { type: "run_deterministic"; source: DeterministicEnricherSource }
  | { type: "retry_lookup" }
  | { type: "run_llm" }
  | { type: "return_not_found" }

export interface OrchestrationState {
  lookupHit: boolean
  request: QueryRequest
  policy: FallbackPolicy
  attempts: EnrichmentAttempt[]
}

export function decideOrchestrationAction(state: OrchestrationState): OrchestrationAction {
  if (state.lookupHit) return { type: "return_hit" }

  const lastAttempt = state.attempts[state.attempts.length - 1]
  if (lastAttempt?.status === "success") {
    return { type: "retry_lookup" }
  }

  const attemptedDeterministic = new Set<DeterministicEnricherSource>()
  for (const attempt of state.attempts) {
    if (attempt.source !== "llm") {
      attemptedDeterministic.add(attempt.source)
    }
  }

  for (const source of state.policy.deterministicOrder) {
    if (!attemptedDeterministic.has(source)) {
      return { type: "run_deterministic", source }
    }
  }

  const llmAttempt = state.attempts.find((attempt) => attempt.source === "llm")
  if (llmAttempt?.status === "success") {
    return { type: "retry_lookup" }
  }
  if (llmAttempt?.status === "failed" || llmAttempt?.status === "skipped") {
    return { type: "return_not_found" }
  }

  if (
    shouldRunLlmFallback(state.request, {
      policy: state.policy,
      priorAttempts: state.attempts,
    })
  ) {
    return { type: "run_llm" }
  }

  return { type: "return_not_found" }
}

export function shouldRunLlmFallback(request: QueryRequest, ctx: EnricherContext): boolean {
  if (!ctx.policy.llmLastResort) return false
  if (!(request.snapshotId > 0)) return false

  const deterministicAttempts = ctx.priorAttempts.filter(
    (a): a is EnrichmentAttempt & { source: DeterministicEnricherSource } => a.source !== "llm",
  )

  const attemptedAllDeterministic = ctx.policy.deterministicOrder.every((source) =>
    deterministicAttempts.some((attempt) => attempt.source === source),
  )
  if (!attemptedAllDeterministic) return false

  const allDeterministicFailed = deterministicAttempts.every((attempt) => attempt.status === "failed")
  if (!allDeterministicFailed) return false

  if (deterministicAttempts.length > ctx.policy.maxDeterministicPasses) return false

  return true
}
