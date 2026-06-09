// session/grouping.ts
//
// API-round message grouping (Phase 1g of the token-efficiency overhaul).
//
// STATUS: PORTED BUT UNUSED in production. The helper is correct and
// unit-tested but no production code path calls it yet. It exists as the
// foundation for partial-compaction (Phase 2.5+) where the compactor will
// summarize early API rounds while keeping the most recent rounds verbatim.
// Until that work lands, the helper is dead utility code intentionally
// preserved as a stable API surface so the eventual partial-compact wiring
// can drop in without re-porting from the reference implementation.
//
//
// Mirror of instructkr-claude-code/src/services/compact/grouping.ts. Splits a
// flat conversation history into groups where each group corresponds to one
// API round-trip — i.e. one user message followed by everything that came back
// from the assistant for that user turn (any number of assistant text/tool
// chunks plus interleaved tool results).
//
// The boundary fires at the *start* of a NEW assistant message (different
// id from the most recently seen assistant). Within a single API round the
// streaming layer can yield multiple assistant chunks that share an id —
// those stay in the same group. Tool results streamed between chunks of the
// same assistant id stay in the same group as well, since they were pulled
// in by that assistant turn.
//
// Why we want this: opencode's compaction today flattens the entire history
// into one big LLM call. With per-round grouping we can do partial compaction
// (summarize only the first N rounds, keep the most recent rounds verbatim)
// — which is the precondition for streaming/incremental microcompact in
// Phase 2.
//
// For Phase 1 the helper lives in this module without an explicit consumer.
// Phase 1 unit tests assert the boundary semantics; Phase 2 will call this
// from the partial-compact path.

import type { MessageV2 } from "@/process/session/message-v2"

export namespace Grouping {
  /**
   * Split messages into one group per API round (one assistant id).
   *
   * Rules:
   *   - A new group starts when an assistant message with a NEW id appears.
   *   - User messages always join the next assistant group.
   *   - Streaming chunks from the same API response share an id and stay in
   *     the same group regardless of order with their tool results.
   *
   * Malformed conversations (dangling tool_use after resume/truncation)
   * still produce a valid grouping — the boundary only depends on
   * assistant ids, never on tool-result pairing.
   */
  export function byApiRound(messages: MessageV2.WithParts[]): MessageV2.WithParts[][] {
    const groups: MessageV2.WithParts[][] = []
    let current: MessageV2.WithParts[] = []
    let lastAssistantId: string | undefined

    for (const msg of messages) {
      if (msg.info.role === "assistant" && msg.info.id !== lastAssistantId && current.length > 0) {
        groups.push(current)
        current = [msg]
      } else {
        current.push(msg)
      }
      if (msg.info.role === "assistant") {
        lastAssistantId = msg.info.id
      }
    }

    if (current.length > 0) groups.push(current)
    return groups
  }
}
