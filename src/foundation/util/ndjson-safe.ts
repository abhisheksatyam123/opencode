// util/ndjson-safe.ts
//
// JSON.stringify wrapper that survives line-splitting receivers
// (parity gap-28).
//
// PROVENANCE: cp'd from
// `instructkr-claude-code/src/cli/ndjsonSafeStringify.ts` then
// adapted to opencode (dropped the `jsonStringify` indirection
// from `utils/slowOperations` since opencode just uses
// `JSON.stringify` directly; wrapped in a `NdjsonSafe` namespace
// following opencode convention).
//
// THE BUG THIS FIXES: `JSON.stringify` emits U+2028 LINE SEPARATOR
// and U+2029 PARAGRAPH SEPARATOR characters RAW (this is valid per
// ECMA-404 — JSON allows them in strings). When the serialized
// output is a line-delimited stream (NDJSON, SSE `data: …\n\n`,
// JSON-RPC over stdin/stdout, etc.) and the receiver uses
// JavaScript line-terminator semantics (ECMA-262 §11.3 — `\n` `\r`
// U+2028 U+2029) to split incoming chunks, it cuts the JSON
// mid-string and the message is silently dropped.
//
// THE FIX: rewrite U+2028 → `\u2028` and U+2029 → `\u2029` (the
// ASCII escape forms) before sending. The output is STILL valid
// JSON — both representations parse to the same string — but the
// raw byte sequence can never be mistaken for a line terminator
// by ANY receiver. This is what ES2019's "Subsume JSON" proposal
// and Node's `util.inspect` do.
//
// USE CASES IN OPENCODE:
//   * `server/routes/event.ts` — Bus events streamed via SSE (the
//     gap-28 migration target). Tool outputs and file paths are
//     the most likely sources of these chars in production.
//   * `cli/cmd/run.ts` — `process.stdout.write(JSON.stringify(...))`
//     for the run command's NDJSON event log (currently in WIP,
//     migrate when that file is clean).
//   * Future: any plugin that wants to emit NDJSON to stdout.

export namespace NdjsonSafe {
  // Single regex with alternation: the callback's one dispatch per
  // match is cheaper than two full-string scans.
  const JS_LINE_TERMINATORS = /\u2028|\u2029/g

  function escapeJsLineTerminators(json: string): string {
    return json.replace(JS_LINE_TERMINATORS, (c) => (c === "\u2028" ? "\\u2028" : "\\u2029"))
  }

  /**
   * `JSON.stringify` for line-delimited transports. Escapes U+2028
   * and U+2029 so the serialized output cannot be broken by a
   * line-splitting receiver. Output is still valid JSON and parses
   * to the same value via `JSON.parse`.
   *
   * Pass a `replacer` and/or `space` arg the same as you would to
   * `JSON.stringify`.
   */
  export function stringify(
    value: unknown,
    replacer?: (this: unknown, key: string, value: unknown) => unknown,
    space?: string | number,
  ): string {
    return escapeJsLineTerminators(JSON.stringify(value, replacer, space))
  }

  // gap-28-followup-4: read counterpart for the canonical NDJSON
  // file pattern (history, stash, frecency, …) — split on `\n`,
  // drop empty lines, JSON.parse each, silently skip parse errors.
  // Centralizes the 9-line boilerplate that was duplicated across
  // every TUI persistence store.
  //
  // INTENTIONALLY uses `\n` (not `\r?\n`) because:
  //   * NdjsonSafe.stringify always emits `\n`-joined output (we
  //     control the writer side), and
  //   * `.filter(Boolean)` drops the empty string left by a trailing
  //     `\r` byte, so a CRLF line ends as `<json>\r` → JSON.parse
  //     fails → silently skipped (defensive). Callers that need to
  //     parse `\r\n`-delimited input from foreign tools (e.g.
  //     ripgrep on Windows) should use a regex split themselves —
  //     this helper is for opencode's own NDJSON files.
  //
  // Type-safe via a generic — callers can declare the expected
  // shape and the result is `T[]` (the helper does NOT validate
  // the parsed payload, that's the caller's job via Zod / similar).
  export function parseLines<T = unknown>(text: string): T[] {
    if (!text) return []
    const out: T[] = []
    for (const line of text.split("\n")) {
      if (!line) continue
      try {
        out.push(JSON.parse(line) as T)
      } catch {
        // Silently skip — corrupt lines are dropped, the rest of
        // the file is still readable. This is the same shape as
        // the inline boilerplate it replaces.
      }
    }
    return out
  }
}
