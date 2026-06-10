// provider/model-router.ts
//
// ModelRouter — runtime service for model selection, usage recording, and
// score/rank logic.
//
// DESIGN
// ======
// The router is a pure-function service (no Effect layer, no singleton state
// beyond the persisted JSON file managed by ModelRouterState). Call sites
// that need model selection call `ModelRouter.select(...)` to get a ranked
// list of candidate model strings, then resolve each via `Provider.getModel`.
//
// SELECTION ALGORITHM
// ===================
// 1. Collect the candidate list from config:
//    Priority 1 — SelectOptions.agentTier (from agent card frontmatter, mapped "0"→"tier0" etc.)
//                 → scan provider model tier registry:
//                   cfg.provider[providerID].models[modelID].tier === tier
//    Deduplication preserves first occurrence.
// 2. Score each candidate using `scoreModel(positionIndex, stats)`:
//    - Base score = position weight (higher = earlier in config list)
//    - Penalty = failureRate * FAILURE_PENALTY_WEIGHT
//    - Bonus = -meanLatencyMs * LATENCY_BONUS_WEIGHT (lower latency = higher score)
//    Models with no recorded stats get a neutral score (no penalty/bonus).
// 3. Sort by score descending. Ties preserve config order.
// 4. Return the sorted list as `{ providerID, modelID }[]`.
//
// RECORDING
// =========
// After each LLM call, the caller records the outcome via
// `ModelRouter.record(modelKey, success, latencyMs)`. This appends one
// ModelUsageRecord to the local JSON state file.
//
// SNAPSHOT
// ========
// `ModelRouter.snapshot()` returns the current aggregated stats from the
// state file. Useful for debug commands and the TUI model picker.
//
// CALL SITES
// ==========
// - `provider/provider.ts` — tier-0 default model resolution
// - `session/processor.ts` — outcome recording (success/failure + latency)

import { Config } from "@/config/config"
import { Log } from "@/foundation/util/log"
import { ProviderID, ModelID } from "@/provider/schema"
import { ModelRouterState, type ModelStats } from "@/provider/model-router-state"

const log = Log.create({ service: "model-router" })

// ---------------------------------------------------------------------------
// Scoring weights (tunable constants)
// ---------------------------------------------------------------------------

/**
 * Score penalty per unit of failure rate (0–1).
 * A model with 100% failure rate loses this many score points.
 */
const FAILURE_PENALTY_WEIGHT = 30
const RECENT_FAILURE_PENALTY_WEIGHT = 80
const CONSECUTIVE_FAILURE_PENALTY_WEIGHT = 50

/**
 * Score penalty per millisecond of mean latency.
 * A model with 1000 ms mean latency loses 1000 * LATENCY_BONUS_WEIGHT points.
 * Kept small so latency is a tiebreaker, not a dominant signal.
 */
const LATENCY_BONUS_WEIGHT = 0.001
const TTFT_PENALTY_WEIGHT = 0.002

/**
 * Score assigned to the first model in the config list.
 * Each subsequent model gets POSITION_BASE - index * POSITION_STEP.
 */
const POSITION_BASE = 100
const POSITION_STEP = 10

/** Score deduction applied when a model serves a request whose tier is below the model's native tier. */
const OFF_TIER_PENALTY = 25

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModelCandidate {
  /** "providerID/modelID" composite string */
  model: string
  providerID: ProviderID
  modelID: ModelID
  /** Computed score — higher is preferred */
  score: number
  /** True when the model's configured tier matches the requested tier exactly; false when serving via supertier fallback */
  nativeTier: boolean
}

