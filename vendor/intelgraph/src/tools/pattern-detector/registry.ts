/**
 * pattern-detector/registry.ts — Thin loader over project-specific pattern packs.
 *
 * Project-specific patterns (WLAN, Linux, future packs) live under
 * src/plugins/clangd-core/packs/<name>/. This file used to hardcode the WLAN
 * patterns directly; that hardcoding has been moved into packs/wlan/. The
 * registry's job now is to flatten every active pack into the legacy
 * `CALL_PATTERNS` / `INIT_PATTERNS` arrays so existing call sites in
 * `detector.ts`, `indirect-callers.ts`, and `pattern-resolver/` keep working
 * without modification.
 *
 * Architecture:
 *
 *   src/plugins/clangd-core/packs/<name>/index.ts   ← project-specific patterns
 *   src/plugins/clangd-core/packs/index.ts          ← collectAllCallPatterns()
 *   src/tools/pattern-detector/registry.ts          ← THIS FILE (thin loader)
 *   src/tools/pattern-detector/detector.ts          ← consumes registry +
 *                                                     generic struct-field-callback
 *                                                     fallback
 *
 * The struct-field-callback pattern (Linux's dominant `.read = my_read` style)
 * is NOT represented in INIT_PATTERNS — it is handled by a generic
 * tree-sitter-based fallback in `detector.ts:classifyGenericStructFieldCallback`.
 * That keeps the per-struct hardcoding count at zero.
 */

import type { CallPattern, InitPattern } from "./ports.js"
import { collectAllCallPatterns, collectAllInitPatterns } from "../../plugins/clangd-core/packs/index.js"

// ---------------------------------------------------------------------------
// Flattened pattern arrays — collected at module load time across every
// pack's appliesTo gate. The collection is intentionally workspace-agnostic
// here so the legacy global imports keep working. Workspace-aware filtering
// is available via the per-call `collectAll*(workspaceRoot)` helpers in
// packs/index.ts when callers want it.
// ---------------------------------------------------------------------------

export const CALL_PATTERNS: readonly CallPattern[] = collectAllCallPatterns()
export const INIT_PATTERNS: readonly InitPattern[] = collectAllInitPatterns()

// ---------------------------------------------------------------------------
// Lookup helpers (unchanged contract)
// ---------------------------------------------------------------------------

/** Find a call pattern by registration API name. */
export function findCallPatternByApi(apiName: string): CallPattern | undefined {
  return CALL_PATTERNS.find((p) => p.registrationApi === apiName)
}

/** Get all registration API names contributed by every active pack. */
export function getAllApiNames(): string[] {
  return CALL_PATTERNS.map((p) => p.registrationApi)
}
