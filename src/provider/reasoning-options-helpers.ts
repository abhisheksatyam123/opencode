import type { Provider } from "@/provider/provider"
import { CacheFlags } from "@/provider/cache-flags"
import * as Upstream from "@/provider/upstream"
import { isQualcommOpenAIResponsesRoute, qualcommRoute } from "@/provider/request-shaping-helpers"

export const WIDELY_SUPPORTED_EFFORTS = ["low", "medium", "high"]
export const OPENAI_EFFORTS = ["none", "minimal", ...WIDELY_SUPPORTED_EFFORTS, "xhigh"]

const ADAPTIVE_ANTHROPIC_IDS = ["opus-4-6", "opus-4.6", "sonnet-4-6", "sonnet-4.6", "claude-4-6", "claude-4.6"]
const ADAPTIVE_EFFORTS = ["low", "medium", "high", "max"]
const REASONING_EXCLUDED_MODEL_PARTS = ["deepseek", "minimax", "glm", "mistral", "kimi", "k2p5", "qwen"]
const REASONING_EFFORT_PROVIDERS = new Set([
  "@ai-sdk/cerebras",
  "@ai-sdk/togetherai",
  "@ai-sdk/xai",
  "@ai-sdk/deepinfra",
  "venice-ai-sdk-provider",
  "@ai-sdk/openai-compatible",
])

type ReasoningVariants = Record<string, Record<string, any>>

function effortVariants(efforts: readonly string[], build: (effort: string) => Record<string, any>): ReasoningVariants {
  return Object.fromEntries(efforts.map((effort) => [effort, build(effort)]))
}

function reasoningEffortVariants(efforts: readonly string[]): ReasoningVariants {
  return effortVariants(efforts, (effort) => ({ reasoningEffort: effort }))
}

function encryptedReasoningEffortVariants(efforts: readonly string[]): ReasoningVariants {
  return effortVariants(efforts, (effort) => ({
    reasoningEffort: effort,
    reasoningSummary: "auto",
    include: ["reasoning.encrypted_content"],
  }))
}

function openRouterReasoningVariants(efforts: readonly string[]): ReasoningVariants {
  return effortVariants(efforts, (effort) => ({ reasoning: { effort } }))
}

function adaptiveThinkingVariants(includeXhigh = false): ReasoningVariants {
  const entries: [string, Record<string, any>][] = [
    ["off", { thinking: { type: "disabled" } }],
    ...ADAPTIVE_EFFORTS.map((effort): [string, Record<string, any>] => [
      effort,
      {
        thinking: {
          type: "adaptive",
        },
        effort,
      },
    ]),
  ]
  if (includeXhigh) {
    entries.push([
      "xhigh",
      {
        thinking: {
          type: "adaptive",
        },
        effort: "max",
      },
    ])
  }
  return Object.fromEntries(entries)
}

function enabledThinkingVariants(highBudget: number, maxBudget: number, includeXhigh = false): ReasoningVariants {
  const variants: ReasoningVariants = {
    off: {
      thinking: {
        type: "disabled",
      },
    },
    high: {
      thinking: {
        type: "enabled",
        budgetTokens: highBudget,
      },
    },
    max: {
      thinking: {
        type: "enabled",
        budgetTokens: maxBudget,
      },
    },
  }
  if (includeXhigh) {
    variants.xhigh = {
      thinking: {
        type: "enabled",
        budgetTokens: maxBudget,
      },
    }
  }
  return variants
}

function anthropicThinkingVariants(
  model: Provider.Model,
  isAdaptive: boolean,
  includeXhigh = false,
): ReasoningVariants {
  if (isAdaptive) return adaptiveThinkingVariants(includeXhigh)
  return enabledThinkingVariants(
    Math.min(16_000, Math.floor(model.limit.output / 2 - 1)),
    Math.min(31_999, model.limit.output - 1),
    includeXhigh,
  )
}

function adaptiveReasoningConfigVariants(): ReasoningVariants {
  return Object.fromEntries([
    ["off", { reasoningConfig: { type: "disabled" } }],
    ...ADAPTIVE_EFFORTS.map((effort) => [
      effort,
      {
        reasoningConfig: {
          type: "adaptive",
          maxReasoningEffort: effort,
        },
      },
    ]),
  ])
}

