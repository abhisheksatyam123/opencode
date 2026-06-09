// src/workflow/registry-events.ts — Stage 7 (I7.2) shared bus-event surface
// for L3 registry hot-reload notifications.
// -------------------------------------------------------------------------
// Authoritative contract:
//   project/software/opencode/specification/contract/bus-service.md
//     §L3 registry reload events (file-loaded-OS) — payload schemas + kind
//     enumeration + advisory-not-authoritative semantics + GlobalBus fan-out.
//
//   project/software/opencode/specification/contract/l3-registry.md
//     §provider-obligations P5 — every L3 registry MUST publish
//     `<kind>.reloaded` after every successful reload (incl. count=0);
//     MUST publish `<kind>.load_failed` only on infrastructure errors
//     (schema-level errors surface via `Registry.errors()`, not this event).
//
// Why a shared module (not per-registry):
//
//  1. **Single source of truth for `RegistryKind`** — V.2 audit
//     (`test/_audit/registry-literal-guard.test.ts`) enforces no closed-enum
//     literals outside documented carve-outs. The 7 registry-kind literals
//     (`phase` · `runtime-role` · `dispatch-reason` · `policy`
//     · `tool-card` · `process`) live here as B-class (built-in DEFAULT enumeration);
//     consumers reference them via `RegistryKind.<...>` not bare strings.
//
//  2. **Uniform event shape** — every registry's reload notification has the
//     SAME payload schema, so subscribers (markPacketStale wiring per I7.3,
//     TUI status bar, scribe) can `Bus.subscribe` once + branch on `kind`.
//
//  3. **Cross-instance fan-out** — bus-service §invariant I7 routes every
//     event to GlobalBus; tooling subscribes globally to render registry
//     health. By centralising the BusEvent definitions here, the discriminated
//     union of bus payloads is well-typed at the consumer.
// -------------------------------------------------------------------------

import z from "zod"
import { BusEvent } from "@/bus/bus-event"

export namespace RegistryEvent {
  // ── RegistryKind closed enum ─────────────────────────────────────────
  //
  // The seven L3 registries shipped through Stages 1-8. New registries MUST
  // append here AND register a literal-guard carve-out entry per V.2 audit.
  // Federation kinds (Stage 6) and the bus-service-spec extras (verify-criterion,
  // federated-source, retrieval) will join here when they ship.
  //
  // The literal vocabulary is closed BY THIS MODULE — every registry references
  // these constants, never bare string literals.

  export const RegistryKind = z.enum([
    "phase",
    "runtime-role",
    "dispatch-reason",
    "policy",
    "tool-card",
    "process", // ProcessRegistry source: task-note frontmatter `pcb` block.
    "message-type", // Typed IPC message-type registry source: atomic/message-type cards.
  ])
  export type RegistryKind = z.infer<typeof RegistryKind>

  // ── Reloaded event ───────────────────────────────────────────────────
  //
  // Fires on every successful reload — including no-op transitions (count=0)
  // and reloads that produced schema-level errors. Per spec, the schema-error
  // count is exposed in payload, not as a separate event.

  export const Reloaded = BusEvent.define(
    "registry.reloaded",
    z.object({
      /** RegistryKind — closed enum, see above. */
      kind: RegistryKind,
      /** Number of records in the freshly-published snapshot (0 on empty vault). */
      count: z.number().int().min(0),
      /** Number of LoadError entries in the freshly-published snapshot. */
      errors: z.number().int().min(0),
      /** Wall-clock load duration in milliseconds. */
      durationMs: z.number().int().min(0),
      /** Source IDs that contributed to the snapshot. Stage 1-5 = ["vault"] only;
       *  Stage 6 federation expands to ["vault", "federated:<source>", ...]. */
      sourceIds: z.array(z.string()),
      // ── Stage 7.1 D.2 (file-loaded-OS roadmap) — diff vs prior snapshot ──
      // Per `bus-service.md §Extended payload schema (Stage 7)`. Subscribers
      // (markPacketStale, TUI status bar, scribe) react to specific name
      // changes without re-scanning the registry.
      //
      // Backward compatible: always present (empty arrays for first reload
      // and no-op transitions). Pre-Stage-7.1 subscribers ignore these.
      //
      // Invariant: `added.length + removed.length + changed.length === 0`
      // iff the new snapshot is reference-identical to the prior (l3-registry
      // I10 no-op reload identity). Subscribers MAY use this as a fast-path
      // skip (e.g. avoid markPacketStale on a no-op reload).
      /** Names present in new snapshot but not in prior. First reload = all names. */
      added: z.array(z.string()),
      /** Names present in prior snapshot but not in new. */
      removed: z.array(z.string()),
      /** Names present in both, but at least one field differs (deep-equal). */
      changed: z.array(z.string()),
    }),
  )