export interface SelectOptions {
  /**
   * Agent name as it appears in config — any local prompt-card agent name
   * (registry is open; see src/agent/prompt-loader.ts). Used to look up
   * `agent.<name>.model_tier`, `agent.<name>.model`, and `agent.<name>.models`.
   */
  agentName?: string
  /**
   * Agent capability tier, sourced from the agent card's `tier` frontmatter
   * (mapped "0"→"tier0", "1"→"tier1", "2"→"tier2"). When present, the router
   * scans `cfg.provider[providerID].models[modelID].tier` for matching models.
   * Takes precedence over `agent.<name>.model_tier` in config.
   */
  agentTier?: "tier0" | "tier1" | "tier2"
  /** Estimated context demand in tokens for capability-based routing. */
  ctxSizeEstimate?: number
  /**
   * Pre-loaded config snapshot. When omitted, `Config.get()` is called.
   * Pass this in hot paths to avoid redundant config reads.
   */
  config?: Awaited<ReturnType<typeof Config.get>>
  /**
   * Pre-loaded stats snapshot. When omitted, `ModelRouterState.snapshot()`
   * is called. Pass this in hot paths to avoid redundant disk reads.
   */
  stats?: Record<string, ModelStats>
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseModelKey(model: string): { providerID: ProviderID; modelID: ModelID } | null {
  const slash = model.indexOf("/")
  if (slash < 1 || slash === model.length - 1) return null
  return {
    providerID: ProviderID.make(model.slice(0, slash)),
    modelID: ModelID.make(model.slice(slash + 1)),
  }
}

function policyDenied(cfg: Awaited<ReturnType<typeof Config.get>>, providerID: string, modelID: string): boolean {
  const denied = cfg.model_routing?.policy_denied ?? []
  return denied.includes(`${providerID}/${modelID}`) || denied.includes(`${providerID}::${modelID}`)
}

function enabledProviders(cfg: Awaited<ReturnType<typeof Config.get>>): string[] | undefined {
  return cfg.model_routing?.enabled_providers ?? cfg.enabled_providers
}

function candidateAllowed(cfg: Awaited<ReturnType<typeof Config.get>>, providerID: string, modelID: string): boolean {
  const enabled = enabledProviders(cfg)
  if (enabled && !enabled.includes(providerID)) return false
  if (policyDenied(cfg, providerID, modelID)) return false
  const modelCfg = (cfg.provider?.[providerID]?.models?.[modelID] ?? {}) as { enabled?: boolean }
  if (modelCfg.enabled === false) return false
  return true
}

/**
 * Compute a numeric score for a model given its position in the config list
 * and its historical stats.
 *
 * Higher score = more preferred.
 *
 * @param positionIndex 0-based index in the config-ordered candidate list
 * @param stats         Aggregated stats for this model (undefined = no history)
 */
export function scoreModel(
  positionIndex: number,
  stats: ModelStats | undefined,
  tierMatch: "native" | "supertier" = "native",
): number {
  const positionScore = POSITION_BASE - positionIndex * POSITION_STEP
  const offTierPenalty = tierMatch === "supertier" ? OFF_TIER_PENALTY : 0
  if (!stats || stats.calls === 0) return positionScore - offTierPenalty

  const overallFailurePenalty = stats.failureRate * FAILURE_PENALTY_WEIGHT
  const recentFailurePenalty = (stats.recentFailureRate ?? stats.failureRate) * RECENT_FAILURE_PENALTY_WEIGHT
  const consecutiveFailurePenalty = (stats.consecutiveErrors ?? 0) * CONSECUTIVE_FAILURE_PENALTY_WEIGHT

  const latencyPenalty = stats.meanLatencyMs * LATENCY_BONUS_WEIGHT
  const ttftPenalty = (stats.meanTtftMs ?? stats.meanLatencyMs * 0.3) * TTFT_PENALTY_WEIGHT

  return (
    positionScore -
    overallFailurePenalty -
    recentFailurePenalty -
    consecutiveFailurePenalty -
    latencyPenalty -
    ttftPenalty -
    offTierPenalty
  )
}

/**
 * Collect the ordered candidate model strings from config for a given agent.
 * Deduplication preserves first occurrence.
 *
 * Tier resolution (highest precedence first):
 *   1. agentTier passed via SelectOptions (from agent card frontmatter) — selects
 *      from the provider model tier registry: cfg.provider[providerID].models[modelID].tier
 */
function collectCandidates(
  agentName: string | undefined,
  cfg: Awaited<ReturnType<typeof Config.get>>,
  agentTierOpt?: "tier0" | "tier1" | "tier2",
): { model: string; nativeTier: boolean }[] {
  const seen = new Set<string>()
  const out: { model: string; nativeTier: boolean }[] = []

  function push(m: string | undefined, native: boolean) {
    if (!m || seen.has(m)) return
    const parsed = parseModelKey(m)
    if (!parsed) return
    if (!candidateAllowed(cfg, parsed.providerID, parsed.modelID)) return
    seen.add(m)
    out.push({ model: m, nativeTier: native })
  }

  // Tier-based selection from provider model tier registry (highest precedence):
  // Priority 1: agentTier passed directly via SelectOptions (from agent card frontmatter)
  const tier = agentTierOpt

  if (tier === "tier0" || tier === "tier1" || tier === "tier2") {
    // Build hierarchy: tier0→[tier0]; tier1→[tier1,tier0]; tier2→[tier2,tier1,tier0]
    const hierarchy: ("tier0" | "tier1" | "tier2")[] =
      tier === "tier0" ? ["tier0"] : tier === "tier1" ? ["tier1", "tier0"] : ["tier2", "tier1", "tier0"]

    const providerMap = cfg.provider ?? {}
    for (const scanTier of hierarchy) {
      const isNative = scanTier === tier
      for (const [providerID, providerCfg] of Object.entries(providerMap)) {
        const modelMap = (providerCfg as { models?: Record<string, unknown> }).models ?? {}
        for (const [modelID, modelCfg] of Object.entries(modelMap)) {
          if ((modelCfg as { tier?: string }).tier === scanTier && candidateAllowed(cfg, providerID, modelID)) {
            push(`${providerID}/${modelID}`, isNative)
          }
        }
      }
    }

    if (out.length > 0) {
      return out
    }
  }

  return out
}

function tierRank(tier: string | undefined): number {
  return tier === "tier0" ? 0 : tier === "tier1" ? 1 : 2
}

/**
 * Capability-driven resolver branch per `project/software/opencode/module/model-routing-config#Resolver algorithm (capability-driven)`.
 */
function collectCandidatesByCapability(
  agentName: string | undefined,
  cfg: Awaited<ReturnType<typeof Config.get>>,
  ctxSizeEstimate?: number,
): { model: string; nativeTier: boolean; score: number }[] {
  const req = agentName ? cfg.agent_capability_requirements?.[agentName] : undefined
  const tierFloor = agentName ? cfg.model_routing?.tier_floor?.[agentName] : undefined
  const enabled = enabledProviders(cfg)
  const weightsBase = req?.weight ?? {}
  const weights = { ...weightsBase }

  if (
    ctxSizeEstimate !== undefined &&
    cfg.model_routing?.context_overrides?.huge_context_threshold_tokens !== undefined &&
    ctxSizeEstimate > cfg.model_routing.context_overrides.huge_context_threshold_tokens
  ) {
    weights.long_context = (weights.long_context ?? 0) + 5
  }

  const scored: { model: string; nativeTier: boolean; score: number; providerID: string }[] = []
  for (const [providerID, providerCfg] of Object.entries(cfg.provider ?? {})) {
    if (enabled && !enabled.includes(providerID)) continue
    for (const [modelID, modelCfgRaw] of Object.entries(providerCfg.models ?? {})) {
      if (!candidateAllowed(cfg, providerID, modelID)) continue
      const model = `${providerID}/${modelID}`

      const modelCfg = modelCfgRaw as {
        tier?: string
        capabilities?: Record<string, number>
        context_tokens?: number
        enabled?: boolean
      }

      if (tierFloor && tierRank(modelCfg.tier) > tierRank(tierFloor)) continue
      if (
        ctxSizeEstimate !== undefined &&
        modelCfg.context_tokens !== undefined &&
        modelCfg.context_tokens < ctxSizeEstimate
      )
        continue
      if (
        req?.thresholds &&
        !Object.entries(req.thresholds).every(([k, min]) => (modelCfg.capabilities?.[k] ?? 0) >= min)
      )
        continue

      let weightedScore = 0
      for (const [k, weight] of Object.entries(weights)) {
        weightedScore += (modelCfg.capabilities?.[k] ?? 0) * weight
      }
      const healthFactor = 1.0 // Known limitation: runtime health factor not yet wired; always 1.0
      // Tier bonus is a small tiebreaker only; tier reservation is enforced
      // earlier via `tier_floor`. Magnitude kept low so specialty capability
      // signals (e.g. terminal_agentic for investigation) can win across tier rows.
      const tierBonus = (2 - tierRank(modelCfg.tier)) * 0.01
      const score = weightedScore * healthFactor * (1 + tierBonus)
      scored.push({ model, nativeTier: true, score, providerID })
    }
  }

  scored.sort((a, b) => b.score - a.score)
  const topN = cfg.model_routing?.fallback_chain_length ?? 3
  const limited = scored.slice(0, topN)

  if (cfg.model_routing?.cross_provider_rotation === true && limited.length > 1) {
    const rotated = [limited[0]!]
    const remaining = limited.slice(1)
    while (remaining.length > 0) {
      const previousProviderID = rotated[rotated.length - 1]!.providerID
      const nextIndex = remaining.findIndex((entry) => entry.providerID !== previousProviderID)
      rotated.push(remaining.splice(nextIndex >= 0 ? nextIndex : 0, 1)[0]!)
    }
    return rotated.map(({ model, nativeTier, score }) => ({ model, nativeTier, score }))
  }

  return limited.map(({ model, nativeTier, score }) => ({ model, nativeTier, score }))
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export namespace ModelRouter {
  /**
   * Select and rank model candidates for a given agent + config.
   *
   * Returns a list of `ModelCandidate` sorted by score descending.
   * The list may be empty if no model is configured.
   *
   * @example
   * ```ts
   * const candidates = await ModelRouter.select({ agentName: "build" })
   * if (candidates.length === 0) throw new Error("no model configured")
   * const primary = candidates[0]
   * const model = await Provider.getModel(primary.providerID, primary.modelID)
   * ```
   */
  export async function select(opts: SelectOptions = {}): Promise<ModelCandidate[]> {
    const cfg = opts.config ?? (await Config.get())
    const stats = opts.stats ?? (await ModelRouterState.snapshot())

    let rawCandidates: { model: string; nativeTier: boolean; score?: number }[]
    let capabilityMode = false

    if (cfg.model_routing?.enabled === true) {
      rawCandidates = collectCandidatesByCapability(opts.agentName, cfg, opts.ctxSizeEstimate)
      if (rawCandidates.length === 0) {
        log.warn("model-router.capability.empty", { agentName: opts.agentName ?? "(none)" })
        rawCandidates = collectCandidates(opts.agentName, cfg, opts.agentTier)
      } else {
        capabilityMode = true
      }
    } else {
      rawCandidates = collectCandidates(opts.agentName, cfg, opts.agentTier)
    }

    if (rawCandidates.length === 0) {
      log.info("model-router.select.empty", { agentName: opts.agentName ?? "(none)" })
      return []
    }

    const candidates: ModelCandidate[] = []
    for (let i = 0; i < rawCandidates.length; i++) {
      const { model, nativeTier, score: capabilityScore } = rawCandidates[i]!
      const parsed = parseModelKey(model)
      if (!parsed) {
        log.warn("model-router.select.unparseable", { model })
        continue
      }
      const tierMatch = nativeTier ? "native" : "supertier"
      const score = capabilityMode ? (capabilityScore ?? 0) : scoreModel(i, stats[model], tierMatch)
      candidates.push({ model, ...parsed, score, nativeTier: capabilityMode ? true : nativeTier })
    }

    if (!capabilityMode) {
      // Stable sort: higher score first; ties preserve config order (already stable in JS)
      candidates.sort((a, b) => b.score - a.score)
    }

    log.info("model-router.select.result", {
      agentName: opts.agentName ?? "(none)",
      count: candidates.length,
      top: candidates[0]?.model,
    })

    return candidates
  }

  /**
   * Record the outcome of one LLM call for a given model.
   *
   * @param model     "providerID/modelID" composite string
   * @param success   Whether the call succeeded (no error thrown)
   * @param latencyMs Wall-clock latency in milliseconds
   */
  export async function record(
    model: string,
    success: boolean,
    latencyMs: number,
    opts?: {
      ttftMs?: number
      errorCode?: string
      inputTokens?: number
      taskType?: string
    },
  ): Promise<void> {
    await ModelRouterState.append({
      model,
      at: new Date().toISOString(),
      success,
      latencyMs: Math.max(0, Math.round(latencyMs)),
      ...(opts?.ttftMs !== undefined ? { ttftMs: Math.max(0, Math.round(opts.ttftMs)) } : {}),
      ...(opts?.errorCode !== undefined ? { errorCode: opts.errorCode } : {}),
      ...(opts?.inputTokens !== undefined ? { inputTokens: opts.inputTokens } : {}),
      ...(opts?.taskType !== undefined ? { taskType: opts.taskType } : {}),
    })
  }

  /**
   * Return aggregated per-model stats from the local state file.
   * Keyed by "providerID/modelID" composite string.
   */
  export async function snapshot(): Promise<Record<string, ModelStats>> {
    return ModelRouterState.snapshot()
  }
}
