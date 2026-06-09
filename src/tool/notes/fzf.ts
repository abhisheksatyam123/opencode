/**
 * fzf.ts — fzf-style fuzzy scoring for note/heading candidates.
 *
 * scoreQuery(query, target) → number
 *   Returns a score ≥ 0. Higher = better match. 0 = no match (query chars
 *   not a subsequence of target).
 *
 * Scoring bonuses (additive):
 *   +16 per consecutive matching character run
 *   +8  per match at a word boundary (start of word after space, /, -, _)
 *   +4  per match at start of target
 *   +1  per matched character (base)
 *   penalty: -1 per unmatched gap character
 *
 * Case-insensitive. Returns 0 if query is not a subsequence of target.
 */
export function scoreQuery(query: string, target: string): number {
  if (!query || !target) return 0

  const q = query.toLowerCase()
  const t = target.toLowerCase()

  // Check subsequence first — fast reject
  let qi = 0
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (q[qi] === t[ti]) qi++
  }
  if (qi < q.length) return 0

  // Score the best alignment via greedy forward scan
  let score = 0
  let qIdx = 0
  let prevMatchIdx = -2
  let consecutive = 0

  for (let tIdx = 0; tIdx < t.length && qIdx < q.length; tIdx++) {
    if (q[qIdx] === t[tIdx]) {
      // Base match
      score += 1

      // Consecutive run bonus
      if (tIdx === prevMatchIdx + 1) {
        consecutive++
        score += 16
      } else {
        consecutive = 0
      }

      // Word boundary bonus
      if (tIdx === 0) {
        score += 4 // start of target
      } else {
        const prev = t[tIdx - 1]
        if (prev === " " || prev === "/" || prev === "-" || prev === "_") {
          score += 8
        }
      }

      prevMatchIdx = tIdx
      qIdx++
    } else {
      // Gap penalty
      score -= 1
    }
  }

  // Remaining unmatched chars in target after last match
  if (prevMatchIdx >= 0 && prevMatchIdx < t.length - 1) {
    score -= t.length - 1 - prevMatchIdx
  }

  return Math.max(0, score)
}

/**
 * Score a note path+description against a query.
 * Combines path score + description score.
 */
export function scoreNote(query: string, notePath: string, description: string): number {
  const pathScore = scoreQuery(query, notePath)
  const descScore = scoreQuery(query, description)
  return pathScore + descScore
}