function enabledReasoningConfigVariants(): ReasoningVariants {
  return {
    off: {
      reasoningConfig: {
        type: "disabled",
      },
    },
    high: {
      reasoningConfig: {
        type: "enabled",
        budgetTokens: 16000,
      },
    },
    max: {
      reasoningConfig: {
        type: "enabled",
        budgetTokens: 31999,
      },
    },
  }
}

function novaReasoningConfigVariants(): ReasoningVariants {
  return effortVariants(WIDELY_SUPPORTED_EFFORTS, (effort) => ({
    reasoningConfig: {
      type: "enabled",
      maxReasoningEffort: effort,
    },
  }))
}

function geminiBudgetVariants(): ReasoningVariants {
  return {
    high: {
      thinkingConfig: {
        includeThoughts: true,
        thinkingBudget: 16000,
      },
    },
    max: {
      thinkingConfig: {
        includeThoughts: true,
        thinkingBudget: 24576,
      },
    },
  }
}

function geminiLevelVariants(levels: readonly string[]): ReasoningVariants {
  return effortVariants(levels, (effort) => ({
    thinkingConfig: {
      includeThoughts: true,
      thinkingLevel: effort,
    },
  }))
}

function gatewayGeminiLevelVariants(levels: readonly string[]): ReasoningVariants {
  return effortVariants(levels, (effort) => ({
    includeThoughts: true,
    thinkingLevel: effort,
  }))
}

function grokReasoningVariants(id: string, model: Provider.Model): ReasoningVariants | undefined {
  if (!id.includes("grok")) return undefined
  if (!id.includes("grok-3-mini")) return {}
  if (model.api.npm === "@openrouter/ai-sdk-provider") {
    return {
      low: { reasoning: { effort: "low" } },
      high: { reasoning: { effort: "high" } },
    }
  }
  return {
    low: { reasoningEffort: "low" },
    high: { reasoningEffort: "high" },
  }
}

function qualcommReasoningVariants(
  model: Provider.Model,
  apiID: string,
  isAnthropicAdaptive: boolean,
): ReasoningVariants {
  const route = qualcommRoute(model)
  if (route === "anthropic") return anthropicThinkingVariants(model, isAnthropicAdaptive, true)
  if (route === "openai-responses") return reasoningEffortVariants(OPENAI_EFFORTS)
  if (route === "openai-chat" && apiID.includes("gemini")) {
    // Gemini OpenAI compatibility maps reasoning_effort to Gemini thinking levels.
    // Public docs list minimal/low/medium/high for Gemini 3.x; do not emit
    // OpenAI-only `xhigh` here because Gemini proxies may reject it.
    return reasoningEffortVariants(["minimal", ...WIDELY_SUPPORTED_EFFORTS])
  }
  return {}
}

function gatewayReasoningVariants(model: Provider.Model, id: string, isAnthropicAdaptive: boolean): ReasoningVariants {
  if (model.id.includes("anthropic")) {
    if (isAnthropicAdaptive) return adaptiveThinkingVariants()
    return enabledThinkingVariants(16000, 31999)
  }
  if (model.id.includes("google")) {
    if (id.includes("2.5")) return geminiBudgetVariants()
    return gatewayGeminiLevelVariants(["low", "high"])
  }
  return reasoningEffortVariants(OPENAI_EFFORTS)
}

function copilotReasoningVariants(model: Provider.Model, id: string): ReasoningVariants {
  if (model.id.includes("gemini")) return {}
  if (model.id.includes("claude")) return reasoningEffortVariants(WIDELY_SUPPORTED_EFFORTS)

  const efforts = [...WIDELY_SUPPORTED_EFFORTS]
  if (id.includes("5.1-codex-max") || id.includes("5.2") || id.includes("5.3")) efforts.push("xhigh")
  else if (id.includes("gpt-5") && model.release_date >= "2025-12-04") efforts.push("xhigh")
  return encryptedReasoningEffortVariants(efforts)
}

function azureReasoningVariants(id: string): ReasoningVariants {
  if (id === "o1-mini") return {}
  const efforts = ["low", "medium", "high"]
  if (id.includes("gpt-5-") || id === "gpt-5") efforts.unshift("minimal")
  return encryptedReasoningEffortVariants(efforts)
}

