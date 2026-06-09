/**
 * packs/index.ts — central loader for project-specific pattern packs.
 *
 * Every pack under packs/<name>/index.ts is registered here. The
 * pattern-detector imports `collectAll*` to populate its registries
 * without hardcoding any project knowledge of its own.
 *
 * Adding a new pack:
 *   1. Create src/plugins/clangd-core/packs/<name>/index.ts
 *   2. Default-export a PatternPack with name, description, callPatterns,
 *      initPatterns, and an `appliesTo` predicate.
 *   3. Register it in ALL_PACKS below.
 *
 * The two collection helpers honor each pack's optional `appliesTo` gate
 * when a workspaceRoot is supplied so that, e.g., WLAN-specific patterns
 * never leak into a Linux workspace and vice versa.
 */

import type { CallPattern, InitPattern, PatternPack, LogMacroDef, DispatchChainTemplate, HWEntityDef } from "./types.js"
import wlanPack from "./wlan/index.js"
import linuxPack from "./linux/index.js"

/** Compile-time list of every pack shipped in-tree. */
export const ALL_PACKS: readonly PatternPack[] = [wlanPack, linuxPack]

/**
 * Return every pack whose `appliesTo` accepts the given workspace root.
 * When `workspaceRoot` is omitted, every pack is returned (used by the
 * thin registry below for backwards compat with consumers that import
 * the global CALL_PATTERNS / INIT_PATTERNS arrays).
 */
export function collectAllPacks(workspaceRoot?: string): PatternPack[] {
  if (workspaceRoot === undefined) return ALL_PACKS.slice()
  return ALL_PACKS.filter((p) => !p.appliesTo || p.appliesTo(workspaceRoot))
}

/**
 * Flatten every active pack's call patterns into a single array.
 * Duplicates (same registrationApi from two packs) are dropped on
 * first-wins basis — the order in ALL_PACKS controls precedence.
 */
export function collectAllCallPatterns(workspaceRoot?: string): CallPattern[] {
  const seen = new Set<string>()
  const out: CallPattern[] = []
  for (const pack of collectAllPacks(workspaceRoot)) {
    for (const p of pack.callPatterns) {
      if (seen.has(p.registrationApi)) continue
      seen.add(p.registrationApi)
      out.push(p)
    }
  }
  return out
}

/**
 * Flatten every active pack's init patterns into a single array.
 * Duplicates (same name) are dropped on first-wins basis.
 */
export function collectAllInitPatterns(workspaceRoot?: string): InitPattern[] {
  const seen = new Set<string>()
  const out: InitPattern[] = []
  for (const pack of collectAllPacks(workspaceRoot)) {
    for (const p of pack.initPatterns) {
      if (seen.has(p.name)) continue
      seen.add(p.name)
      out.push(p)
    }
  }
  return out
}

/**
 * Flatten every active pack's log macro definitions into a single Map
 * keyed by macro name for O(1) lookup during the AST walk.
 * Duplicates (same name from two packs) are dropped on first-wins basis.
 */
export function collectAllLogMacros(workspaceRoot?: string): Map<string, LogMacroDef> {
  const map = new Map<string, LogMacroDef>()
  for (const pack of collectAllPacks(workspaceRoot)) {
    for (const m of pack.logMacros) {
      if (!map.has(m.name)) map.set(m.name, m)
    }
  }
  return map
}

/**
 * Flatten every active pack's dispatch chain templates into a single Map
 * keyed by registrationApi for O(1) lookup during chain resolution.
 */
export function collectAllDispatchChains(workspaceRoot?: string): Map<string, DispatchChainTemplate> {
  const map = new Map<string, DispatchChainTemplate>()
  for (const pack of collectAllPacks(workspaceRoot)) {
    for (const d of pack.dispatchChains) {
      if (!map.has(d.registrationApi)) map.set(d.registrationApi, d)
    }
  }
  return map
}

/**
 * Flatten every active pack's HW entity definitions into a single Map
 * keyed by entity name for O(1) lookup. Also builds a reverse map from
 * dispatch-chain step name → HW entity for matching during chain
 * materialization.
 */
export function collectAllHWEntities(workspaceRoot?: string): {
  byName: Map<string, HWEntityDef>
  byChainStep: Map<string, HWEntityDef>
} {
  const byName = new Map<string, HWEntityDef>()
  const byChainStep = new Map<string, HWEntityDef>()
  for (const pack of collectAllPacks(workspaceRoot)) {
    for (const hw of pack.hwEntities) {
      if (!byName.has(hw.name)) byName.set(hw.name, hw)
      for (const step of hw.matchesChainSteps ?? []) {
        if (!byChainStep.has(step)) byChainStep.set(step, hw)
      }
    }
  }
  return { byName, byChainStep }
}

export type { PatternPack, CallPattern, InitPattern, LogMacroDef, DispatchChainTemplate, HWEntityDef }
