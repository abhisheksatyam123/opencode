// src/retrieval/index.ts — Stage 4 / I4.1: persistent-memory retrieval ranker.
// -------------------------------------------------------------------------
// Authoritative contract:
//   project/software/opencode/specification/contract/persistent-memory-protocol.md
//     §retrieval-algorithm: relevance signals = path-prefix, backlinks,
//     tag overlap, text/symbol match, recency decay, verification freshness.
//   project/software/opencode/specification/schema/policy-card.md §domain=retrieval
//     fields: tag_weight, path_weight, backlink_weight, recency_half_life_days
//
// Pure-function ranker — no I/O, no
// vault traversal, no Policy reads. The caller assembles the candidate
// set + weights and passes them in; the ranker computes scores and
// returns the top-K. This split keeps the formula trivially testable
// (no fixtures) and lets the caller decide where note metadata comes
// from (filesystem walk, prebuilt index, etc.).
//
// Architectural shape:
//
//   - 3-method API (mirrors L3 surface): `rank(input)` is the only
//     public entry; `extractMetadata(content)` is a helper for callers
//     building candidate sets from raw markdown; `combine(weights, ...)`
//     is the per-note score helper exposed for tests.
//   - Weights resolved via `Policy.get("retrieval").values` at the
//     calling site, passed in as a typed `Weights` object. The ranker
//     itself does NOT import Policy — keeps it pure + reusable.
//   - Recency decay: `0.5 ^ (age_days / recency_half_life_days)` —
//     standard exponential half-life. Notes with no `updated:` frontmatter
//     get recency_factor = 0.5 (treated as ~one-half-life-old).
//   - Score combination: weighted sum of normalized [0,1] factors, then
//     bounded to [0,1] (sum of weights need not equal 1; weights are
//     relative importance, not probabilities).
// -------------------------------------------------------------------------

import { Policy } from "@/permission/policy"

export namespace Retrieval {
  /**
   * Weights for the multi-factor ranker. Read from
   * `Policy.get("retrieval").values` at the calling site. All weights
   * are non-negative floats in [0, 1]; the ranker normalises by their
   * sum so callers can pass any positive scale.
   *
   * `recency_half_life_days` is in days (NOT a weight — it parametrises
   * the recency decay curve). 30 days ≈ a 4-week half-life.
   */
  export interface Weights {
    tag_weight: number
    path_weight: number
    backlink_weight: number
    recency_half_life_days: number
  }

  /**
   * Pre-extracted note metadata. Caller builds this from raw markdown +
   * filesystem stats; the ranker is pure on this shape.
   *
   * - `tags`: lowercased kebab tag strings (e.g. ["concept/cache",
   *   "skill/agent-workflow"]).
   * - `path`: vault-relative path without `.md` (e.g.
   *   "atomic/concept/cache-invalidation").
   * - `backlinkCount`: count of `[[wikilink]]` references TO this note
   *   from anywhere else in the vault. Higher = more central.
   * - `updatedAt`: ISO date string from frontmatter `updated:`. Optional.
   *   Missing = recency factor 0.5 (one half-life old).
   */
  export interface Candidate {
    path: string
    tags: ReadonlyArray<string>
    backlinkCount: number
    updatedAt?: string
    /** Optional opaque payload returned alongside the ranking. */
    payload?: unknown
  }

  /**
   * Caller-supplied query. Only the structural signals — keyword
   * matching is a separate filter applied BEFORE ranking (or skipped
   * entirely when no keywords are available).
   *
   * - `queryTags`: tags from the active task note's frontmatter +
   *   `## Tags` section.
   * - `queryPathHints`: directory prefixes for path-overlap scoring,
   *   e.g. ["project/software/opencode"] when the active task is in
   *   that subtree.
   * - `now`: timestamp used for recency decay. Caller passes
   *   `Date.now()` in production, fixed value in tests.
   */
  export interface Query {
    queryTags: ReadonlyArray<string>
    queryPathHints: ReadonlyArray<string>
    now: number
  }

  export interface RankedNote {
    path: string
    score: number
    factors: {
      tag: number
      path: number
      backlink: number
      recency: number
    }
    payload?: unknown
  }

  /**
   * Default weights — matches `Policy.DEFAULT_POLICY_VALUES.retrieval`
   * exactly. Caller may pass override; absent override → these.
   *
   * Mirrors Stage 2 wiring (`src/policy/index.ts:243` retrieval block).
   */
  export const DEFAULT_WEIGHTS: Readonly<Weights> = Object.freeze({
    tag_weight: 0.4,
    path_weight: 0.3,
    backlink_weight: 0.2,
    recency_half_life_days: 30,
  })

