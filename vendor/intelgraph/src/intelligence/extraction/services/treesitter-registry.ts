/**
 * treesitter-registry.ts — multi-language tree-sitter loader.
 *
 * The original c-parser at src/tools/pattern-detector/c-parser.ts hard-
 * coded the C grammar. This registry generalizes that pattern: lazy-load
 * any installed tree-sitter WASM grammar by language id, cache the
 * Parser per language, and expose a uniform `parseSource(language, src)`
 * surface for the TreeSitterService and any plugin that wants raw AST
 * access.
 *
 * Languages currently supported (the ones we ship grammars for):
 *   - "c"          → node_modules/tree-sitter-c/tree-sitter-c.wasm
 *   - "typescript" → node_modules/tree-sitter-typescript/tree-sitter-typescript.wasm
 *   - "tsx"        → node_modules/tree-sitter-typescript/tree-sitter-tsx.wasm
 *
 * Adding a new language is one map entry plus an `npm install
 * tree-sitter-<lang>` for the corresponding WASM build.
 *
 * Init lifecycle:
 *   - Parser.init() runs once globally (web-tree-sitter requires it)
 *   - Each language's Language.load() runs once on first access
 *   - Failures are cached so the registry doesn't retry on every call
 *
 * Returns null from parse* methods on init failure rather than throwing
 * — plugins should treat tree-sitter as best-effort and skip files when
 * parsing fails. The reason is that the test environment may not have
 * the WASM files (some CI containers strip them) and we want graceful
 * degradation, not a hard crash.
 */

import { readFileSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { loggerPort } from "../../../logging/logger.js"

const _log = loggerPort.child("treesitter-registry")

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Supported language id. Add to the LANGUAGE_WASM map below to extend. */
export type SupportedLanguage = "c" | "typescript" | "tsx" | "rust"

/**
 * Minimal AST node interface — every tree-sitter Node has these. Plugins
 * can cast to the full type from web-tree-sitter when they need more.
 */
export interface TsNode {
  type: string
  text: string
  startPosition: { row: number; column: number }
  endPosition: { row: number; column: number }
  startIndex: number
  endIndex: number
  childCount: number
  child(i: number): TsNode | null
  childForFieldName(field: string): TsNode | null
  namedChildCount: number
  namedChild(i: number): TsNode | null
  parent: TsNode | null
  walk(): TsCursor
}

export interface TsCursor {
  currentNode: TsNode
  gotoFirstChild(): boolean
  gotoNextSibling(): boolean
  gotoParent(): boolean
}

export interface TsTree {
  rootNode: TsNode
}

// ---------------------------------------------------------------------------
// WASM file resolution
// ---------------------------------------------------------------------------

const LANGUAGE_WASM: Record<SupportedLanguage, string> = {
  c: "tree-sitter-c/tree-sitter-c.wasm",
  typescript: "tree-sitter-typescript/tree-sitter-typescript.wasm",
  tsx: "tree-sitter-typescript/tree-sitter-tsx.wasm",
  rust: "tree-sitter-rust/tree-sitter-rust.wasm",
}

function resolveProjectRoot(): string {
  // This file lives at src/intelligence/extraction/services/ in source,
  // but at dist/ in the bundled context. Try multiple candidate roots
  // and pick the first one where node_modules/ exists — same approach
  // as the fix in tools/pattern-detector/c-parser.ts for the WASM path.
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(moduleDir, ".."), // dist/index.js → one level up
    join(moduleDir, "..", "..", "..", ".."), // source: 4 levels up
    join(moduleDir, "..", ".."), // intermediate bundle depth
    process.cwd(), // last resort: working directory
  ]
  for (const root of candidates) {
    if (existsSync(join(root, "node_modules", "web-tree-sitter"))) return root
  }
  return candidates[candidates.length - 1]
}

function wasmPathFor(lang: SupportedLanguage): string {
  const root = resolveProjectRoot()
  return join(root, "node_modules", LANGUAGE_WASM[lang])
}

function webTreeSitterWasmPath(): string {
  const root = resolveProjectRoot()
  return join(root, "node_modules", "web-tree-sitter", "web-tree-sitter.wasm")
}

// ---------------------------------------------------------------------------
// Lazy init state
// ---------------------------------------------------------------------------

let parserInitPromise: Promise<unknown> | null = null
let parserInitFailed = false

// Cached Parser per language (each instance has setLanguage() called once)
const parserCache = new Map<SupportedLanguage, unknown>()
const langInitFailed = new Set<SupportedLanguage>()

const PARSER_INIT_TIMEOUT_MS = 10_000

/**
 * Read the treesitter debug flag from env.
 */
function debugTreesitter(): boolean {
  return Boolean(process.env.INTELGRAPH_DEBUG_TREESITTER)
}

/**
 * Idempotent global init for web-tree-sitter. Must complete before any
 * Language.load() call. Returns the imported Parser/Language tuple, or
 * null on failure.
 */
