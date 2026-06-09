import type { IToolDispatcher } from "../ports.js"
import type { ILanguageClient } from "../../lsp/ports.js"
import type { UnifiedBackend } from "../../backend/unified-backend.js"
import type { OrchestratorRunnerDeps } from "../../intelligence/contracts/orchestrator-runner-deps.js"

/**
 * In-memory IToolDispatcher. Records every setter call and lets tests
 * preload backends / deps without running the composition root.
 */
export class FakeToolDispatcher implements IToolDispatcher {
  private backend: UnifiedBackend | null = null
  private deps: OrchestratorRunnerDeps | null = null
  readonly calls: Array<{ kind: string; arg?: unknown }> = []

  /** Convenience: preload the backend returned by unifiedBackendOrThrow. */
  preloadBackend(backend: UnifiedBackend): void {
    this.backend = backend
  }

  setUnifiedBackend(backend: UnifiedBackend): void {
    this.backend = backend
    this.calls.push({ kind: "setUnifiedBackend", arg: backend })
  }

  setIntelligenceDeps(deps: OrchestratorRunnerDeps): void {
    this.deps = deps
    this.calls.push({ kind: "setIntelligenceDeps", arg: deps })
  }

  getIntelligenceDeps(): OrchestratorRunnerDeps | null {
    return this.deps
  }

  unifiedBackendOrThrow(): UnifiedBackend {
    if (!this.backend) {
      throw new Error("[fake-dispatcher] Unified backend not initialized")
    }
    return this.backend
  }

  inflightIndirectCallerKey(workspaceRoot: string, cacheKey: string): string {
    return `${workspaceRoot}::${cacheKey}`
  }

  async withFile<T extends string = string>(
    _client: ILanguageClient,
    _filePath: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    // Fake skips the LSP open + settle — tests typically don't have a
    // real language client. Callers that need withFile side-effects
    // should spy on the passed client directly.
    return fn()
  }
}
