/**
 * packs/types.ts — TypeScript pattern pack contract.
 *
 * Same shape as src/plugins/clangd-core/packs/types.ts but specialized
 * for TypeScript / JavaScript / JSX / TSX framework patterns.
 *
 * The ts-core extractor itself stays generic — it walks the AST via
 * tree-sitter and emits standard symbol/call/import/extends edges.
 * Project- or framework-specific knowledge (React hooks, Express routes,
 * NestJS decorators, Vue lifecycle, etc.) lives in PatternPack bundles
 * under `packs/<name>/` so the core extractor stays free of hardcoding.
 *
 * Architecture:
 *
 *   src/plugins/ts-core/                    ← generic ts/js extractor
 *   src/plugins/ts-core/packs/              ← this folder
 *   src/plugins/ts-core/packs/intelgraph/   ← intelgraph-specific patterns (dogfood)
 *   src/plugins/ts-core/packs/<future>/     ← react, nestjs, vue, …
 *
 * Each pack contributes synthetic edge generators that take a parsed
 * tree-sitter node and decide whether to emit an additional fact (e.g.
 * a `registers_callback` edge for `useEffect(fn, deps)`). The core
 * extractor's existing `calls`/`imports`/etc. edges are NOT replaced
 * — pack edges are additive.
 */

import type { EdgeKind, LogLevel } from "../../../intelligence/contracts/common.js"

/**
 * A TS-style pattern pack. Each pack is a project- or framework-specific
 * bundle of detectors that augment the generic ts-core extractor with
 * synthetic edges that the AST walk alone can't infer.
 */
/** Log-call pattern for TypeScript/JS projects. */
export interface TsLogPattern {
  /** Dotted name to match (e.g. "console.log", "logger.info", "log"). */
  name: string
  /** Log level this call implies. */
  level: LogLevel
  /** 0-based index of the message argument. */
  messageArgIndex: number
}

export interface TsPatternPack {
  /** Unique pack identifier (lowercase, kebab-case). */
  name: string

  /** One-line description of what framework / project this pack covers. */
  description: string

  /**
   * Optional list of additional edge kinds this pack contributes. Used
   * by the registry to validate that the pack's emit calls only produce
   * edge kinds the schema accepts.
   */
  contributesEdgeKinds?: readonly EdgeKind[]

  /**
   * Log-call patterns this pack contributes. During the AST walk, any
   * call whose dotted name matches a TsLogPattern emits a `logs_event`
   * edge from the enclosing function to the call site.
   */
  logPatterns?: readonly TsLogPattern[]

  /**
   * Optional gate. When supplied, the pack is only activated if this
   * predicate returns true for the given workspace.
   */
  appliesTo?: (workspaceRoot: string) => boolean
}
