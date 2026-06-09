/**
 * phases/types.ts — shared types for clangd-core extraction phases.
 *
 * Each phase is an async generator that yields extraction facts via the
 * ctx helpers. This file defines the shared context that phases receive
 * so they don't depend on each other's internals.
 */

import type { SymbolRow } from "../../../intelligence/contracts/common.js"
import type { ExtractionContext } from "../../../intelligence/extraction/context.js"

/** Per-file symbol cache shared across phases. */
export type FileSymbolMap = Map<string, SymbolRow[]>

/**
 * Extraction context type for clangd-core phases.
 *
 * Picks only the fields that phases actually use from the full
 * ExtractionContext. This ensures phases stay narrow (don't accidentally
 * depend on tools the LSP didn't provide), while eliminating the
 * `ctx as any` casts that previously hid the type relationship.
 */
export type PhaseCtx = Pick<ExtractionContext, "signal" | "workspace" | "lsp" | "metrics" | "symbol" | "type" | "edge">
