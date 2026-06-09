// util/debug-filter.ts
//
// Category-based debug message filter (parity gap-55).
//
// PROVENANCE: ported from
// `instructkr-claude-code/src/utils/debugFilter.ts` (157 LOC).
// Drops the lodash-es/memoize dependency in favor of a tiny inline
// Map cache (parseDebugFilter is the only memoized function and it
// only has a few unique inputs per process — typically one).
//
// THE PROBLEM
// ===========
// opencode's debug logging is verbose and there's no way to filter
// by category. The agent loop emits log lines from many subsystems
// (lsp, mcp, session, provider, plugin, ...), and when you're
// debugging ONE of them you have to wade through thousands of
// unrelated lines from the others. Adding a category filter
// (`OPENCODE_DEBUG=lsp,mcp`) lets the user surface only the lines
// they care about.
//
// THE FIX
// =======
// `parseDebugFilter(s)` parses a comma-separated filter string into
// a `DebugFilter` config:
//
//   - "api,hooks"   → inclusive: only show messages tagged api or hooks
//   - "!api,!hooks" → exclusive: hide messages tagged api or hooks
//   - undefined/""  → no filtering, show everything
//
// Mixed inclusive + exclusive (`api,!hooks`) is rejected because the
// semantics are ambiguous. The whole filter falls back to "no filter".
//
// `extractDebugCategories(message)` parses a log message for the
// category tags it carries (5 patterns supported):
//   1. `category: message`              → ["category"]
//   2. `[CATEGORY] message`             → ["category"]
//   3. `MCP server "name": message`     → ["mcp", "name"]
//   4. `1P event:` substring            → ["1p"]
//   5. Secondary `:foo:` words          → ["foo"]
//
// `shouldShowDebugMessage(message, filter)` is the high-level
// dispatch — combines extraction + filtering into one call.
//
// USAGE
// =====
// ```ts
// import { DebugFilter } from "./util/debug-filter"
//
// const filter = DebugFilter.parse(process.env.OPENCODE_DEBUG)
// log.subscribe((msg) => {
//   if (DebugFilter.shouldShow(msg, filter)) {
//     process.stderr.write(msg + "\n")
//   }
// })
// ```
//
// THIS IS NOT
// ===========
// Not a structured-log query language. It's a simple presence check
// on category strings. For complex filtering, use a real log
// processor downstream of opencode.
//
// Not a replacement for util/log.ts. opencode's Log namespace
// continues to handle log emission; DebugFilter sits between Log
// and the sink (stderr / file) to drop messages the user doesn't
// want to see.

export namespace DebugFilter {
  export interface Config {
    /** Categories that should be shown (empty when isExclusive=true). */
    include: string[]
    /** Categories that should be hidden (empty when isExclusive=false). */
    exclude: string[]
    /** True for `!category` mode, false for `category` mode. */
    isExclusive: boolean
  }

  /**
   * Tiny inline cache for parse() results. parseDebugFilter is
   * pure — same input always produces the same output — and the
   * input is typically a single env var read at startup, so a
   * Map<string, Config | null> with no eviction is fine.
   */
  const parseCache = new Map<string, Config | null>()

  /**
   * Parse a debug filter string into a DebugFilter.Config.
   *
   * Format:
   *   - "api,hooks"   → inclusive: include both
   *   - "!api,!hooks" → exclusive: exclude both
   *   - "api,!hooks"  → MIXED → null (treated as no filter)
   *   - undefined/""  → null (no filter)
   *
   * Returns null when the filter is empty, undefined, or
   * malformed (mixed inclusive + exclusive).
   */
  export function parse(filterString: string | undefined): Config | null {
    const key = filterString ?? ""
    if (parseCache.has(key)) return parseCache.get(key)!

    const result = parseUncached(filterString)
    parseCache.set(key, result)
    return result
  }

