// src/workflow/predicates.ts — Stage 3 / I3.2: predicate-name registry.
// -------------------------------------------------------------------------
// Authoritative contract:
//   project/software/opencode/specification/contract/gate-predicate-registry.md
//   project/software/opencode/specification/contract/l3-registry.md §predicate-by-name
//
// Simple predicate registry: stable name → callable predicate.
// -------------------------------------------------------------------------

export namespace Predicate {
  /**
   * Uniform input passed to every predicate. Carries the freshly-read
   * task-note body plus the orchestrator's self-asserted flags. Predicates
   * are pure: structural analysis only, no I/O.
   */
  export interface Input {
    /** Full markdown body of the task note being archived. */
    noteContent: string
  }

  /**
   * Uniform output. `{blocked: true}` halts archive with a refusal_reason
   * (typically the predicate's own name) and a detail string surfaced to
   * the operator. `{blocked: false}` lets the next gate evaluate.
   */
  export type Output = { blocked: false } | { blocked: true; detail: string }

  /** A predicate is a pure function from Input → Output. */
  export type Fn = (input: Input) => Output

  // ── Built-in predicates ──────────────────────────────────────────────

  const dispatchQueueEmpty: Fn = (input) => {
    const section = input.noteContent.match(/^##\s+Dispatch queue\s*\n([\s\S]*?)(?=\n##\s|$)/m)?.[1] ?? ""
    if (!section.trim() || section.includes("_Empty —")) return { blocked: false }
    const hasPending = /^\s+>\s+status:\s+(pending|failed|blocked)\s*$/m.test(section)
    if (!hasPending) return { blocked: false }
    return { blocked: true, detail: "Dispatch queue has unresolved entries." }
  }

  // ── Internal state ───────────────────────────────────────────────────

  const REGISTRY: Map<string, Fn> = new Map([["dispatch-queue-empty", dispatchQueueEmpty]])

  // ── Public API ───────────────────────────────────────────────────────

  /**
   * Resolve a predicate name to its callable. Returns `undefined` for
   * unknown names — caller decides whether to skip or surface as error.
   *
   * Lookup is case-sensitive on the kebab name. Names registered are
   * stable for callers.
   */
  export function get(name: string): Fn | undefined {
    return REGISTRY.get(name)
  }

  /**
   * Snapshot of every known predicate name. Used by registry-acceptance
   * tests and runtime callers.
   */
  export function all(): ReadonlyArray<string> {
    return Object.freeze(Array.from(REGISTRY.keys()))
  }

  /**
   * Register a predicate by name. Public entry point for plugins or
   * future Stage-6 federated extensions. Throws on collision (predicate
   * names are stable — silent overrides break the gate-card contract).
   *
   * Tests opt out of the throw via `_resetForTest()` below.
   */
  export function register(name: string, fn: Fn): void {
    if (REGISTRY.has(name)) {
      throw new Error(`Predicate.register: name "${name}" already registered`)
    }
    REGISTRY.set(name, fn)
  }

  /**
   * @internal — test-only reset. Removes any predicate registered after
   * the built-in trio so each test starts from a known baseline.
   */
  export function _resetForTest(): void {
    for (const key of Array.from(REGISTRY.keys())) {
      if (key !== "dispatch-queue-empty") REGISTRY.delete(key)
    }
  }
}
