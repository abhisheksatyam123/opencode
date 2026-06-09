// src/workflow/message-validator.ts — pure Systems/Coordination envelope validator (Stage 11).
// ---------------------------------------------------------------------------
// Validates the markdown content of a `## Systems / ### Coordination` write before it
// is committed to disk.  No file I/O — safe to call in unit tests without a
// vault.
//
// Spec: project/software/opencode/specification/contract/message-type-registry
//       §"Validator hook design (D.4)"
// ---------------------------------------------------------------------------

import type { MessageType } from "@/permission/policy/message"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ValidatorOk {
  ok: true
  warnings?: string[]
}

export interface ValidatorError {
  ok: false
  error: string
  field?: string
  type?: string
  thread?: string
}

export type ValidatorResult = ValidatorOk | ValidatorError

// ---------------------------------------------------------------------------
// Envelope parsing
// ---------------------------------------------------------------------------

/**
 * Regex that matches the metadata line of a Messages envelope:
 *   `- <ISO-ts> | type: <type> | thread: <thread-id>`
 * Named groups: ts, type, thread.
 */
const ENVELOPE_RE = /^\s*-\s*(?<ts>[^|]+)\|\s*type:\s*(?<type>[^|]+)\|\s*thread:\s*(?<thread>[^\s|]+)/

/**
 * ISO-8601 timestamp — accepts both date-only and full datetime forms.
 * Deliberately permissive: YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS[.mmm][Z|±HH:MM]
 */
const ISO8601_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/

interface ParsedEnvelope {
  /** Raw metadata line (for error messages) */
  rawLine: string
  ts: string
  type: string
  thread: string
  /** Lines that form the body block (indented `>` lines after the metadata line) */
  bodyLines: string[]
}

/**
 * Parse all envelope entries from a Systems/Coordination content string.
 *
 * Returns either a list of parsed envelopes or a structured error if a
 * metadata line is present but cannot be parsed.
 */
function parseEnvelopes(content: string): { envelopes: ParsedEnvelope[] } | ValidatorError {
  const lines = content.split("\n")
  const envelopes: ParsedEnvelope[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Detect lines that look like they intend to be envelope metadata lines
    // (start with optional whitespace + "- " and contain "|") but may be malformed.
    const looksLikeEnvelope = /^\s*-\s+\S/.test(line) && line.includes("|")
    if (!looksLikeEnvelope) continue

    const m = ENVELOPE_RE.exec(line)
    if (!m || !m.groups) {
      return {
        ok: false,
        error: `Messages validator: malformed envelope line — expected '- <ts> | type: <t> | thread: <id>'`,
      }
    }

    const ts = m.groups.ts.trim()
    const type = m.groups.type.trim()
    const thread = m.groups.thread.trim()

    // Collect body block: contiguous `>` lines after this metadata line
    const bodyLines: string[] = []
    for (let j = i + 1; j < lines.length; j++) {
      const bl = lines[j]
      if (/^\s*>/.test(bl)) {
        bodyLines.push(bl)
      } else if (bl.trim() === "") {
        // blank lines inside body block are allowed
        continue
      } else {
        break
      }
    }

    envelopes.push({ rawLine: line, ts, type, thread, bodyLines })
  }

  return { envelopes }
}

// ---------------------------------------------------------------------------
// Field presence check
// ---------------------------------------------------------------------------

/**
 * Returns true if `fieldName` appears as a key in the body block lines.
 * Matches `fieldName:` anywhere in the body (simple key-presence check,
 * not value validation per D.4 non-goals).
 */
function bodyHasField(bodyLines: string[], fieldName: string): boolean {
  const re = new RegExp(`\\b${escapeRe(fieldName)}\\s*:`)
  return bodyLines.some((l) => re.test(l))
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// ---------------------------------------------------------------------------
// Main validator
// ---------------------------------------------------------------------------

/**
 * Validate the markdown content of a `## Systems / ### Coordination` write.
 *
 * @param content   Raw markdown content string (the value being written).
 * @param getCard   Lookup function — returns the MessageType.Info for a given
 *                  type name, or `undefined` if unknown.  Injected so this
 *                  function stays pure and testable without a live registry.
 *
 * @returns `{ ok: true, warnings? }` if the write should proceed, or
 *          `{ ok: false, error, field?, type?, thread? }` to reject it.
 */
export function validateMessagesContent(
  content: string,
  getCard: (name: string) => MessageType.Info | undefined,
): ValidatorResult {
  const parsed = parseEnvelopes(content)

  // Envelope parse failure — hard reject
  if (!("envelopes" in parsed)) {
    return parsed
  }

  const { envelopes } = parsed
  const warnings: string[] = []

  for (const env of envelopes) {
    const { ts, type, thread, bodyLines } = env

    // 1. Validate timestamp is ISO-8601
    if (!ISO8601_RE.test(ts)) {
      return {
        ok: false,
        error: `Messages validator: invalid timestamp '${ts}' (expected ISO-8601)`,
        type,
        thread: thread || undefined,
      }
    }

    // 2. Validate thread is non-empty
    if (!thread) {
      return {
        ok: false,
        error: `Messages validator: missing thread id`,
        type,
      }
    }

    // 3. Look up card
    const card = getCard(type)

    if (!card) {
      // Unknown type — warning only, write proceeds (per D.4)
      warnings.push(`Messages validator: unknown message type '${type}' (warning only, write proceeds)`)
      continue
    }

    // 4. Validate required fields present in body block
    for (const field of card.required_fields) {
      // Envelope-level fields (timestamp, type, thread, sender, recipient) are
      // carried in the metadata line itself, not the body block — skip them.
      const ENVELOPE_LEVEL = new Set(["timestamp", "type", "thread", "sender", "recipient", "body"])
      if (ENVELOPE_LEVEL.has(field)) continue

      if (!bodyHasField(bodyLines, field)) {
        return {
          ok: false,
          error: `Messages validator: missing required field '${field}' for type '${type}' (thread: ${thread})`,
          field,
          type,
          thread,
        }
      }
    }
  }

  return warnings.length > 0 ? { ok: true, warnings } : { ok: true }
}