function openAIReasoningVariants(model: Provider.Model, id: string): ReasoningVariants {
  if (id === "gpt-5-pro") return {}
  if (id.includes("codex")) {
    const codexEfforts =
      id.includes("5.2") || id.includes("5.3") ? [...WIDELY_SUPPORTED_EFFORTS, "xhigh"] : WIDELY_SUPPORTED_EFFORTS
    return encryptedReasoningEffortVariants(codexEfforts)
  }

  const efforts = [...WIDELY_SUPPORTED_EFFORTS]
  if (id.includes("gpt-5-") || id === "gpt-5") efforts.unshift("minimal")
  if (model.release_date >= "2025-11-13") efforts.unshift("none")
  if (model.release_date >= "2025-12-04") efforts.push("xhigh")
  return encryptedReasoningEffortVariants(efforts)
}

function bedrockReasoningVariants(model: Provider.Model, isAnthropicAdaptive: boolean): ReasoningVariants {
  if (isAnthropicAdaptive) return adaptiveReasoningConfigVariants()
  if (model.api.id.includes("anthropic")) return enabledReasoningConfigVariants()
  return novaReasoningConfigVariants()
}

function googleReasoningVariants(id: string): ReasoningVariants {
  if (id.includes("2.5")) return geminiBudgetVariants()
  return geminiLevelVariants(id.includes("3.1") ? ["low", "medium", "high"] : ["low", "high"])
}

function sapReasoningVariants(model: Provider.Model, id: string, isAnthropicAdaptive: boolean): ReasoningVariants {
  if (model.api.id.includes("anthropic")) {
    if (isAnthropicAdaptive) return adaptiveThinkingVariants()
    return enabledThinkingVariants(16000, 31999)
  }
  if (model.api.id.includes("gemini") && id.includes("2.5")) return geminiBudgetVariants()
  if (model.api.id.includes("gpt") || /\bo[1-9]/.test(model.api.id))
    return reasoningEffortVariants(WIDELY_SUPPORTED_EFFORTS)
  return {}
}

export function variants(model: Provider.Model): Record<string, Record<string, any>> {
  if (!model.capabilities.reasoning) return {}

  const id = model.id.toLowerCase()
  const apiID = model.api.id.toLowerCase()
  const isAnthropicAdaptive = ADAPTIVE_ANTHROPIC_IDS.some((value) => model.api.id.includes(value))
  if (REASONING_EXCLUDED_MODEL_PARTS.some((part) => id.includes(part))) return {}

  const grok = grokReasoningVariants(id, model)
  if (grok) return grok

  if (model.providerID === "qgenie" || model.providerID === "qpilot") {
    return qualcommReasoningVariants(model, apiID, isAnthropicAdaptive)
  }

  if (REASONING_EFFORT_PROVIDERS.has(model.api.npm)) return reasoningEffortVariants(WIDELY_SUPPORTED_EFFORTS)

  switch (model.api.npm) {
    case "@openrouter/ai-sdk-provider":
      if (!model.id.includes("gpt") && !model.id.includes("gemini-3") && !model.id.includes("claude")) return {}
      return openRouterReasoningVariants(OPENAI_EFFORTS)
    case "@ai-sdk/gateway":
      return gatewayReasoningVariants(model, id, isAnthropicAdaptive)
    case "@ai-sdk/github-copilot":
      return copilotReasoningVariants(model, id)
    case "@ai-sdk/azure":
      return azureReasoningVariants(id)
    case "@ai-sdk/openai":
      return openAIReasoningVariants(model, id)
    case "@ai-sdk/anthropic":
    case "@ai-sdk/google-vertex/anthropic":
      return anthropicThinkingVariants(model, isAnthropicAdaptive)
    case "@ai-sdk/amazon-bedrock":
      return bedrockReasoningVariants(model, isAnthropicAdaptive)
    case "@ai-sdk/google-vertex":
    case "@ai-sdk/google":
      return googleReasoningVariants(id)
    case "@ai-sdk/mistral":
    case "@ai-sdk/cohere":
    case "@ai-sdk/perplexity":
      return {}
    case "@ai-sdk/groq":
      return reasoningEffortVariants(["none", ...WIDELY_SUPPORTED_EFFORTS])
    case "@jerome-benoit/sap-ai-provider-v2":
      return sapReasoningVariants(model, id, isAnthropicAdaptive)
  }
  return {}
}

