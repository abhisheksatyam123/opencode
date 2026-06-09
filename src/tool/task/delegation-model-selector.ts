import { Config } from "@/config/config"
import {
  DelegationHealthState,
  resolveDelegationEndpoint,
  type DelegationHealthStats,
} from "@/provider/delegation-health-state"
import { ModelID, ProviderID } from "@/provider/schema"
import {
  DelegationModelPreferenceRules,
  DelegationModelSelectionContract,
} from "@/tool/task/contract/delegation-model-selection"

type ConfigSnapshot = Awaited<ReturnType<typeof Config.get>>
export type DelegationTaskModel = { providerID: ProviderID; modelID: ModelID }

type ModelHealth = {
  calls: number
  failureRate: number
  meanLatencyMs: number
  cooling: boolean
  rateLimitFailures?: number
  lastRateLimitedAt?: number
  consecutiveRateLimits?: number
  rateLimitedCooling?: boolean
}

const DEFAULT_COOLDOWN_MS = 60_000
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = DelegationModelSelectionContract.rateLimitMemory.defaultCooldownMs
const DEFAULT_MIN_SAMPLES = 5

function keyOf(model: DelegationTaskModel, endpoint: string): string {
  return `${endpoint}|${model.providerID}|${model.modelID}`
}

function tierScore(tier?: string): number {
  if (tier === "tier0") return 3
  if (tier === "tier1") return 2
  if (tier === "tier2") return 1
  return 0
}

function capabilityScore(capabilities: unknown): number {
  if (!capabilities || typeof capabilities !== "object") return 0
  const values = Object.values(capabilities as Record<string, unknown>).filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  )
  if (values.length === 0) return 0
  return values.reduce((acc, v) => acc + v, 0) / values.length
}

function preferenceBonus(providerID: string, modelID: string): number {
  const id = modelID.toLowerCase()
  const provider = providerID.toLowerCase()
  for (const rule of DelegationModelPreferenceRules) {
    const matchProvider = !rule.providerID || provider === rule.providerID
    if (matchProvider && id.includes(rule.modelContains.toLowerCase())) {
      return rule.bonus
    }
  }
  return 0
}

type AgentCapabilityRequirement = {
  thresholds?: Record<string, number>
  weight?: Record<string, number>
}

function agentCapabilityRequirement(cfg: ConfigSnapshot, agentName?: string): AgentCapabilityRequirement | undefined {
  if (!agentName) return undefined
  return cfg.agent_capability_requirements?.[agentName] as AgentCapabilityRequirement | undefined
}

function weightedCapabilityScore(
  capabilities: Record<string, number> | undefined,
  requirement: AgentCapabilityRequirement | undefined,
): number {
  if (!capabilities) return 0
  const weights = requirement?.weight ?? {}
  const weightedEntries = Object.entries(weights).filter(([, weight]) => Number.isFinite(weight) && weight !== 0)
  if (weightedEntries.length === 0) return capabilityScore(capabilities)

  let weighted = 0
  let totalWeight = 0
  for (const [name, weight] of weightedEntries) {
    const value = capabilities[name]
    if (typeof value !== "number" || !Number.isFinite(value)) continue
    weighted += value * weight
    totalWeight += Math.abs(weight)
  }
  return totalWeight > 0 ? weighted / totalWeight : 0
}

function thresholdMissPenalty(
  capabilities: Record<string, number> | undefined,
  requirement: AgentCapabilityRequirement | undefined,
): number {
  const thresholds = requirement?.thresholds
  if (!thresholds) return 0
  let penalty = 0
  for (const [name, min] of Object.entries(thresholds)) {
    if (!Number.isFinite(min)) continue
    const value = capabilities?.[name] ?? 0
    if (value < min) penalty += (min - value) * 5_000
  }
  return penalty
}

