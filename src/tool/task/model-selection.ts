import { Config } from "@/config/config"
import { Log } from "@/foundation/util/log"
import type { MessageID, SessionID } from "@/foundation/identifier/session"
import { ModelID, ProviderID } from "@/provider/schema"
import { Provider } from "@/provider/provider"
import { ModelRouter } from "@/provider/model-router"
import { ToolSessionPort } from "@/tool/session-port"
import { DelegationModelSelector } from "@/tool/task/delegation-model-selector"

const log = Log.create({ service: "tool.task.model-selection" })

export type TaskConfigSnapshot = Awaited<ReturnType<typeof Config.get>>
export type TaskModelSource =
  | "override"
  | "override_list"
  | "agent_hint"
  | "resume"
  | "capability_router"
  | "auto"
  | "caller"
export type TaskModel = { providerID: ProviderID; modelID: ModelID }

// Delegation providers are config-derived only. opencode.json is the source of
// truth: model_routing.enabled_providers > enabled_providers > provider keys.
function allowedDelegationProviders(cfg?: TaskConfigSnapshot): Set<string> {
  try {
    const active = cfg ?? Config.getSync?.()
    const providers =
      active?.model_routing?.enabled_providers ?? active?.enabled_providers ?? Object.keys(active?.provider ?? {})
    return new Set((providers ?? []).filter((id): id is string => typeof id === "string" && id.length > 0))
  } catch {
    return new Set<string>()
  }
}

function assertDelegationProvider(providerID: string, context: string, cfg?: TaskConfigSnapshot): void {
  const allowed = allowedDelegationProviders(cfg)
  if (!allowed.has(providerID)) {
    const list = allowed.size > 0 ? [...allowed].join(", ") : "(none configured)"
    throw new Error(
      `Delegation rejected: provider "${providerID}" is not allowed for subagent dispatch (${context}). ` +
        `Allowed providers: ${list}. ` +
        `Configure eligible providers and models in opencode.json.`,
    )
  }
}

function filterToAllowedProviders(models: TaskModel[], cfg?: TaskConfigSnapshot): TaskModel[] {
  const allowed = allowedDelegationProviders(cfg)
  return models.filter((m) => allowed.has(m.providerID))
}

function delegationRegistryModelIDs(providerID: string, cfg?: TaskConfigSnapshot): string[] {
  const activeConfig =
    cfg ??
    (Config.getSync?.() as
      | {
          provider?: Record<string, { models?: Record<string, unknown> }>
        }
      | undefined)
  const models = activeConfig?.provider?.[providerID]?.models
  return models ? Object.keys(models).sort() : []
}

function delegationRegistryModels(providerIDs: Iterable<string>, cfg?: TaskConfigSnapshot): TaskModel[] {
  const out: TaskModel[] = []
  for (const providerID of providerIDs) {
    for (const modelID of delegationRegistryModelIDs(providerID, cfg)) {
      out.push({
        providerID: ProviderID.make(providerID),
        modelID: ModelID.make(modelID),
      })
    }
  }
  return out
}

function assertDelegationModelID(providerID: string, modelID: string, context: string, cfg?: TaskConfigSnapshot): void {
  const validModelIDs = delegationRegistryModelIDs(providerID, cfg)
  if (validModelIDs.length === 0) {
    throw new Error(
      `Delegation rejected: provider "${providerID}" has no registered models for subagent dispatch (${context}). ` +
        `Expected cfg.provider.${providerID}.models to define allowed model IDs in opencode.json.`,
    )
  }
  if (!validModelIDs.includes(modelID)) {
    throw new Error(
      `Delegation rejected: model "${providerID}/${modelID}" is not registered for subagent dispatch (${context}). ` +
        `Valid model IDs for "${providerID}": ${validModelIDs.join(", ")}.`,
    )
  }
}

function delegationPolicyDenied(providerID: string, modelID: string, cfg?: TaskConfigSnapshot): boolean {
  const denied = cfg?.model_routing?.policy_denied ?? []
  return denied.includes(`${providerID}/${modelID}`) || denied.includes(`${providerID}::${modelID}`)
}

function delegationModelProblem(model: TaskModel, cfg?: TaskConfigSnapshot): string | undefined {
  const providerID = String(model.providerID)
  const modelID = String(model.modelID)
  const allowed = allowedDelegationProviders(cfg)
  if (!allowed.has(providerID)) return `provider "${providerID}" is not allowed`
  const enabledProviders = cfg?.model_routing?.enabled_providers ?? cfg?.enabled_providers
  if (enabledProviders && !enabledProviders.includes(providerID))
    return `provider "${providerID}" is disabled by enabled_providers`
  const modelCfg = cfg?.provider?.[providerID]?.models?.[modelID] as { enabled?: boolean } | undefined
  if (!modelCfg) return `model "${providerID}/${modelID}" is not registered`
  if (delegationPolicyDenied(providerID, modelID, cfg)) return `model "${providerID}/${modelID}" is policy_denied`
  if (modelCfg.enabled === false) return `model "${providerID}/${modelID}" is disabled`
  return undefined
}

