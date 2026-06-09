/**
 * packs/markdown-oxide/index.ts — markdown-oxide-specific Rust patterns.
 *
 * markdown-oxide is the small (~6k LOC) production tower-lsp markdown
 * server we use as the rust-core dogfood workspace at
 * /home/abhi/qprojects/markdown-oxide.
 *
 * Currently empty — the generic rust-core extractor already handles
 * `pub fn`, `pub struct`, `enum`, `impl Trait for Type`, `mod`,
 * `#[derive(...)]` (as struct annotations), and the standard edge kinds.
 *
 * Future entries might capture:
 *   - `tower_lsp::async_trait` annotations on `impl LanguageServer for Backend`
 *     → emit a `lsp_handler` edge tagging which JSON-RPC method each method handles
 *   - `tokio::spawn(future)` sites → emit `async_spawned` edges
 *   - `#[derive(Parser)]` from clap → mark CLI entry-point structs
 */

import { existsSync } from "node:fs"
import { join } from "node:path"
import type { RustPatternPack } from "../types.js"

const markdownOxidePack: RustPatternPack = {
  name: "markdown-oxide",
  description:
    "markdown-oxide-specific Rust patterns (tower-lsp handlers, vault traversal, completion engine).",

  contributesEdgeKinds: [],

  appliesTo: (workspaceRoot: string) => {
    // Heuristic: a markdown-oxide checkout has a top-level Cargo.toml AND
    // src/vault/ AND src/backend/ — three load-bearing modules from this
    // specific project. The triple-check keeps unrelated Rust workspaces
    // from accidentally activating this pack.
    return (
      existsSync(join(workspaceRoot, "Cargo.toml")) &&
      existsSync(join(workspaceRoot, "src/vault")) &&
      existsSync(join(workspaceRoot, "src/backend"))
    )
  },
}

export default markdownOxidePack
