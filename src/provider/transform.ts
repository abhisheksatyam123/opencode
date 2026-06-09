import type { ModelMessage } from "ai"
import type { JSONSchema7 } from "@ai-sdk/provider"
import type { JSONSchema } from "zod/v4/core"
import { CacheFlags } from "@/provider/cache-flags"
import { Flag } from "@/foundation/flag/flag"
import type { Provider } from "@/provider/provider"
import * as Upstream from "@/provider/upstream"
import {
  flattenAnyOfSchema,
  isQualcommOpenAIResponsesRoute,
  isQualcommVertexGeminiModel,
  normalizeMessages,
  sanitizeGeminiSchema,
  sanitizeQualcommVertexGemini,
  schemaBucket,
  schemaCache,
  sdkKey,
  unsupportedParts,
} from "@/provider/request-shaping-helpers"
import { applyCaching, supportsCacheMarkers as sharedSupportsCacheMarkers } from "@/provider/cache-metadata-helpers"
import {
  buildIncludeEncryptedReasoning,
  buildProviderRequestOptions,
  buildSmallOptions,
  variants as sharedVariants,
} from "@/provider/reasoning-options-helpers"

/**
 * Returns true if the given model ID belongs to the Opus family.
 * Used by compaction model resolver to enforce the Opus denylist.
 */
export function isOpusFamily(modelID: string): boolean {
  const id = modelID.toLowerCase()
  return /opus-4[-.]6/i.test(id) || id === "opus" || id.endsWith("/opus")
}

export namespace ProviderTransform {
  export const OUTPUT_TOKEN_MAX = Flag.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX || 32_000
  export const supportsCacheMarkers = sharedSupportsCacheMarkers
  export const variants = sharedVariants

  export function message(
    msgs: ModelMessage[],
    model: Provider.Model,
    options: Record<string, unknown>,
    sessionID?: string,
  ) {
    let result = unsupportedParts(msgs, model)
    result = normalizeMessages(result, model, options)
    if (sharedSupportsCacheMarkers(model)) result = applyCaching(result, model, sessionID)

    const key = sdkKey(model.api.npm)
    if (!key || key === model.providerID) return result

    const remap = (opts: NonNullable<ModelMessage["providerOptions"]> | undefined) => {
      if (!opts || !(model.providerID in opts)) return opts
      const next = { ...opts }
      next[key] = next[model.providerID]
      delete next[model.providerID]
      return next
    }

    return result.map((msg) => {
      if (!Array.isArray(msg.content)) return { ...msg, providerOptions: remap(msg.providerOptions) }
      return {
        ...msg,
        providerOptions: remap(msg.providerOptions),
        content: msg.content.map((part) => {
          if (part.type === "tool-approval-request" || part.type === "tool-approval-response") return { ...part }
          return { ...part, providerOptions: remap(part.providerOptions) }
        }),
      } as typeof msg
    })
  }

  export function temperature(model: Provider.Model) {
    const id = model.id.toLowerCase()
    if (id.includes("qwen")) return 0.55
    if (id.includes("claude")) return undefined
    if (["gemini", "glm-4.6", "glm-4.7", "minimax-m2"].some((s) => id.includes(s))) return 1.0
    if (id.includes("kimi-k2")) return ["thinking", "k2.", "k2p", "k2-5"].some((s) => id.includes(s)) ? 1.0 : 0.6
    return undefined
  }

  export function topP(model: Provider.Model) {
    const id = model.id.toLowerCase()
    if (id.includes("qwen")) return 1
    if (["minimax-m2", "gemini", "kimi-k2.5", "kimi-k2p5", "kimi-k2-5"].some((s) => id.includes(s))) return 0.95
    return undefined
  }

  export function topK(model: Provider.Model) {
    const id = model.id.toLowerCase()
    if (id.includes("minimax-m2")) return ["m2.", "m25", "m21"].some((s) => id.includes(s)) ? 40 : 20
    if (id.includes("gemini")) return 64
    return undefined
  }

  // AI SDK providerOptions remain provider-specific open records; keep `any`
  // at this boundary so callers retain typed indexed access to nested options.
  export function options(input: {
    model: Provider.Model
    sessionID: string
    providerOptions?: Record<string, any>
  }): Record<string, any> {
    return buildProviderRequestOptions(input)
  }