export function buildIncludeEncryptedReasoning(existing?: string[]): string[] {
  if (!Array.isArray(existing)) return ["reasoning.encrypted_content"]
  if (!existing.includes("reasoning.encrypted_content")) {
    return [...existing, "reasoning.encrypted_content"]
  }
  return existing
}

// ── Request options builders ─────────────────────────────────────────────────
// Extracted from ProviderTransform.options() and ProviderTransform.smallOptions()
// to slim transform.ts below 300 lines.

type ProviderRequestOptionsInput = {
  model: Provider.Model
  sessionID: string
  providerOptions?: Record<string, any>
}

function shouldDisableResponseStore(model: Provider.Model) {
  return (
    model.providerID === "openai" ||
    model.providerID === "azure" ||
    model.api.npm === "@ai-sdk/openai" ||
    model.api.npm === "@ai-sdk/azure" ||
    model.api.npm === "@ai-sdk/github-copilot"
  )
}

function applyQualcommResponsesOptions(result: Record<string, any>, model: Provider.Model) {
  if (!isQualcommOpenAIResponsesRoute(model)) return
  result.store = true
  result.parallelToolCalls = false
  if (!model.capabilities?.reasoning) return

  // qpilot/qgenie OpenAI-family models use proxy-prefixed IDs such as
  // `azure::gpt-5.4`. @ai-sdk/openai only recognizes bare `gpt-5*` IDs
  // as reasoning models, so force reasoning mode here to make selected
  // effort variants serialize into the Responses `reasoning` body field.
  result.forceReasoning = true
  result.reasoningEffort = "high"
  result.reasoningSummary = "auto"
  result.include = buildIncludeEncryptedReasoning(result.include)
}

function applyOpenRouterOptions(result: Record<string, any>, model: Provider.Model) {
  if (model.api.npm !== "@openrouter/ai-sdk-provider") return
  result.usage = { include: true }
  if (model.api.id.includes("gemini-3")) result.reasoning = { effort: "high" }
}

function applyProviderSpecificThinking(result: Record<string, any>, model: Provider.Model) {
  if (
    model.providerID === "baseten" ||
    (model.providerID === "opencode" && ["kimi-k2-thinking", "glm-4.6"].includes(model.api.id))
  ) {
    result.chat_template_args = { enable_thinking: true }
  }

  if (["zai", "zhipuai"].includes(model.providerID) && model.api.npm === "@ai-sdk/openai-compatible") {
    result.thinking = { type: "enabled", clear_thinking: false }
  }
}

function isOpenAIStyleCacheModel(input: ProviderRequestOptionsInput) {
  return (
    input.model.providerID === "openai" ||
    input.model.providerID === "azure" ||
    input.model.providerID === "qpilot" ||
    input.model.providerID === "qgenie" ||
    input.model.api.npm === "@ai-sdk/openai" ||
    input.model.api.npm === "@ai-sdk/azure" ||
    input.model.api.npm === "@ai-sdk/openai-compatible" ||
    input.providerOptions?.setCacheKey
  )
}

function applyOpenAIStyleCacheOptions(result: Record<string, any>, input: ProviderRequestOptionsInput) {
  if (!isOpenAIStyleCacheModel(input) || CacheFlags.isDisabled(input.model)) return

  const upstream = Upstream.detectUpstream(input.model.api.id)
  const strategy = Upstream.cacheStrategyForUpstream(upstream)
  if (strategy.promptCacheKey) {
    result.promptCacheKey = input.sessionID
    result.prompt_cache_key = input.sessionID
  }
  if (strategy.metadataHint) {
    result.metadata = {
      ...((result.metadata as Record<string, any>) ?? {}),
      cache_session_key: input.sessionID,
      cache_upstream: upstream,
    }
  }
  if (strategy.includeEncryptedReasoning) {
    result.include = buildIncludeEncryptedReasoning(result.include)
  }
}

function applyGoogleThinkingOptions(result: Record<string, any>, model: Provider.Model) {
  if (model.api.npm !== "@ai-sdk/google" && model.api.npm !== "@ai-sdk/google-vertex") return
  if (!model.capabilities.reasoning) return

  result.thinkingConfig = { includeThoughts: true }
  if (model.api.id.includes("gemini-3")) result.thinkingConfig.thinkingLevel = "high"
}