  function parseUncached(filterString: string | undefined): Config | null {
    if (!filterString || filterString.trim() === "") return null
    const filters = filterString
      .split(",")
      .map((f) => f.trim())
      .filter(Boolean)
    if (filters.length === 0) return null

    const hasExclusive = filters.some((f) => f.startsWith("!"))
    const hasInclusive = filters.some((f) => !f.startsWith("!"))

    // Mixed inclusive + exclusive is ambiguous — fall back to no filter.
    if (hasExclusive && hasInclusive) return null

    // Strip the leading `!` and lowercase for case-insensitive matching.
    const cleanFilters = filters.map((f) => f.replace(/^!/, "").toLowerCase())

    return {
      include: hasExclusive ? [] : cleanFilters,
      exclude: hasExclusive ? cleanFilters : [],
      isExclusive: hasExclusive,
    }
  }

  /**
   * Test escape hatch: clear the parse cache. Tests should call
   * this in beforeEach when they need predictable behavior.
   */
  export function _resetCache(): void {
    parseCache.clear()
  }

  /**
   * Extract debug categories from a log message. Supports 5
   * patterns; returns lowercase, deduplicated categories.
   *
   * Pattern priority (when multiple patterns match):
   *   - MCP server pattern wins over plain `category:` (so
   *     `MCP server "foo": ...` produces ["mcp", "foo"], not
   *     ["mcp server \"foo\""])
   *   - All matching patterns are aggregated into the result
   *     (deduplicated). A message can carry multiple categories.
   *
   * Returns an empty array if no category is found.
   */
  export function extractCategories(message: string): string[] {
    const categories: string[] = []

    // Pattern 3 (priority): MCP server "name" — check first to
    // avoid the plain `:` prefix grabbing the literal "MCP server".
    const mcpMatch = message.match(/^MCP server ["']([^"']+)["']/)
    if (mcpMatch && mcpMatch[1]) {
      categories.push("mcp")
      categories.push(mcpMatch[1].toLowerCase())
    } else {
      // Pattern 1: `category: message`
      const prefixMatch = message.match(/^([^:[]+):/)
      if (prefixMatch && prefixMatch[1]) {
        categories.push(prefixMatch[1].trim().toLowerCase())
      }
    }

    // Pattern 2: `[CATEGORY]` at the start
    const bracketMatch = message.match(/^\[([^\]]+)]/)
    if (bracketMatch && bracketMatch[1]) {
      categories.push(bracketMatch[1].trim().toLowerCase())
    }

    // Pattern 4: `1P event:` substring
    if (message.toLowerCase().includes("1p event:")) {
      categories.push("1p")
    }

    // Pattern 5: secondary category after the first `:`
    const secondaryMatch = message.match(/:\s*([^:]+?)(?:\s+(?:type|mode|status|event))?:/)
    if (secondaryMatch && secondaryMatch[1]) {
      const secondary = secondaryMatch[1].trim().toLowerCase()
      // Only add if it's a reasonable category (no spaces, < 30 chars)
      if (secondary.length < 30 && !secondary.includes(" ")) {
        categories.push(secondary)
      }
    }

    return Array.from(new Set(categories))
  }

  /**
   * Check whether a message should be shown given a filter.
   *
   * - filter=null → always show (no filtering)
   * - inclusive  → show only if AT LEAST ONE category is in include[]
   * - exclusive  → show only if NO category is in exclude[]
   *
   * Uncategorized messages (extractCategories returns empty) are
   * EXCLUDED in both modes — the filter user explicitly opted in
   * to a category-based view, and uncategorized noise defeats
   * that.
   */
  export function shouldShowCategories(categories: readonly string[], filter: Config | null): boolean {
    if (!filter) return true
    if (categories.length === 0) return false
    if (filter.isExclusive) {
      return !categories.some((cat) => filter.exclude.includes(cat))
    }
    return categories.some((cat) => filter.include.includes(cat))
  }

  /**
   * High-level dispatch: parse + extract + check in one call.
   * Optimized for the common case where filter is null (just
   * returns true without doing any string work).
   */
  export function shouldShow(message: string, filter: Config | null): boolean {
    if (!filter) return true
    const categories = extractCategories(message)
    return shouldShowCategories(categories, filter)
  }
}