async function filterUsableDelegationModels(models: TaskModel[], cfg: TaskConfigSnapshot): Promise<TaskModel[]> {
  const out: TaskModel[] = []
  for (const model of models) {
    const problem = delegationModelProblem(model, cfg)
    if (problem) {
      log.warn("task.delegation.model.filtered", { model, reason: problem })
      continue
    }
    const ok = await Provider.getModel(model.providerID, model.modelID)
      .then(() => true)
      .catch((err) => {
        log.warn("task.delegation.model.unavailable", { model, error: (err as Error)?.message })
        return false
      })
    if (ok) out.push(model)
  }
  return out
}

function usableDelegationCandidates(cfg: TaskConfigSnapshot, limit = 8): string {
  const allowed = allowedDelegationProviders(cfg)
  const candidates = delegationRegistryModels(allowed, cfg).filter((m) => !delegationModelProblem(m, cfg))
  return candidates
    .slice(0, limit)
    .map((m) => `${m.providerID}/${m.modelID}`)
    .join(", ")
}

function normalizeModelOverride(input: string): string {
  const value = input.trim()
  if (value.includes("/")) return value
  const colon = value.indexOf(":")
  if (colon > 0 && colon < value.length - 1) return `${value.slice(0, colon)}/${value.slice(colon + 1)}`
  return value
}

export function parseTaskModelOverride(input: string, cfg?: TaskConfigSnapshot) {
  const model = normalizeModelOverride(input)
  const [providerID, ...rest] = model.split("/")
  if (!providerID || rest.length === 0 || !rest.join("/").trim()) {
    throw new Error(`Invalid model override: "${input}". Expected provider:model or provider/model format.`)
  }
  const parsed = Provider.parseModel(model)
  const context = `explicit model override "${input}"`
  assertDelegationProvider(parsed.providerID, context, cfg)
  assertDelegationModelID(parsed.providerID, parsed.modelID, context, cfg)
  const problem = delegationModelProblem(parsed, cfg)
  if (problem) {
    const candidates = cfg ? usableDelegationCandidates(cfg) : ""
    throw new Error(
      `Delegation rejected: model "${parsed.providerID}/${parsed.modelID}" is not usable for subagent dispatch (${context}): ${problem}.` +
        (candidates ? ` Usable candidates: ${candidates}.` : ""),
    )
  }
  return parsed
}

export function parseTaskModelHint(input: string, cfg: TaskConfigSnapshot): TaskModel | undefined {
  try {
    return parseTaskModelOverride(input, cfg)
  } catch (err) {
    log.warn("task.delegation.model-hint.filtered", { model: input, error: (err as Error)?.message })
    return undefined
  }
}

