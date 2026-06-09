/**
 * Plugins-module ports.
 *
 * The plugins module owns the static registry of in-tree IExtractor
 * plugins. Today the registry is a compile-time array
 * (`BUILT_IN_EXTRACTORS`); tomorrow it may be a manifest-driven loader
 * (Problem 6). Consumers should depend on `IPluginRegistry` instead of
 * the array so that transition doesn't ripple through the codebase.
 *
 * Real impl: the `pluginRegistry` constant in `index.ts`, which wraps
 * `BUILT_IN_EXTRACTORS`. Fake impl: `fakes/plugin-registry.fake.ts` —
 * constructed with any extractor list, no disk IO.
 */

import type { IExtractor, WorkspaceProbe } from "../intelligence/extraction/contract.js"

/**
 * Registry of extractor plugins available to the runner. Two reads:
 * list every registered extractor, or filter by an `appliesTo`
 * predicate against a workspace probe.
 */
export interface IPluginRegistry {
  /**
   * Return every registered extractor. Callers receive a fresh array
   * they may mutate freely — subsequent calls return an independent
   * copy.
   */
  listExtractors(): IExtractor[]

  /**
   * Return the subset of registered extractors that apply to `probe`.
   * A plugin without an `appliesTo` predicate is always included; a
   * plugin whose `appliesTo` returns false is excluded.
   */
  getExtractorsFor(probe: WorkspaceProbe): IExtractor[]
}

// Re-export the types consumers need to call the port without a second
// import line to the extraction contract.
export type { IExtractor, WorkspaceProbe } from "../intelligence/extraction/contract.js"
