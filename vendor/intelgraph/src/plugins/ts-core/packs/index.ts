/**
 * packs/index.ts — central loader for TypeScript pattern packs.
 *
 * Mirrors the layout of src/plugins/clangd-core/packs/index.ts. Each
 * pack under packs/<name>/index.ts is registered here and the central
 * `collectAllPacks()` helper honors each pack's `appliesTo` gate so
 * project-specific patterns never leak across workspaces.
 *
 * Adding a new pack:
 *   1. Create src/plugins/ts-core/packs/<name>/index.ts
 *   2. Default-export a TsPatternPack with name, description, optional
 *      contributesEdgeKinds, and an `appliesTo` predicate.
 *   3. Register it in ALL_PACKS below.
 */

import type { TsPatternPack } from "./types.js"
import intelgraphPack from "./intelgraph/index.js"

/** Compile-time list of every ts-core pack shipped in-tree. */
export const ALL_PACKS: readonly TsPatternPack[] = [intelgraphPack]

/**
 * Return every pack whose `appliesTo` accepts the given workspace root.
 * When `workspaceRoot` is omitted, every pack is returned (used by
 * unit tests and ad-hoc inspection).
 */
export function collectAllPacks(workspaceRoot?: string): TsPatternPack[] {
  if (workspaceRoot === undefined) return ALL_PACKS.slice()
  return ALL_PACKS.filter((p) => !p.appliesTo || p.appliesTo(workspaceRoot))
}

export type { TsPatternPack }