  /**
   * Compute the diff arrays for a `Reloaded` payload. Centralised here so
   * every L3 registry uses the same set-difference + structural-equality
   * semantics (per bus-service §Diff computation rules).
   *
   * Inputs are name → record maps. The prior map is `null` on the very
   * first reload (no prior snapshot exists); in that case `added` = all
   * names, `removed` = `[]`, `changed` = `[]` (per spec).
   *
   * Equality:
   *   - `JSON.stringify` on the record minus the `_source` provenance field
   *     (provenance is registry-internal; same vault file two reloads in a
   *     row yields identical canonical content even though the loader
   *     re-read the file).
   *   - Stable key ordering via `Object.keys().sort()` so field-order
   *     differences don't flag as "changed".
   *
   * Why deep-equal here, not in each registry: 6 registries have 6 record
   * shapes; centralising avoids each registry re-rolling structural
   * equality (and getting it subtly wrong).
   */
  export function computeDiff(
    prior: ReadonlyMap<string, unknown> | null,
    next: ReadonlyMap<string, unknown>,
    options?: { aliasFilter?: (name: string, rec: unknown) => boolean },
  ): { added: string[]; removed: string[]; changed: string[] } {
    // Filter aliases — registries (Phase, ToolCard) index canonical name
    // PLUS aliases pointing at the same frozen record. Diff should report
    // canonical names only; aliases are an indexing detail.
    //
    // Default filter: keep entries where the value's `_source` field is set
    // (canonical record) — alias entries share the same value object but
    // are reachable via a different key. Since they share the SAME object
    // reference, we deduplicate by object identity below.
    const canonical = (m: ReadonlyMap<string, unknown>) => {
      const out = new Map<string, unknown>()
      const seen = new Set<unknown>() // dedup by object identity
      for (const [name, rec] of m) {
        if (options?.aliasFilter && !options.aliasFilter(name, rec)) continue
        if (seen.has(rec)) continue // alias entry — same object, different key
        seen.add(rec)
        out.set(name, rec)
      }
      return out
    }

    const newCanonical = canonical(next)
    const newNames = new Set(newCanonical.keys())

    if (prior === null || prior.size === 0) {
      return { added: [...newNames].sort(), removed: [], changed: [] }
    }

    const priorCanonical = canonical(prior)
    const priorNames = new Set(priorCanonical.keys())

    const added: string[] = []
    const removed: string[] = []
    const changed: string[] = []

    for (const n of newNames) if (!priorNames.has(n)) added.push(n)
    for (const n of priorNames) if (!newNames.has(n)) removed.push(n)
    for (const n of newNames) {
      if (!priorNames.has(n)) continue
      const a = priorCanonical.get(n)
      const b = newCanonical.get(n)
      if (!structurallyEqual(a, b)) changed.push(n)
    }

    return { added: added.sort(), removed: removed.sort(), changed: changed.sort() }
  }

  /**
   * Stable structural equality for registry records. Strips `_source`
   * (registry-internal provenance). Sorts keys before stringifying to
   * make field-order non-significant. Records are frozen plain objects,
   * not arbitrary class instances; JSON canonicalisation is sufficient.
   */
  function structurallyEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true
    if (a == null || b == null) return false
    return canonicalJSON(a) === canonicalJSON(b)
  }

  function canonicalJSON(v: unknown): string {
    return JSON.stringify(v, (_k, val) => {
      if (val && typeof val === "object" && !Array.isArray(val)) {
        const out: Record<string, unknown> = {}
        for (const k of Object.keys(val).sort()) {
          if (k === "_source") continue // strip provenance
          out[k] = (val as Record<string, unknown>)[k]
        }
        return out
      }
      return val
    })
  }

  // ── LoadFailed event ─────────────────────────────────────────────────
  //
  // Fires ONLY on infrastructure errors that prevented attempting the reload:
  //   - vault subtree fs.readdir threw EACCES / ENOENT-on-mount
  //   - fs.watch threw EMFILE (descriptor exhaustion)
  //   - federated source HTTP fetch returned 5xx (Stage 6)
  //
  // Schema-level errors (bad cards, unresolved cross-refs, predicate-name
  // unknown) DO NOT trigger this event — they surface via `Registry.errors()`
  // with `Reloaded` carrying `errors > 0`.

  export const LoadFailed = BusEvent.define(
    "registry.load_failed",
    z.object({
      kind: RegistryKind,
      /** Structured reason: "fs.readdir" | "fs.watch.emfile" | "fs.watch.eperm" |
       *  "federated.fetch" | "unknown". Closed-vocabulary; extend on new failure
       *  modes. */
      reason: z.string(),
      /** Free-text detail captured from the underlying error. */
      detail: z.string(),
    }),
  )

  /** Discriminated-union type combining both events for convenience. */
  export type Any =
    | { type: typeof Reloaded.type; properties: z.infer<typeof Reloaded.properties> }
    | { type: typeof LoadFailed.type; properties: z.infer<typeof LoadFailed.properties> }

  /**
   * Detect the Bus-not-bootstrapped error so registries can downgrade
   * publish failures to debug-level in test contexts (where the Bus
   * Effect-runtime layer isn't always wired). Real publish failures
   * (PubSub closed, etc) still surface as warnings.
   */
  export function isBusNotBootstrapped(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err)
    return msg.includes("No context found for instance") || msg.includes("InstanceState")
  }
}
