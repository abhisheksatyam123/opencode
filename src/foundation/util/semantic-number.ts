// util/semantic-number.ts
//
// Strict numeric coercion for tool input schemas (parity gap-27).
//
// PROVENANCE: cp'd from
// `instructkr-claude-code/src/utils/semanticNumber.ts` then adapted
// to opencode (changed `import { z } from 'zod/v4'` to opencode's
// `import z from 'zod'` since opencode is already on zod 4.x at the
// top level — no `/v4` namespace needed).
//
// THE PROBLEM: opencode uses `z.coerce.number()` in 8+ places
// (read.ts, notes/index.ts, server/routes/*.ts, …) to accept tool
// inputs from the model. The model occasionally quotes a number —
// `"head_limit":"30"` instead of `"head_limit":30` — and a strict
// `z.number()` would reject it. `z.coerce.number()` is the wrong
// fix because it ALSO accepts garbage:
//
//   z.coerce.number().parse("")    // → 0   (silently)
//   z.coerce.number().parse(null)  // → 0   (silently)
//   z.coerce.number().parse([])    // → 0   (silently)
//   z.coerce.number().parse("3a")  // → NaN (silently)
//
// All of these mask bugs — the tool gets a garbage number and
// produces a garbage result instead of surfacing a validation
// error the model can recover from.
//
// THE FIX: only coerce strings that match `/^-?\d+(\.\d+)?$/` (a
// strict decimal-number regex). Anything else passes through and is
// rejected by the inner schema, so the model sees a real validation
// error and can correct its call.
//
// USAGE:
//
//   semanticNumber()                              → number
//   semanticNumber(z.number().optional())         → number | undefined
//   semanticNumber(z.number().default(0))         → number
//   semanticNumber(z.number().int().min(1).max(200)) → bounded int
//
// `.optional()` / `.default()` go INSIDE on the inner schema, NOT
// chained after — chaining onto a `ZodPipe` widens `z.output<>` to
// `unknown` in zod v4.
//
// MIGRATION TARGETS (future iterations):
//   * `tool/read.ts:44-45` (offset, limit)
//   * `tool/notes/types.ts` (line, context, level)
//   * `server/routes/experimental.ts:326` (limit)
//   * `server/routes/session.ts:56` (limit)
//   * `server/routes/file.ts:68` (limit)
//
// Each is a mechanical s/z.coerce.number()/semanticNumber()/ — left
// for a follow-up commit to keep this iteration small and verifiably
// regression-free.

import z from "zod"

/**
 * Number that also accepts numeric string literals like "30", "-5",
 * "3.14". Defends against the "model quoted a number" pattern that
 * `z.number()` rejects without coercing garbage like `""` / `null`
 * the way `z.coerce.number()` does.
 *
 * `z.preprocess` emits `{"type":"number"}` to the API schema, so
 * the model is still told this is a number — the string tolerance
 * is invisible client-side coercion, not an advertised input shape.
 */
export function semanticNumber<T extends z.ZodType>(inner: T = z.number() as unknown as T) {
  return z.preprocess((v: unknown) => {
    if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) {
      const n = Number(v)
      if (Number.isFinite(n)) return n
    }
    return v
  }, inner)
}