async function initWebTreeSitter(): Promise<{
  Parser: any
  Language: any
} | null> {
  if (parserInitFailed) return null
  if (parserInitPromise) {
    try {
      return (await parserInitPromise) as { Parser: any; Language: any }
    } catch {
      return null
    }
  }
  parserInitPromise = (async () => {
    const wasmPath = webTreeSitterWasmPath()
    if (!existsSync(wasmPath)) {
      throw new Error(`web-tree-sitter wasm not found at ${wasmPath}`)
    }
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports
    const mod: any = await import("web-tree-sitter")
    const Parser = mod.Parser
    const Language = mod.Language
    const initWork = Parser.init({ wasmBinary: readFileSync(wasmPath) })
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("web-tree-sitter init timed out")), PARSER_INIT_TIMEOUT_MS),
    )
    await Promise.race([initWork, timeout])
    return { Parser, Language }
  })()
  try {
    return (await parserInitPromise) as { Parser: any; Language: any }
  } catch (err) {
    parserInitFailed = true
    if (debugTreesitter()) {
      _log.error("global init failed", err instanceof Error ? err : new Error(String(err)))
    }
    return null
  }
}

/**
 * Get a Parser configured for the given language. Lazy-loads the WASM
 * grammar on first access. Returns null on failure (missing WASM,
 * timeout, web-tree-sitter import error).
 */
export async function getParser(lang: SupportedLanguage): Promise<unknown | null> {
  if (langInitFailed.has(lang)) return null
  const cached = parserCache.get(lang)
  if (cached) return cached

  const wts = await initWebTreeSitter()
  if (!wts) return null

  try {
    const langWasm = wasmPathFor(lang)
    if (!existsSync(langWasm)) {
      langInitFailed.add(lang)
      if (debugTreesitter()) {
        _log.error(`grammar wasm not found: ${langWasm}`)
      }
      return null
    }
    const language = await wts.Language.load(langWasm)
    const parser = new wts.Parser()
    parser.setLanguage(language)
    parserCache.set(lang, parser)
    return parser
  } catch (err) {
    langInitFailed.add(lang)
    if (debugTreesitter()) {
      _log.error(`failed to load ${lang}`, err instanceof Error ? err : new Error(String(err)))
    }
    return null
  }
}

/**
 * Parse a source string for a given language. Returns null if the
 * grammar isn't loadable or if parsing throws.
 */
export async function parseSource(lang: SupportedLanguage, source: string): Promise<TsTree | null> {
  const parser = (await getParser(lang)) as { parse(s: string): TsTree } | null
  if (!parser) return null
  try {
    return parser.parse(source)
  } catch {
    return null
  }
}

/**
 * Read a file and parse it. Returns null on read failure or parse
 * failure. The language is inferred from the extension if not provided
 * explicitly.
 */
export async function parseFile(filePath: string, lang?: SupportedLanguage): Promise<TsTree | null> {
  let source: string
  try {
    source = readFileSync(filePath, "utf8")
  } catch {
    return null
  }
  const language = lang ?? inferLanguageFromExtension(filePath)
  if (!language) return null
  return parseSource(language, source)
}

/**
 * Infer a tree-sitter language id from a file extension. Returns null
 * for unknown extensions so the caller can decide how to handle.
 */
export function inferLanguageFromExtension(filePath: string): SupportedLanguage | null {
  const lower = filePath.toLowerCase()
  if (lower.endsWith(".c") || lower.endsWith(".h")) return "c"
  if (lower.endsWith(".tsx") || lower.endsWith(".jsx")) return "tsx"
  if (
    lower.endsWith(".ts") ||
    lower.endsWith(".mts") ||
    lower.endsWith(".cts") ||
    lower.endsWith(".js") ||
    lower.endsWith(".mjs") ||
    lower.endsWith(".cjs")
  ) {
    return "typescript"
  }
  if (lower.endsWith(".rs")) return "rust"
  return null
}

/**
 * Walk a tree-sitter tree depth-first, yielding every named node. Useful
 * for plugins that scan an AST without writing custom recursion.
 */
export function* walkTree(node: TsNode): Generator<TsNode> {
  yield node
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i)
    if (child) {
      yield* walkTree(child)
    }
  }
}

/**
 * Find the first descendant of `node` whose `type` matches the predicate.
 * Returns null if none found.
 */
export function findDescendant(node: TsNode, predicate: (n: TsNode) => boolean): TsNode | null {
  for (const candidate of walkTree(node)) {
    if (predicate(candidate)) return candidate
  }
  return null
}

/**
 * Reset all caches — used by tests that want to verify init behavior.
 * Not part of the public API for production code.
 */
export function _resetForTests(): void {
  parserInitPromise = null
  parserInitFailed = false
  parserCache.clear()
  langInitFailed.clear()
}
