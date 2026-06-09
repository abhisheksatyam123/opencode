/**
 * packs/types.ts — Rust pattern pack contract.
 *
 * Same shape as src/plugins/clangd-core/packs/types.ts and
 * src/plugins/ts-core/packs/types.ts but specialized for Rust idioms.
 *
 * The rust-core extractor itself stays generic — it walks .rs files via
 * tree-sitter-rust and emits standard symbol/call/import/impl edges.
 * Project- or framework-specific knowledge (tokio runtime, axum routes,
 * serde derives, wasm-bindgen exports, etc.) lives in RustPatternPack
 * bundles under `packs/<name>/` so the core extractor stays free of
 * hardcoding.
 *
 * Architecture:
 *
 *   src/plugins/rust-core/                    ← generic rust extractor
 *   src/plugins/rust-core/packs/              ← this folder
 *   src/plugins/rust-core/packs/markdown-oxide/  ← markdown-oxide-specific (dogfood)
 *   src/plugins/rust-core/packs/<future>/     ← tokio, axum, serde, …
 */

import type { EdgeKind } from "../../../intelligence/contracts/common.js"

export interface RustPatternPack {
  /** Unique pack identifier (lowercase, kebab-case). */
  name: string

  /** One-line description. */
  description: string

  /**
   * Optional list of additional edge kinds this pack contributes.
   * Used by the registry to validate emitted edges against the schema.
   */
  contributesEdgeKinds?: readonly EdgeKind[]

  /**
   * Optional workspace gate. If omitted, the pack is always active.
   */
  appliesTo?: (workspaceRoot: string) => boolean
}