  export function smallOptions(model: Provider.Model) {
    return buildSmallOptions(model)
  }

  const SLUG_OVERRIDES: Record<string, string> = { amazon: "bedrock" }

  export function providerOptions(model: Provider.Model, options: { [x: string]: any }) {
    if (model.api.npm === "@ai-sdk/gateway") {
      const i = model.api.id.indexOf("/")
      const rawSlug = i > 0 ? model.api.id.slice(0, i) : undefined
      const slug = rawSlug ? (SLUG_OVERRIDES[rawSlug] ?? rawSlug) : undefined
      const gateway = options.gateway
      const rest = Object.fromEntries(Object.entries(options).filter(([k]) => k !== "gateway"))
      const result: Record<string, any> = {}
      if (gateway !== undefined) result.gateway = gateway
      if (Object.keys(rest).length > 0) {
        if (slug) result[slug] = rest
        else if (gateway && typeof gateway === "object" && !Array.isArray(gateway))
          result.gateway = { ...gateway, ...rest }
        else result.gateway = rest
      }
      return result
    }

    const key = sdkKey(model.api.npm) ?? model.providerID
    if (model.api.npm === "@ai-sdk/azure") return { openai: options, azure: options }
    if (model.providerID === "qpilot" || model.providerID === "qgenie") {
      const { promptCacheKey, prompt_cache_key, ...common } = options
      if (isQualcommOpenAIResponsesRoute(model)) {
        return {
          [model.providerID]: { ...common, ...(prompt_cache_key !== undefined && { prompt_cache_key }) },
          openai: { ...common, ...(promptCacheKey !== undefined && { promptCacheKey }) },
        }
      }
      if (Upstream.detectUpstream(model.api.id) === "anthropic") {
        return { [model.providerID]: common, anthropic: common }
      }
      return {
        [model.providerID]: { ...common, ...(prompt_cache_key !== undefined && { prompt_cache_key }) },
        openai: { ...common, ...(promptCacheKey !== undefined && { promptCacheKey }) },
      }
    }
    return { [key]: options }
  }

  export function maxOutputTokens(model: Provider.Model): number {
    return Math.min(model.limit.output, OUTPUT_TOKEN_MAX) || OUTPUT_TOKEN_MAX
  }

  export function schema(model: Provider.Model, schema: JSONSchema.BaseSchema | JSONSchema7): JSONSchema7 {
    const bucket = schemaCache[schemaBucket(model)]
    const cacheKey = typeof schema === "object" && schema !== null ? (schema as object) : null
    if (cacheKey) {
      const cached = bucket.get(cacheKey)
      if (cached) return cached
    }

    if (model.providerID === "google" || model.api.id.includes("gemini")) {
      schema = sanitizeGeminiSchema(schema)
    }

    let result = schema as JSONSchema7
    if (!result.type && (result.anyOf || result.oneOf || result.allOf)) result = { type: "object", ...result }

    const id = model.api.id.toLowerCase()
    const isQualcommProvider = model.providerID === "qpilot" || model.providerID === "qgenie"
    const rejectsTopLevelSchemaKeywords =
      model.api.npm === "@ai-sdk/anthropic" ||
      model.api.npm === "@ai-sdk/google-vertex/anthropic" ||
      model.api.npm === "@ai-sdk/amazon-bedrock" ||
      model.providerID === "anthropic" ||
      model.providerID === "google-vertex-anthropic" ||
      model.providerID.includes("bedrock") ||
      model.api.id.includes("claude") ||
      isQualcommVertexGeminiModel(model) ||
      (isQualcommProvider &&
        (["azure::", "azure/", "openai::", "openai/"].some((p) => id.startsWith(p)) ||
          ["gpt-", "codex", "o1", "o3"].some((s) => id.includes(s))))

    if (rejectsTopLevelSchemaKeywords && (result.anyOf || result.oneOf || result.allOf)) {
      result = flattenAnyOfSchema(result)
    }

    if (rejectsTopLevelSchemaKeywords) {
      delete result.anyOf
      delete result.oneOf
      delete result.allOf
      delete result.enum
      delete result.not
      result.type = "object"
      result.properties = result.properties ?? {}
    }

    if (isQualcommVertexGeminiModel(model)) result = sanitizeQualcommVertexGemini(result) as JSONSchema7
    if (cacheKey) bucket.set(cacheKey, result)
    return result
  }
}