  /**
   * Resolve the live weights via the Policy L3 registry (Stage 4 / I4.2).
   *
   * Resolution chain (mirrors `src/session/overflow.ts` I2.2):
   *   1. Policy.get("retrieval").values     vault-loaded card
   *   2. DEFAULT_WEIGHTS                    in-code last-resort
   *
   * The Policy registry's `get()` itself folds in `DEFAULT_POLICY_VALUES`
   * for empty-vault degraded boot, so steps 1 and 2 collapse to identical
   * answers when the vault has no `atomic/policy/retrieval.md` card.
   * Migration-safe: empty vault ⇒ behavior byte-identical to pre-Stage-4.
   *
   * Per-key fallback (rule 3) is enforced by Policy at load time; this
   * helper only inspects the validated record. If a key is missing or
   * out-of-range despite Policy fallback (defence-in-depth), the in-code
   * default for that key is substituted here too.
   */
  export function resolveWeights(): Weights {
    const card = Policy.get("retrieval")
    if (!card) return DEFAULT_WEIGHTS
    const v = card.values
    return {
      tag_weight: typeof v.tag_weight === "number" ? v.tag_weight : DEFAULT_WEIGHTS.tag_weight,
      path_weight: typeof v.path_weight === "number" ? v.path_weight : DEFAULT_WEIGHTS.path_weight,
      backlink_weight: typeof v.backlink_weight === "number" ? v.backlink_weight : DEFAULT_WEIGHTS.backlink_weight,
      recency_half_life_days:
        typeof v.recency_half_life_days === "number" && v.recency_half_life_days > 0
          ? v.recency_half_life_days
          : DEFAULT_WEIGHTS.recency_half_life_days,
    }
  }

  // ── Per-factor scorers ───────────────────────────────────────────────

  /**
   * Tag overlap: |query ∩ candidate| / |query ∪ candidate| — Jaccard
   * similarity bounded to [0, 1]. Empty query OR empty candidate → 0.
   */
  export function tagOverlap(queryTags: ReadonlyArray<string>, candidateTags: ReadonlyArray<string>): number {
    if (queryTags.length === 0 || candidateTags.length === 0) return 0
    const q = new Set(queryTags.map((t) => t.toLowerCase()))
    const c = new Set(candidateTags.map((t) => t.toLowerCase()))
    let intersection = 0
    for (const t of q) if (c.has(t)) intersection++
    const union = q.size + c.size - intersection
    return union === 0 ? 0 : intersection / union
  }

  /**
   * Path prefix overlap: longest matching prefix as a fraction of the
   * candidate path's segment count. Scores `atomic/concept/cache-x`
   * against the hint `atomic/concept/...` higher than against
   * `project/software/...`. Returns the BEST score across all hints.
   */
  export function pathPrefixScore(candidatePath: string, hints: ReadonlyArray<string>): number {
    if (hints.length === 0) return 0
    const candSegs = candidatePath.split("/").filter(Boolean)
    if (candSegs.length === 0) return 0
    let best = 0
    for (const hint of hints) {
      const hintSegs = hint.split("/").filter(Boolean)
      let matched = 0
      for (let i = 0; i < Math.min(hintSegs.length, candSegs.length); i++) {
        if (hintSegs[i] === candSegs[i]) matched++
        else break
      }
      const score = matched / candSegs.length
      if (score > best) best = score
    }
    return best
  }

  /**
   * Backlink count → bounded score in [0, 1]. Uses a saturating curve:
   * `1 - 1 / (1 + count)` so `count=0 → 0`, `count=1 → 0.5`, `count=4 → 0.8`,
   * `count→∞ → 1`. Avoids unbounded growth crowding out other factors.
   */
  export function backlinkScore(count: number): number {
    if (count <= 0) return 0
    return 1 - 1 / (1 + count)
  }

  /**
   * Recency factor: `0.5 ^ (age_days / half_life_days)` — exponential
   * half-life. Notes with no `updatedAt` get 0.5 (treated as one half-
   * life old, neither boosted nor penalised).
   *
   * `now` and `updatedAt` parsed via `Date.parse`; invalid dates fall
   * back to the no-updatedAt branch (0.5).
   */
  export function recencyFactor(updatedAt: string | undefined, now: number, halfLifeDays: number): number {
    if (!updatedAt) return 0.5
    const updated = Date.parse(updatedAt)
    if (Number.isNaN(updated)) return 0.5
    const ageMs = Math.max(0, now - updated)
    const ageDays = ageMs / (24 * 60 * 60 * 1000)
    if (halfLifeDays <= 0) return 0.5 // ill-formed weight → neutral
    return Math.pow(0.5, ageDays / halfLifeDays)
  }