export async function resolveTaskModel(input: {
  requestedModel?: TaskModel
  requestedModels?: TaskModel[]
  agentModel?: TaskModel
  agentModels?: TaskModel[]
  resumedModel?: TaskModel
  parentSessionID: SessionID
  parentMessageID: MessageID
  config: TaskConfigSnapshot
  /** Agent name used for ModelRouter lookup when no explicit model is provided */
  subagentType?: string
}): Promise<{ model: TaskModel; models: TaskModel[]; source: TaskModelSource }> {
  if (input.requestedModel) {
    const usable = await filterUsableDelegationModels([input.requestedModel], input.config)
    if (usable.length === 0) {
      const candidates = usableDelegationCandidates(input.config)
      throw new Error(
        `Delegation rejected: requested model "${input.requestedModel.providerID}/${input.requestedModel.modelID}" is not usable for subagent dispatch.` +
          (candidates ? ` Usable candidates: ${candidates}.` : ""),
      )
    }
    return { model: usable[0]!, models: usable, source: "override" }
  }
  if (input.requestedModels && input.requestedModels.length > 0) {
    const cfg = input.config
    const allowed = filterToAllowedProviders(input.requestedModels, cfg)
    const pool = allowed.length > 0 ? allowed : input.requestedModels
    const ranked = await DelegationModelSelector.rank({ candidates: pool, config: cfg, agentName: input.subagentType })
    const selectionPool = ranked.length > 0 ? ranked : pool
    const available = await filterUsableDelegationModels(selectionPool, cfg)
    if (available.length === 0) {
      const candidates = usableDelegationCandidates(cfg)
      throw new Error(
        `Delegation rejected: none of the requested model candidates are usable for subagent dispatch.` +
          (candidates ? ` Usable candidates: ${candidates}.` : ""),
      )
    }
    const selected = available[0]!
    return {
      model: selected,
      models: available,
      source: "override_list",
    }
  }
  if (input.resumedModel) {
    const usable = await filterUsableDelegationModels([input.resumedModel], input.config)
    if (usable.length > 0) return { model: usable[0]!, models: usable, source: "resume" }
  }
  if (input.agentModel) {
    const dedup = new Set<string>([`${input.agentModel.providerID}/${input.agentModel.modelID}`])
    const sameProviderFallbacks = (input.agentModels ?? []).filter((m) => {
      if (m.providerID !== input.agentModel!.providerID) return false
      const key = `${m.providerID}/${m.modelID}`
      if (dedup.has(key)) return false
      dedup.add(key)
      return true
    })
    const ordered = [input.agentModel, ...sameProviderFallbacks]
    const available = await filterUsableDelegationModels(ordered, input.config)
    if (available.length > 0) {
      return {
        model: available[0]!,
        models: available,
        source: "agent_hint",
      }
    }
  }

  // Automatic delegation model selection:
  // Build one pool from model_routing candidates, agent hints, and all
  // registered models for providers declared in opencode.json.
  // Rank by capability + local endpoint/provider/model health.
  {
    const cfg = input.config
    const allowedProviders = allowedDelegationProviders(cfg)
    const agentHints: TaskModel[] = []
    if (input.agentModels && input.agentModels.length > 0) agentHints.push(...input.agentModels)

    // Precedence: explicit agent hints (agent.models / agent.model) should
    // anchor delegation selection. Only when those hints are absent do we
    // broaden to router + provider-registry discovery.
    const routerHints: TaskModel[] = []
    if (agentHints.length === 0 && input.subagentType && cfg.model_routing) {
      const routed = await ModelRouter.select({ agentName: input.subagentType, config: cfg })
      routerHints.push(...routed.map((c) => ({ providerID: c.providerID, modelID: c.modelID })))
    }

    const hints = agentHints.length > 0 ? agentHints : routerHints
    const hintsAllowed = filterToAllowedProviders(hints, cfg)
    const hintPool = hintsAllowed.length > 0 ? hintsAllowed : hints

    const registry = delegationRegistryModels(allowedProviders, cfg)
    const registryAllowed = filterToAllowedProviders(registry, cfg)
    const registryPool = registryAllowed.length > 0 ? registryAllowed : registry

    const pool = hintPool.length > 0 ? hintPool : registryPool

    const dedup = new Set<string>()
    const unique = pool.filter((m) => {
      const k = `${m.providerID}/${m.modelID}`
      if (dedup.has(k)) return false
      dedup.add(k)
      return true
    })

    if (unique.length > 0) {
      // Do NOT pre-filter the candidate pool by caller-provider affinity.
      // The user's registry order in agent.models / model_routing already
      // encodes provider preference. Pre-filtering to the caller provider
      // silently overrode that order when the parent session ran on a
      // different provider. Affinity is now a stable tiebreaker only: rank() already
      // applies `index * 0.001` so equal-score candidates respect input
      // order, and registry order is built parent-aware upstream.
      const ranked = await DelegationModelSelector.rank({
        candidates: unique,
        config: cfg,
        agentName: input.subagentType,
      })
      const selectionPool = ranked.length > 0 ? ranked : unique
      const available = await filterUsableDelegationModels(selectionPool, cfg)
      if (available.length > 0) {
        const selected = available[0]!
        return {
          model: selected,
          models: available,
          source: routerHints.length > 0 ? "capability_router" : "auto",
        }
      }
    }
  }

  // Caller fallback: inherit the parent session's model.
  // Enforce allowed providers — the caller may be running on any provider.
  const msg = await ToolSessionPort.messageGet({ sessionID: input.parentSessionID, messageID: input.parentMessageID })
  if (msg.info.role !== "assistant") throw new Error("Not an assistant message")

  const callerProviderID = msg.info.providerID

  const callerModel = {
    modelID: ModelID.make(msg.info.modelID),
    providerID: ProviderID.make(callerProviderID),
  }
  const usableCaller = await filterUsableDelegationModels([callerModel], input.config)
  if (usableCaller.length > 0) {
    return {
      model: usableCaller[0]!,
      models: usableCaller,
      source: "caller",
    }
  }
  const candidates = usableDelegationCandidates(input.config)
  throw new Error(
    `Delegation rejected: no usable model candidates for subagent dispatch.` +
      (candidates ? ` Usable candidates: ${candidates}.` : ""),
  )
}

export async function lastAssistantModel(sessionID: SessionID): Promise<TaskModel | undefined> {
  const page = ToolSessionPort.messagePage({ sessionID, limit: 100 })
  for (let i = page.items.length - 1; i >= 0; i--) {
    const info = page.items[i]?.info
    if (info?.role !== "assistant") continue
    if (!info.providerID || !info.modelID) continue
    return {
      providerID: ProviderID.make(info.providerID),
      modelID: ModelID.make(info.modelID),
    }
  }
  return undefined
}
