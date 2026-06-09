import type {
  CParserEnricher,
  ClangdEnricher,
  FallbackPolicy,
  LlmEnricher,
  PersistenceContracts,
} from "./orchestrator.js"

/**
 * Dependency bundle consumed by executeOrchestratedQuery.
 *
 * Kept in the contracts layer so callers can depend on orchestration shape
 * without importing the runner implementation module.
 */
export interface OrchestratorRunnerDeps {
  persistence: PersistenceContracts
  clangdEnricher: ClangdEnricher
  cParserEnricher: CParserEnricher
  llmEnricher?: LlmEnricher
  policy?: FallbackPolicy
}