function applyAnthropicKimiThinkingOptions(result: Record<string, any>, model: Provider.Model, modelId: string) {
  if (model.api.npm !== "@ai-sdk/anthropic" && model.api.npm !== "@ai-sdk/google-vertex/anthropic") return
  if (!modelId.includes("k2p5") && !modelId.includes("kimi-k2.5") && !modelId.includes("kimi-k2p5")) return

  result.thinking = {
    type: "enabled",
    budgetTokens: Math.min(16_000, Math.floor(model.limit.output / 2 - 1)),
  }
}

function applyAlibabaThinkingOptions(result: Record<string, any>, model: Provider.Model, modelId: string) {
  if (model.providerID !== "alibaba-cn") return
  if (!model.capabilities.reasoning) return
  if (model.api.npm !== "@ai-sdk/openai-compatible") return
  if (modelId.includes("kimi-k2-thinking")) return
  result.enable_thinking = true
}

function applyGpt5Defaults(result: Record<string, any>, input: ProviderRequestOptionsInput) {
  if (!input.model.api.id.includes("gpt-5") || input.model.api.id.includes("gpt-5-chat")) return

  if (!input.model.api.id.includes("gpt-5-pro") && result.reasoningEffort === undefined) {
    result.reasoningEffort = "medium"
    result.reasoningSummary = "auto"
  }
  if (
    input.model.api.id.includes("gpt-5.") &&
    !input.model.api.id.includes("codex") &&
    !input.model.api.id.includes("-chat") &&
    input.model.providerID !== "azure"
  ) {
    result.textVerbosity = "low"
  }
  if (input.model.providerID.startsWith("opencode")) {
    result.promptCacheKey = input.sessionID
    result.include = buildIncludeEncryptedReasoning(result.include)
    result.reasoningSummary = "auto"
  }
}

function applyProviderCacheKeys(result: Record<string, any>, input: ProviderRequestOptionsInput) {
  if (input.model.providerID === "venice") result.promptCacheKey = input.sessionID
  if (input.model.providerID === "openrouter") result.prompt_cache_key = input.sessionID
  if (input.model.api.npm === "@ai-sdk/gateway") result.gateway = { caching: "auto" }
}

export function buildProviderRequestOptions(input: ProviderRequestOptionsInput): Record<string, any> {
  const result: Record<string, any> = {}
  const modelId = input.model.api.id.toLowerCase()

  // openai and providers using openai package should set store to false by default.
  // Azure direct (@ai-sdk/azure) also requires store:false — without it the AI SDK
  // emits item_reference for prior rs_* reasoning ids and Azure rejects the lookup
  // with "Item with id 'rs_...' not found". Qualcomm Responses routes are
  // handled below (they set store:true via the Qualcomm Responses path).
  if (shouldDisableResponseStore(input.model)) result.store = false

  applyQualcommResponsesOptions(result, input.model)
  applyOpenRouterOptions(result, input.model)
  applyProviderSpecificThinking(result, input.model)
  applyOpenAIStyleCacheOptions(result, input)
  applyGoogleThinkingOptions(result, input.model)
  applyAnthropicKimiThinkingOptions(result, input.model, modelId)
  applyAlibabaThinkingOptions(result, input.model, modelId)
  applyGpt5Defaults(result, input)
  applyProviderCacheKeys(result, input)
  return result
}

export function buildSmallOptions(model: Provider.Model): Record<string, any> {
  if (
    model.providerID === "openai" ||
    model.providerID === "azure" ||
    model.api.npm === "@ai-sdk/openai" ||
    model.api.npm === "@ai-sdk/azure" ||
    model.api.npm === "@ai-sdk/github-copilot"
  ) {
    if (model.api.id.includes("gpt-5"))
      return model.api.id.includes("5.")
        ? { store: false, reasoningEffort: "low" }
        : { store: false, reasoningEffort: "minimal" }
    return { store: false }
  }
  if (model.providerID === "google")
    return model.api.id.includes("gemini-3")
      ? { thinkingConfig: { thinkingLevel: "minimal" } }
      : { thinkingConfig: { thinkingBudget: 0 } }
  if (model.providerID === "openrouter")
    return model.api.id.includes("google") ? { reasoning: { enabled: false } } : { reasoningEffort: "minimal" }
  if (model.providerID === "venice") return { veniceParameters: { disableThinking: true } }
  return {}
}