function buildHealthIndex(
  index: Record<string, DelegationHealthStats>,
  nowMs: number,
  cooldownMs: number,
  rateLimitCooldownMs: number,
) {
  const out: Record<string, ModelHealth> = {}
  for (const [k, stats] of Object.entries(index)) {
    const latestEventWasFailure = stats.lastFailureAt > 0 && stats.lastFailureAt >= stats.lastSuccessAt
    const cooling = latestEventWasFailure && nowMs - stats.lastFailureAt < cooldownMs
    const rateLimitedCooling = stats.lastRateLimitedAt > 0 && nowMs - stats.lastRateLimitedAt < rateLimitCooldownMs
    out[k] = {
      calls: stats.calls,
      failureRate: stats.failureRate,
      meanLatencyMs: stats.meanLatencyMs,
      cooling,
      rateLimitFailures: stats.rateLimitFailures,
      lastRateLimitedAt: stats.lastRateLimitedAt,
      consecutiveRateLimits: stats.consecutiveRateLimits,
      rateLimitedCooling,
    }
  }
  return out
}

async function loadHealth(
  nowMs: number,
  cooldownMs: number,
  rateLimitCooldownMs: number,
): Promise<Record<string, ModelHealth>> {
  const index = await DelegationHealthState.snapshot().catch(() => ({}))
  return buildHealthIndex(index, nowMs, cooldownMs, rateLimitCooldownMs)
}

export namespace DelegationModelSelector {
  export type RankInput = {
    candidates: DelegationTaskModel[]
    config?: ConfigSnapshot
    health?: Record<string, ModelHealth>
    nowMs?: number
    /** Agent whose leaf capability requirements should drive model fit. */
    agentName?: string
  }

  export async function rank(input: RankInput): Promise<DelegationTaskModel[]> {
    if (!input.candidates || input.candidates.length <= 1) return [...(input.candidates ?? [])]

    const cfg = input.config ?? (await Config.get())
    const nowMs = input.nowMs ?? Date.now()
    const cooldownMs = cfg.model_routing?.cooldown_ms ?? DEFAULT_COOLDOWN_MS
    const routing = cfg.model_routing as { rate_limit_cooldown_ms?: number } | undefined
    const rateLimitCooldownMs = routing?.rate_limit_cooldown_ms ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS
    const minSamples = cfg.model_routing?.min_samples ?? DEFAULT_MIN_SAMPLES
    const health = input.health ?? (await loadHealth(nowMs, cooldownMs, rateLimitCooldownMs))
    const requirement = agentCapabilityRequirement(cfg, input.agentName)

    const scored = input.candidates.map((candidate, index) => {
      const modelCfg = (cfg.provider?.[candidate.providerID]?.models?.[candidate.modelID] ??
        undefined) as
        | {
            tier?: string
            capabilities?: Record<string, number>
          }
        | undefined

      const endpoint = resolveDelegationEndpoint({
        providerID: String(candidate.providerID),
        modelID: String(candidate.modelID),
        config: cfg,
      })
      const key = keyOf(candidate, endpoint)
      const h = health[key]
      const enoughSamples = (h?.calls ?? 0) >= minSamples

      const scoreTier = tierScore(modelCfg?.tier) * 1000
      const scoreCapability = weightedCapabilityScore(modelCfg?.capabilities, requirement) * 500
      const scorePreference = preferenceBonus(String(candidate.providerID), String(candidate.modelID))

      const failurePenalty = enoughSamples ? (h?.failureRate ?? 0) * 50 : 0
      const latencyPenalty = enoughSamples ? (h?.meanLatencyMs ?? 0) * 0.001 : 0
      const cooldownPenalty = h?.cooling ? 10_000 : 0
      // Rate-limit memory should dominate model choice until cooldown expires.
      const rateLimitCooldownPenalty = h?.rateLimitedCooling ? 50_000 : 0
      const rateLimitRatio = (h?.calls ?? 0) > 0 ? (h?.rateLimitFailures ?? 0) / (h?.calls ?? 1) : 0
      const rateLimitHistoryPenalty = enoughSamples ? rateLimitRatio * 400 : 0
      const rateLimitStreakPenalty = (h?.consecutiveRateLimits ?? 0) * 200
      const capabilityThresholdPenalty = thresholdMissPenalty(modelCfg?.capabilities, requirement)

      const score =
        scoreTier +
        scoreCapability +
        scorePreference -
        failurePenalty -
        latencyPenalty -
        cooldownPenalty -
        rateLimitCooldownPenalty -
        rateLimitHistoryPenalty -
        rateLimitStreakPenalty -
        capabilityThresholdPenalty -
        index * 0.001
      return { candidate, index, score }
    })

    scored.sort((a, b) => b.score - a.score || a.index - b.index)
    return scored.map((x) => x.candidate)
  }
}
