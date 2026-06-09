/**
 * treesitter-service.ts — TreeSitter service exposed via ctx.treesitter.
 *
 * Wraps two layers:
 *   1. The legacy C-only helpers from
 *      src/tools/pattern-detector/c-parser.ts (findEnclosingCall, etc.)
 *      that the pattern-resolver still depends on.
 *   2. The new multi-language registry in treesitter-registry.ts that
 *      lazy-loads any installed grammar (C, TypeScript, TSX, etc.) by
 *      language id, exposes raw AST access via parseSource/parseFile,
 *      and provides walkTree / findDescendant utilities.
 *
 * Plugins should use the multi-language surface for new work. The C-only
 * helpers remain for the WLAN dispatch resolver until that code moves
 * into a project-specific plugin.
 */

import { readFileSync } from "node:fs"
import {
  type FunctionCall,
  findEnclosingCall as cFindEnclosingCall,
  findEnclosingConstruct as cFindEnclosingConstruct,
  initParser as cInitParser,
  isParserReady as cIsParserReady,
} from "../../../tools/pattern-detector/c-parser.js"
import {
  type SupportedLanguage,
  type TsNode,
  type TsTree,
  findDescendant,
  getParser,
  inferLanguageFromExtension,
  parseFile as registryParseFile,
  parseSource as registryParseSource,
  walkTree,
} from "./treesitter-registry.js"

export type { FunctionCall }
export type { SupportedLanguage, TsNode, TsTree }

// ---------------------------------------------------------------------------
// Public service interface
// ---------------------------------------------------------------------------

export interface TreeSitterService {
  /** Returns true once the WASM parser has loaded successfully. */
  isReady(): boolean

  /**
   * Ensure the parser is initialized. Idempotent. The service triggers this
   * automatically before any other call, so plugins generally don't need to
   * call it explicitly — but it's exposed for plugins that want to surface
   * an early "parser not available" warning.
   */
  ensureReady(): Promise<void>

  /**
   * Find the innermost call_expression containing a position. Returns null
   * when no call exists at that location, or when the parser is not ready
   * and the character-level fallback also finds nothing.
   */
  findEnclosingCall(
    source: string,
    line: number,
    column: number,
  ): Promise<FunctionCall | null>

  /**
   * Like findEnclosingCall but also matches initializer_list constructs
   * (e.g. designated initializers in struct literals where dispatch tables
   * are declared statically).
   */
  findEnclosingConstruct(
    source: string,
    line: number,
    column: number,
  ): Promise<FunctionCall | null>

  /**
   * Read a file and find the enclosing call at a position in one shot.
   * Convenience for the common pattern of "I have a (file, line, col) and I
   * want the surrounding call." Returns null if the file is unreadable.
   */
  findEnclosingCallAt(
    filePath: string,
    line: number,
    column: number,
  ): Promise<FunctionCall | null>

  // ── Multi-language surface ─────────────────────────────────────────────

  /**
   * Parse a source string with the given tree-sitter grammar. Returns
   * null if the grammar is not loadable (missing WASM, init failure) or
   * if parsing throws. Plugins should treat this as best-effort.
   */
  parseSource(
    language: SupportedLanguage,
    source: string,
  ): Promise<TsTree | null>

  /**
   * Read a file and parse it. Language is inferred from the extension if
   * not provided explicitly.
   */
  parseFile(
    filePath: string,
    language?: SupportedLanguage,
  ): Promise<TsTree | null>

  /** Infer a language id from a file path's extension. */
  inferLanguage(filePath: string): SupportedLanguage | null

  /** Walk a tree depth-first yielding every named node. */
  walk(node: TsNode): Generator<TsNode>

  /** Find the first descendant matching a predicate. */
  findDescendant(node: TsNode, predicate: (n: TsNode) => boolean): TsNode | null
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class TreeSitterServiceImpl implements TreeSitterService {
  private initialized = false
  private initFailed = false
  private initPromise: Promise<void> | null = null

  isReady(): boolean {
    return cIsParserReady()
  }

  async ensureReady(): Promise<void> {
    if (this.initialized || this.initFailed) return
    if (this.initPromise) return this.initPromise
    this.initPromise = (async () => {
      try {
        await cInitParser()
        this.initialized = true
      } catch {
        this.initFailed = true
      }
    })()
    return this.initPromise
  }

  async findEnclosingCall(
    source: string,
    line: number,
    column: number,
  ): Promise<FunctionCall | null> {
    await this.ensureReady()
    return cFindEnclosingCall(source, line, column)
  }

  async findEnclosingConstruct(
    source: string,
    line: number,
    column: number,
  ): Promise<FunctionCall | null> {
    await this.ensureReady()
    return cFindEnclosingConstruct(source, line, column)
  }

  async findEnclosingCallAt(
    filePath: string,
    line: number,
    column: number,
  ): Promise<FunctionCall | null> {
    let source: string
    try {
      source = readFileSync(filePath, "utf8")
    } catch {
      return null
    }
    return this.findEnclosingCall(source, line, column)
  }

  // ── Multi-language methods ───────────────────────────────────────────────

  async parseSource(
    language: SupportedLanguage,
    source: string,
  ): Promise<TsTree | null> {
    return registryParseSource(language, source)
  }

  async parseFile(
    filePath: string,
    language?: SupportedLanguage,
  ): Promise<TsTree | null> {
    return registryParseFile(filePath, language)
  }

  inferLanguage(filePath: string): SupportedLanguage | null {
    return inferLanguageFromExtension(filePath)
  }

  walk(node: TsNode): Generator<TsNode> {
    return walkTree(node)
  }

  findDescendant(node: TsNode, predicate: (n: TsNode) => boolean): TsNode | null {
    return findDescendant(node, predicate)
  }
}

// Re-export getParser at the module level so plugins that need raw
// Parser instances (e.g. to run tree-sitter queries) can import it
// without reaching into the registry directly.
export { getParser }
