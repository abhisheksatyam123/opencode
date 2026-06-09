// provider/cache-flags.ts
//
// Per-model + global prompt-caching opt-out env vars (Fix 4 of the
// qpilot/qgenie token efficiency arc).
//
// PROVENANCE: pattern ported from Claude Code's
// `services/api/claude.ts:getPromptCachingEnabled` function. The
// reference's design philosophy: prompt caching is ENABLED by default
// for every model, with explicit opt-out env vars per model family
// (DISABLE_PROMPT_CACHING_HAIKU, _SONNET, _OPUS) plus a global
// DISABLE_PROMPT_CACHING. opencode adopts the same shape with its
// own naming convention (OPENCODE_DISABLE_CACHING + per-model variant).
//
// USE CASES:
//
//   1. EMERGENCY KILL SWITCH — a deployment of qpilot/qgenie is
//      misbehaving and breaking the cache for a specific model. Set
//      `OPENCODE_DISABLE_CACHING_QPILOT_CLAUDE_SONNET_4_6=1` and
//      opencode stops emitting cache markers / prompt_cache_key for
//      that model only. Other models continue caching normally.
//
//   2. AUDITING — a user wants to compare token cost with and without
//      caching for the same workload. Setting `OPENCODE_DISABLE_CACHING=1`
//      globally disables caching across all providers + models for the
//      duration of the session.
//
//   3. PROXY DEBUGGING — when debugging why qpilot/qgenie isn't caching,
//      a per-model disable lets you isolate whether the problem is
//      model-specific or systemic.
//
// THE NAMING CONVENTION:
//
//   `OPENCODE_DISABLE_CACHING`                  → global kill switch
//   `OPENCODE_DISABLE_CACHING_<NORMALIZED_ID>`  → per-model kill switch
//
// The model id is normalized to env-var-safe form by:
//   - uppercasing
//   - replacing every char that isn't [A-Z0-9_] with `_`
//   - collapsing consecutive underscores into a single underscore
//   - stripping leading/trailing underscores
//
// Example: a model id is uppercased and punctuation becomes underscores.
// MATCHING SEMANTICS:
//
// `isDisabled(model)` checks BOTH the providerID-prefixed and bare
// model-id forms, so users can disable a model regardless of which
// proxy routes to it:
//
//   a provider/model pair matches global, provider+id, id-only, and provider-only flags.
//
// All 4 variants are checked for max ergonomic flexibility.
//
// THE HELPERS ARE PURE — they read env vars on every call (NOT cached
// at module load). This matches the Flag namespace's dynamic-getter
// pattern from gap-test-coverage-20 and lets tests + runtime overrides
// take effect without restarting opencode.

export namespace CacheFlags {
  /**
   * Normalize a model id to an env-var-safe suffix.
   *
   * Punctuation becomes underscores and empty input stays empty.
   */
  export function normalize(id: string): string {
    if (!id) return ""
    return id
      .toUpperCase()
      .replace(/[^A-Z0-9_]+/g, "_") // any non-safe char → underscore
      .replace(/_+/g, "_") // collapse runs of underscores
      .replace(/^_+|_+$/g, "") // strip leading/trailing underscores
  }

  /**
   * Check whether a single env-var name is set to a truthy value.
   * Mirrors the truthy() helper in flag/flag.ts: only literal "true"
   * or "1" (case-insensitive) count as truthy. Empty / unset / any
   * other value returns false.
   */
  function envTruthy(name: string): boolean {
    const v = process.env[name]?.toLowerCase()
    return v === "true" || v === "1"
  }

  /**
   * Returns true iff prompt caching should be DISABLED for this model.
   * Checks 4 env var shapes (global + 3 model-id variants):
   *
   *   OPENCODE_DISABLE_CACHING                       → global
   *   OPENCODE_DISABLE_CACHING_<PROVIDER>            → all models on a provider
   *   OPENCODE_DISABLE_CACHING_<NORMALIZED_API_ID>   → bare model id
   *   OPENCODE_DISABLE_CACHING_<PROVIDER>_<API_ID>   → provider-prefixed
   *
   * Any one of the 4 being truthy disables caching. Default behavior
   * (none set) is caching ENABLED — same as Claude Code.
   */
  export function isDisabled(model: { providerID: string; api: { id: string } }): boolean {
    // Global kill switch — cheapest check first
    if (envTruthy("OPENCODE_DISABLE_CACHING")) return true

    const providerSlug = normalize(model.providerID)
    const idSlug = normalize(model.api.id)

    // Provider-only kill switch
    if (providerSlug && envTruthy(`OPENCODE_DISABLE_CACHING_${providerSlug}`)) return true

    // Bare-id kill switch
    if (idSlug && envTruthy(`OPENCODE_DISABLE_CACHING_${idSlug}`)) return true

    // Provider+id combo kill switch (most specific)
    if (providerSlug && idSlug && envTruthy(`OPENCODE_DISABLE_CACHING_${providerSlug}_${idSlug}`)) return true

    return false
  }

  /**
   * Returns the list of env var names this helper checks for the given
   * model. Useful for debug commands + error messages — surfaces ALL
   * the variants a user might set without making them guess.
   */
  export function envVarNames(model: { providerID: string; api: { id: string } }): readonly string[] {
    const out: string[] = ["OPENCODE_DISABLE_CACHING"]
    const providerSlug = normalize(model.providerID)
    const idSlug = normalize(model.api.id)
    if (providerSlug) out.push(`OPENCODE_DISABLE_CACHING_${providerSlug}`)
    if (idSlug) out.push(`OPENCODE_DISABLE_CACHING_${idSlug}`)
    if (providerSlug && idSlug) out.push(`OPENCODE_DISABLE_CACHING_${providerSlug}_${idSlug}`)
    return out
  }
}