  // ── Score combination ────────────────────────────────────────────────

  /**
   * Weighted-sum combiner. Caller passes per-factor scores in [0, 1];
   * combiner returns the normalized weighted average in [0, 1].
   *
   * Normalization divides by the sum of weights so callers can pass
   * weights at any positive scale (and zero-weight factors are simply
   * skipped). Returns 0 when all weights are 0 (degenerate case).
   */
  export function combine(
    weights: Weights,
    factors: { tag: number; path: number; backlink: number; recency: number },
  ): number {
    const w = weights.tag_weight + weights.path_weight + weights.backlink_weight
    if (w <= 0) return 0
    // recency multiplies the structural score (it's a freshness weight,
    // not a positional signal). Pure structural blend then dampened by
    // age. This matches the contract's "recency decay" wording: older
    // notes are still findable but rank lower than equally-relevant
    // fresher ones.
    const structural =
      (weights.tag_weight * factors.tag +
        weights.path_weight * factors.path +
        weights.backlink_weight * factors.backlink) /
      w
    return Math.max(0, Math.min(1, structural * factors.recency))
  }

  // ── Public ranker entry point ────────────────────────────────────────

  export interface Input {
    query: Query
    candidates: ReadonlyArray<Candidate>
    weights?: Weights
    /** Top-K cap; default 10. */
    topK?: number
    /** Optional exclusion set (e.g. notes already cited). */
    exclude?: ReadonlyArray<string>
  }

  /**
   * Rank a candidate set against the query. Pure: no I/O. Returns
   * top-K notes by descending score, ties broken by path asc.
   *
   * Excluded paths are dropped before scoring (cheap path-equality
   * check). Zero-score candidates are dropped from the result.
   */
  export function rank(input: Input): ReadonlyArray<RankedNote> {
    const weights = input.weights ?? DEFAULT_WEIGHTS
    const topK = Math.max(1, input.topK ?? 10)
    const exclude = new Set(input.exclude ?? [])

    const scored: RankedNote[] = []
    for (const c of input.candidates) {
      if (exclude.has(c.path)) continue
      const factors = {
        tag: tagOverlap(input.query.queryTags, c.tags),
        path: pathPrefixScore(c.path, input.query.queryPathHints),
        backlink: backlinkScore(c.backlinkCount),
        recency: recencyFactor(c.updatedAt, input.query.now, weights.recency_half_life_days),
      }
      const score = combine(weights, factors)
      if (score <= 0) continue
      scored.push({ path: c.path, score, factors, payload: c.payload })
    }

    scored.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score
      return a.path.localeCompare(b.path)
    })
    return Object.freeze(scored.slice(0, topK))
  }

  // ── Markdown helpers (caller-side) ───────────────────────────────────

  /**
   * Extract `tags:` array from a frontmatter block. Accepts both
   * inline `tags: [a, b]` and block-style YAML lists. Returns
   * lowercased kebab strings; missing frontmatter → [].
   *
   * Defensive: never throws. Malformed YAML returns empty array.
   */
  export function extractTags(rawMarkdown: string): string[] {
    const fm = /^---\n([\s\S]*?)\n---/.exec(rawMarkdown)
    if (!fm) return []
    const block = fm[1]
    // Inline form: `tags: [a, b, c]`
    const inline = /^tags:\s*\[([^\]]*)\]\s*$/m.exec(block)
    if (inline) {
      return inline[1]
        .split(",")
        .map((t) => t.trim().replace(/^['"]|['"]$/g, ""))
        .filter((t) => t.length > 0)
        .map((t) => t.toLowerCase())
    }
    // Block form:
    //   tags:
    //     - a
    //     - b
    const blockMatch = /^tags:\s*\n((?:\s+-\s+.+\n?)+)/m.exec(block)
    if (blockMatch) {
      return blockMatch[1]
        .split("\n")
        .map((line) => line.replace(/^\s*-\s*/, "").trim())
        .filter((t) => t.length > 0)
        .map((t) => t.replace(/^['"]|['"]$/g, "").toLowerCase())
    }
    return []
  }

  /**
   * Extract `updated:` from frontmatter. Returns the raw value (caller
   * passes through `Date.parse`). Missing → undefined.
   */
  export function extractUpdated(rawMarkdown: string): string | undefined {
    const fm = /^---\n([\s\S]*?)\n---/.exec(rawMarkdown)
    if (!fm) return undefined
    const m = /^updated:\s*(.+)$/m.exec(fm[1])
    if (!m) return undefined
    return m[1].trim().replace(/^['"]|['"]$/g, "")
  }
}
