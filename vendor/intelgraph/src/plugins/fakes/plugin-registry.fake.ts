import type { IPluginRegistry, IExtractor, WorkspaceProbe } from "../ports.js"

/**
 * In-memory IPluginRegistry. Seeded with an explicit extractor list at
 * construction; no disk IO, no plugin discovery.
 *
 * Suitable for:
 *   - contract-test suites
 *   - consumer tests that need a controlled set of extractors (runner
 *     orchestration tests, capability-routing tests)
 *
 * NOT suitable for: validating the production registry's list of built-
 * in plugins — that's what `BUILT_IN_EXTRACTORS` is for.
 */
export class FakePluginRegistry implements IPluginRegistry {
  private readonly extractors: IExtractor[]

  constructor(extractors: IExtractor[] = []) {
    this.extractors = [...extractors]
  }

  listExtractors(): IExtractor[] {
    return [...this.extractors]
  }

  getExtractorsFor(probe: WorkspaceProbe): IExtractor[] {
    return this.extractors.filter((ext) => !ext.metadata.appliesTo || ext.metadata.appliesTo(probe))
  }
}
