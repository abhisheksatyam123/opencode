/**
 * unified-backend.ts
 *
 * Process-local unified backend facade. This provides one interface surface
 * over LSP client access, cache/DB backends, and pattern/reason engines.
 *
 * All sessions in the same daemon process share this facade.
 */

import type { ILanguageClient } from "../lsp/ports.js"
import type { IndexTracker } from "../tracking/index.js"
import { computeCacheKey, readCache, writeCache } from "../tools/indirect-caller-cache.js"
import { collectIndirectCallers, formatIndirectCallerTree } from "../tools/indirect-callers.js"
import { runReasonEngine, type ReasonEngineInput } from "../tools/reason-engine/index.js"
import type { LlmReasoningConfig } from "../tools/reason-engine/llm-advisor.js"

export interface UnifiedBackend {
  getClient(): Promise<ILanguageClient>
  tracker: IndexTracker
  indirectCallerCache: {
    computeKey(file: string, line: number, character: number): string
    read(workspaceRoot: string, key: string, evidenceFiles: string[]): any | null
    write(workspaceRoot: string, key: string, result: any, evidenceFiles: string[]): void
  }
  patterns: {
    collectIndirectCallers: typeof collectIndirectCallers
    formatIndirectCallerTree: typeof formatIndirectCallerTree
  }
  reasonEngine: {
    run: (
      client: ILanguageClient,
      input: ReasonEngineInput,
      llmConfig?: LlmReasoningConfig,
    ) => ReturnType<typeof runReasonEngine>
  }
}

export function createUnifiedBackend(
  getClient: () => Promise<ILanguageClient>,
  tracker: IndexTracker,
): UnifiedBackend {
  return {
    getClient,
    tracker,
    indirectCallerCache: {
      computeKey: computeCacheKey,
      read: readCache,
      write: writeCache,
    },
    patterns: {
      collectIndirectCallers,
      formatIndirectCallerTree,
    },
    reasonEngine: {
      run: runReasonEngine,
    },
  }
}
