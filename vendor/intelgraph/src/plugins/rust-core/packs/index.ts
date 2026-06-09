/**
 * packs/index.ts — central loader for Rust pattern packs.
 *
 * Mirrors src/plugins/clangd-core/packs/index.ts and
 * src/plugins/ts-core/packs/index.ts.
 */

import type { RustPatternPack } from "./types.js"
import markdownOxidePack from "./markdown-oxide/index.js"

/** Compile-time list of every rust-core pack shipped in-tree. */
export const ALL_PACKS: readonly RustPatternPack[] = [markdownOxidePack]

/**
 * Return every pack whose `appliesTo` accepts the given workspace root.
 */
export function collectAllPacks(workspaceRoot?: string): RustPatternPack[] {
  if (workspaceRoot === undefined) return ALL_PACKS.slice()
  return ALL_PACKS.filter((p) => !p.appliesTo || p.appliesTo(workspaceRoot))
}

export type { RustPatternPack }
