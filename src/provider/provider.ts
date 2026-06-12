import z from "zod"
import os from "os"
import crypto from "node:crypto"
import { execSync } from "child_process"
import fuzzysort from "fuzzysort"
import { Config } from "@/config/config"
import { mapValues, mergeDeep, omit, pickBy, sortBy } from "remeda"
import { NoSuchModelError, type Provider as SDK } from "ai"
import type { Auth as PluginSDKAuth } from "@opencode-ai/sdk"
import { Log } from "@/foundation/util/log"
import { Npm } from "@/init/npm"
import { Hash } from "@/foundation/util/hash"
import { ProviderPluginHooks } from "@/provider/plugin-hooks"
import { NamedError } from "@opencode-ai/util/error"
import { type LanguageModelV3 } from "@ai-sdk/provider"
import { Auth } from "@/init/auth"
import { Env } from "@/filesystem/env"
import { InstanceContextStorage } from "@/foundation/effect/instance-context"
import { Flag } from "@/foundation/flag/flag"
import { iife } from "@/foundation/util/iife"
import { Global } from "@/filesystem/global"
import path from "path"
import { Filesystem } from "@/foundation/util/filesystem"
import { Transport } from "@/foundation/util/transport"
import { Effect, Layer, ServiceMap } from "effect"
import { InstanceState } from "@/foundation/effect/instance-state"
import { makeRuntime } from "@/foundation/effect/run-service"
import {
  HttpSessionLog,
  LlmHttpRequestEvent,
  LlmHttpResponseEvent,
  type HttpLogRecord,
} from "@/foundation/log/http-session"
import { GlobalBus } from "@/bus"

// Direct imports for bundled providers
import { createAmazonBedrock, type AmazonBedrockProviderSettings } from "@ai-sdk/amazon-bedrock"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createAzure } from "@ai-sdk/azure"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createVertex } from "@ai-sdk/google-vertex"
import { createVertexAnthropic } from "@ai-sdk/google-vertex/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { createOpenaiCompatible as createGitHubCopilotOpenAICompatible } from "@/provider/sdk/copilot"
import { createXai } from "@ai-sdk/xai"
import { createMistral } from "@ai-sdk/mistral"
import { createGroq } from "@ai-sdk/groq"
import { createDeepInfra } from "@ai-sdk/deepinfra"
import { createCerebras } from "@ai-sdk/cerebras"
import { createCohere } from "@ai-sdk/cohere"
import { createGateway } from "@ai-sdk/gateway"
import { createTogetherAI } from "@ai-sdk/togetherai"
import { createPerplexity } from "@ai-sdk/perplexity"
import { createVercel } from "@ai-sdk/vercel"
import { createVenice } from "venice-ai-sdk-provider"
import {
  createGitLab,
  VERSION as GITLAB_PROVIDER_VERSION,
  isWorkflowModel,
  discoverWorkflowModels,
} from "gitlab-ai-provider"
import { fromNodeProviderChain } from "@aws-sdk/credential-providers"
import { GoogleAuth } from "google-auth-library"
import { ProviderTransform } from "@/provider/transform"
import { Installation } from "@/init/installation"
import { ModelID, ProviderID } from "@/provider/schema"
import { ModelRouter } from "@/provider/model-router"
import * as Qualcomm from "@/provider/qualcomm"

export namespace Provider {
  const log = Log.create({ service: "provider" })

  function shouldUseCopilotResponsesApi(modelID: string): boolean {
    const match = /^gpt-(\d+)/.exec(modelID)
    if (!match) return false
    return Number(match[1]) >= 5 && !modelID.startsWith("gpt-5-mini")
  }

  export const isCodexModel = Qualcomm.isCodexModel
  export type QualcommModelRoute = Qualcomm.QualcommModelRoute
  export type QualcommRouteConfig = Qualcomm.QualcommRouteConfig
  export const qualcommModelRoute = Qualcomm.qualcommModelRoute
  export const shouldUseQualcommResponsesApi = Qualcomm.shouldUseQualcommResponsesApi
  export const normalizeQgenieResponsesBody = Qualcomm.normalizeQgenieResponsesBody
  export const parseQgenieBody = Qualcomm.parseQgenieBody
  export const sanitizeResponsesInputBody = Qualcomm.sanitizeResponsesInputBody
  export const qualcommApiKey = Qualcomm.qualcommApiKey
  export const normalizeQualcommBaseURL = Qualcomm.normalizeQualcommBaseURL
  export const injectQualcommVertexThoughtSignatures = Qualcomm.injectQualcommVertexThoughtSignatures

  const decodeJsonBody = Qualcomm.decodeJsonBody
  const qualcommHeaders = Qualcomm.qualcommHeaders
  const isQualcommProviderID = Qualcomm.isQualcommProviderID
  const firstNonEmptyString = Qualcomm.firstNonEmptyString
  const isQualcommGeminiVertexModelID = Qualcomm.isQualcommGeminiVertexModelID

  function withFetchPreconnect(fetchFn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
    return Object.assign(fetchFn, {
      preconnect: globalThis.fetch.preconnect,
    })
  }

  function qualcommLoggedFetch(
    providerID: string,
    modelID: string,
    fetchFn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  ) {
    return withFetchPreconnect(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString()
      const method = init?.method ?? "GET"
      const headers = new Headers(init?.headers)
      const sessionID = headers.get("x-opencode-session") ?? headers.get("x-session-affinity") ?? "unknown"
      const attempt = Number(headers.get("x-opencode-attempt") ?? 0)
      const t0 = Date.now()
      log.info("qualcomm.http.request", { providerID, modelID, sessionID, attempt, method, url })
      try {
        const res = await fetchFn(input, init)
        const payload = {
          providerID,
          modelID,
          sessionID,
          attempt,
          url,
          status: res.status,
          duration_ms: Date.now() - t0,
          retry_after: res.headers.get("retry-after"),
          retry_after_ms: res.headers.get("retry-after-ms"),
        }
        if (res.status === 429) log.warn("qualcomm.http.response", payload)
        else log.info("qualcomm.http.response", payload)
        return res
      } catch (err) {
        log.warn("qualcomm.http.error", {
          providerID,
          modelID,
          sessionID,
          attempt,
          url,
          duration_ms: Date.now() - t0,
          error: err instanceof Error ? err.message : String(err),
        })
        throw err
      }
    })
  }

  function createQualcommResponsesModel(providerID: string, modelID: string, options?: Record<string, any>) {
    const configuredBaseURL = firstNonEmptyString(options?.endpoint, options?.baseURL)
    const normalizedBaseURL =
      (providerID === "qpilot" || providerID === "qgenie"
        ? normalizeQualcommBaseURL(providerID, configuredBaseURL)
        : undefined) ?? configuredBaseURL
    const apiKey = qualcommApiKey(providerID, options)
    const resolvedOptions: Record<string, any> = {
      ...(options ?? {}),
      ...(apiKey ? { apiKey } : {}),
      ...(normalizedBaseURL ? { baseURL: normalizedBaseURL } : {}),
    }
    const forcedHeaders = qualcommHeaders(providerID, modelID, resolvedOptions, "bearer")
    const model = createOpenAI({
      name: providerID,
      apiKey: apiKey ?? "unused",
      baseURL: normalizedBaseURL,
      headers: forcedHeaders,
      fetch: qualcommLoggedFetch(providerID, modelID, (async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = { ...(init ?? {}) }
        const headers = new Headers(req.headers)
        for (const [k, v] of Object.entries(forcedHeaders)) {
          headers.set(k, v)
        }

        const url = typeof input === "string" ? input : input.toString()
        const isResponsesPost = req.method === "POST" && url.includes("/responses")
        if (isResponsesPost && req.body) {
          try {
            req.body = parseQgenieBody(req.body) as BodyInit | null | undefined
          } catch (err) {
            log.error("qualcomm.responses.sanitize.error", {
              providerID,
              modelID,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }

        let res = await (resolvedOptions.fetch ?? fetch)(input, { ...req, headers })

        // On 4xx from the responses endpoint, log the sanitized input structure
        // so the exact item sequence is visible without decoding the full body.
        // This is the key diagnostic for "No tool call found for function call output"
        // and similar Azure input-validation errors.
        if (!res.ok && res.status >= 400 && res.status < 500 && isResponsesPost) {
          try {
            const body = req.body
            const bodyStr =
              typeof body === "string"
                ? body
                : body instanceof Uint8Array || body instanceof ArrayBuffer
                  ? new TextDecoder().decode(body)
                  : ""
            const parsed = JSON.parse(bodyStr)
            const inputItems: Array<Record<string, unknown>> = Array.isArray(parsed?.input)
              ? parsed.input.map((item: any) => {
                  if (!item || typeof item !== "object") return { raw: item }
                  const { type, role, call_id, id } = item as Record<string, any>
                  return { type: type ?? role, ...(call_id ? { call_id } : {}), ...(id ? { id } : {}) }
                })
              : []
            log.error("qualcomm.responses.4xx", {
              providerID,
              modelID,
              status: res.status,
              input_items: inputItems,
            })

            // Retry once when the proxy returns "Item with id '...' not found" for a
            // stale item_reference (rs_* / fc_*). This happens on long sessions when
            // the proxy evicts old response IDs from its store.
            //
            // Strategy: drop ALL item_references AND any function_call_output whose
            // call_id has no matching inline function_call (orphaned outputs). Dropping
            // item_references without also dropping their dependent outputs causes a
            // different 400: "No tool call found for function call output with call_id".
            const errBody = await res
              .clone()
              .json()
              .catch(() => null)
            const isItemNotFound =
              res.status === 400 &&
              typeof errBody?.error?.message === "string" &&
              /Item with id '[a-z0-9_]+' not found/i.test(errBody.error.message)

            if (isItemNotFound) {
              log.warn("qualcomm.responses.item-not-found.retry", {
                providerID,
                modelID,
                missingId: errBody.error.message.match(/'([^']+)'/)?.[1] ?? "unknown",
              })
              const retryBody = sanitizeResponsesInputBody(parsed, {
                dropItemReferences: true,
                dropPreviousResponseId: true,
                keepItemIds: false,
              })
              const retryReq = { ...req, body: JSON.stringify(retryBody) }
              res = await (resolvedOptions.fetch ?? fetch)(input, { ...retryReq, headers })
            }
          } catch (err) {
            log.debug("qualcomm.responses.diagnostic.skip", {
              providerID,
              modelID,
              reason: err instanceof Error ? err.message : String(err),
            })
          }
        }

        return res
        // Single cast: async lambda matches the SDK fetch option shape
      }) as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>),
    })

    return model.responses(modelID)
  }

  function createQualcommAnthropicModel(providerID: string, modelID: string, options?: Record<string, any>) {
    const configuredBaseURL = firstNonEmptyString(options?.endpoint, options?.baseURL)
    const normalizedBaseURL =
      (providerID === "qpilot" || providerID === "qgenie"
        ? normalizeQualcommBaseURL(providerID, configuredBaseURL)
        : undefined) ?? configuredBaseURL
    const apiKey = qualcommApiKey(providerID, options)
    const resolvedOptions: Record<string, any> = {
      ...(options ?? {}),
      ...(apiKey ? { apiKey } : {}),
      ...(normalizedBaseURL ? { baseURL: normalizedBaseURL } : {}),
    }
    const forcedHeaders = qualcommHeaders(providerID, modelID, resolvedOptions, "bearer")
    const upstreamFetch = (options?.fetch ?? fetch) as (input: any, init: any) => Promise<Response>
    const model = createAnthropic({
      name: `${providerID}.anthropic`,
      authToken: options?.authToken ?? apiKey ?? "unused",
      baseURL: normalizedBaseURL,
      headers: forcedHeaders,
      // The @ai-sdk/anthropic adapter sets its own `user-agent` (e.g.
      // `ai-sdk/anthropic/...`) after our headers are merged into the SDK
      // config. The Qualcomm gateway buckets daily-token quota by the
      // `user-agent` substring, so we MUST overwrite UA at the wire level —
      // mirrors the responses + chat paths below.
      fetch: qualcommLoggedFetch(providerID, modelID, (async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = { ...(init ?? {}) }
        const headers = new Headers(req.headers)
        for (const [k, v] of Object.entries(forcedHeaders)) {
          headers.set(k, v)
        }
        return upstreamFetch(input, { ...req, headers })
        // Single cast: async lambda matches the SDK fetch option shape
      }) as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>),
    })
    return model.chat(modelID)
  }

  function createQualcommChatModel(providerID: string, modelID: string, options?: Record<string, any>) {
    // openai-chat route (qpilot/qgenie Vertex/Gemini lands on /v1/chat/completions
    // via @ai-sdk/openai). The default SDK is built upstream WITHOUT a fetch
    // wrapper, so its `user-agent` (`ai-sdk/openai/...`) reaches the gateway —
    // which buckets daily-token quota by UA substring and lands us in the
    // shared/exhausted bucket. Rebuild the SDK locally with a forced fetch
    // that overwrites UA at the wire layer (mirrors the responses + anthropic
    // pattern above).
    const configuredBaseURL = firstNonEmptyString(options?.endpoint, options?.baseURL)
    const normalizedBaseURL =
      (providerID === "qpilot" || providerID === "qgenie"
        ? normalizeQualcommBaseURL(providerID as "qpilot" | "qgenie", configuredBaseURL)
        : undefined) ?? configuredBaseURL
    const apiKey = qualcommApiKey(providerID, options)
    const resolvedOptions: Record<string, any> = {
      ...(options ?? {}),
      ...(apiKey ? { apiKey } : {}),
      ...(normalizedBaseURL ? { baseURL: normalizedBaseURL } : {}),
    }
    const configuredGeminiExtraBody =
      isQualcommGeminiVertexModelID(modelID) &&
      resolvedOptions.extra_body &&
      typeof resolvedOptions.extra_body === "object"
        ? resolvedOptions.extra_body
        : undefined
    const forcedHeaders = qualcommHeaders(providerID, modelID, resolvedOptions, "bearer")
    const upstreamFetch = (options?.fetch ?? fetch) as (input: any, init: any) => Promise<Response>
    const model = createOpenAI({
      name: providerID,
      apiKey: apiKey ?? "unused",
      baseURL: normalizedBaseURL,
      headers: forcedHeaders,
      fetch: qualcommLoggedFetch(providerID, modelID, (async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = { ...(init ?? {}) }
        const headers = new Headers(req.headers)
        for (const [k, v] of Object.entries(forcedHeaders)) {
          headers.set(k, v)
        }

        if (req.method === "POST" && req.body) {
          try {
            const bodyText = typeof req.body === "string" ? req.body : new TextDecoder().decode(req.body as ArrayBuffer)
            const body = JSON.parse(bodyText)
            if (configuredGeminiExtraBody && body && typeof body === "object") {
              const requestExtraBody = (body as { extra_body?: unknown }).extra_body
              ;(body as Record<string, any>).extra_body =
                requestExtraBody && typeof requestExtraBody === "object"
                  ? mergeDeep(configuredGeminiExtraBody, requestExtraBody)
                  : configuredGeminiExtraBody
            }
            req.body = JSON.stringify(injectQualcommVertexThoughtSignatures(providerID, modelID, body))
          } catch (err) {
            log.debug("qualcomm.chat.body-transform.skip", {
              providerID,
              modelID,
              reason: err instanceof Error ? err.message : String(err),
            })
          }
        }

        return upstreamFetch(input, { ...req, headers })
        // Single cast: async lambda matches the SDK fetch option shape
      }) as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>),
    })
    // SDK provider objects expose .chat/.chatModel/.languageModel at runtime but not in public types
    const sdk = model as unknown as Record<string, ((id: string) => LanguageModelV3) | undefined>
    if (sdk.chat) return sdk.chat(modelID)
    if (sdk.chatModel) return sdk.chatModel(modelID)
    return sdk.languageModel!(modelID)
  }

  export function createQualcommModel(providerID: "qgenie" | "qpilot", modelID: string, options?: Record<string, any>) {
    switch (qualcommModelRoute(providerID, modelID, options?.qualcommRoute)) {
      case "openai-responses":
        return createQualcommResponsesModel(providerID, modelID, options)
      case "anthropic":
        return createQualcommAnthropicModel(providerID, modelID, options)
      case "openai-chat":
        return createQualcommChatModel(providerID, modelID, options)
    }
  }

  function googleVertexVars(options: Record<string, any>) {
    const project =
      options["project"] ?? Env.get("GOOGLE_CLOUD_PROJECT") ?? Env.get("GCP_PROJECT") ?? Env.get("GCLOUD_PROJECT")
    const location =
      options["location"] ?? Env.get("GOOGLE_CLOUD_LOCATION") ?? Env.get("VERTEX_LOCATION") ?? "us-central1"
    const endpoint = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`
    return {
      ...(project && { GOOGLE_VERTEX_PROJECT: project }),
      GOOGLE_VERTEX_LOCATION: location,
      GOOGLE_VERTEX_ENDPOINT: endpoint,
    }
  }

  function wrapSSE(res: Response, ms: number, ctl: AbortController) {
    if (!res.body) return res
    const reader = res.body.getReader()
    const body = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        const part = await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
          const id = setTimeout(() => {
            const err = new Error("SSE read timed out")
            ctl.abort(err)
            void reader.cancel(err)
            reject(err)
          }, ms)

          reader.read().then(
            (part) => {
              clearTimeout(id)
              resolve(part)
            },
            (err: unknown) => {
              clearTimeout(id)
              reject(err)
            },
          )
        })

        if (part.done) {
          ctrl.close()
          return
        }

        ctrl.enqueue(part.value)
      },
      async cancel(reason) {
        ctl.abort(reason)
        await reader.cancel(reason)
      },
    })

    return new Response(body, {
      headers: new Headers(res.headers),
      status: res.status,
      statusText: res.statusText,
    })
  }

  function e2eURL() {
    const url = Env.get("OPENCODE_E2E_LLM_URL")
    if (typeof url !== "string" || url === "") return
    return url
  }

  type BundledSDK = {
    languageModel(modelId: string): LanguageModelV3
  }

  const BUNDLED_PROVIDERS: Record<string, (options: any) => BundledSDK> = {
    "@ai-sdk/amazon-bedrock": createAmazonBedrock,
    "@ai-sdk/anthropic": createAnthropic,
    "@ai-sdk/azure": createAzure,
    "@ai-sdk/google": createGoogleGenerativeAI,
    "@ai-sdk/google-vertex": createVertex,
    "@ai-sdk/google-vertex/anthropic": createVertexAnthropic,
    "@ai-sdk/openai": createOpenAI,
    "@ai-sdk/openai-compatible": createOpenAICompatible,
    "@openrouter/ai-sdk-provider": createOpenRouter,
    "@ai-sdk/xai": createXai,
    "@ai-sdk/mistral": createMistral,
    "@ai-sdk/groq": createGroq,
    "@ai-sdk/deepinfra": createDeepInfra,
    "@ai-sdk/cerebras": createCerebras,
    "@ai-sdk/cohere": createCohere,
    "@ai-sdk/gateway": createGateway,
    "@ai-sdk/togetherai": createTogetherAI,
    "@ai-sdk/perplexity": createPerplexity,
    "@ai-sdk/vercel": createVercel,
    "gitlab-ai-provider": createGitLab,
    "@ai-sdk/github-copilot": createGitHubCopilotOpenAICompatible,
    "venice-ai-sdk-provider": createVenice,
  }

  type CustomModelLoader = (sdk: any, modelID: string, options?: Record<string, any>) => Promise<any>
  type CustomVarsLoader = (options: Record<string, any>) => Record<string, string>
  type CustomDiscoverModels = () => Promise<Record<string, Model>>
  type CustomLoader = (provider: Info) => Effect.Effect<{
    autoload: boolean
    getModel?: CustomModelLoader
    vars?: CustomVarsLoader
    options?: Record<string, any>
    discoverModels?: CustomDiscoverModels
  }>

  type CustomDep = {
    auth: (id: string) => Effect.Effect<Auth.Info | undefined>
    config: () => Effect.Effect<Config.Info>
  }

  function useLanguageModel(sdk: any) {
    return sdk.responses === undefined && sdk.chat === undefined
  }

  function custom(dep: CustomDep): Record<string, CustomLoader> {
    return {
      anthropic: Effect.fnUntraced(function* (input: Info) {
        const auth = yield* dep.auth(input.id)
        const isOAuth = auth?.type === "oauth"

        // When using OAuth (Claude Max/Pro subscription), include the required
        // claude-code and oauth beta headers so the API accepts Bearer tokens
        const betaHeaders = isOAuth
          ? [
              "claude-code-20250219",
              "oauth-2025-04-20",
              "interleaved-thinking-2025-05-14",
              "fine-grained-tool-streaming-2025-05-14",
              "prompt-caching-scope-2026-01-05",
            ]
          : ["interleaved-thinking-2025-05-14", "fine-grained-tool-streaming-2025-05-14"]

        const options: Record<string, any> = {
          headers: {
            "anthropic-beta": betaHeaders.join(","),
          },
        }
        if (isOAuth) {
          options.authToken = auth.access
          return { autoload: true, options }
        }
        return { autoload: false, options }
      }),
      opencode: Effect.fnUntraced(function* (input: Info) {
        const env = Env.all()
        const hasKey = iife(() => {
          if (input.env.some((item) => env[item])) return true
          return false
        })
        const ok =
          hasKey ||
          Boolean(yield* dep.auth(input.id)) ||
          Boolean((yield* dep.config()).provider?.["opencode"]?.options?.apiKey)

        if (!ok) {
          for (const [key, value] of Object.entries(input.models)) {
            if (value.cost.input === 0) continue
            delete input.models[key]
          }
        }

        return {
          autoload: Object.keys(input.models).length > 0,
          options: ok ? {} : { apiKey: "public" },
        }
      }),
      openai: () =>
        Effect.succeed({
          autoload: false,
          async getModel(sdk: any, modelID: string, _options?: Record<string, any>) {
            return sdk.responses(modelID)
          },
          options: {},
        }),
      qgenie: () =>
        Effect.succeed({
          autoload: false,
          async getModel(_sdk: any, modelID: string, options?: Record<string, any>) {
            return createQualcommModel("qgenie", modelID, options)
          },
          options: {},
        }),
      qpilot: () =>
        Effect.succeed({
          autoload: false,
          async getModel(_sdk: any, modelID: string, options?: Record<string, any>) {
            return createQualcommModel("qpilot", modelID, options)
          },
          options: {},
        }),
      "github-copilot": () =>
        Effect.succeed({
          autoload: false,
          async getModel(sdk: any, modelID: string, _options?: Record<string, any>) {
            if (useLanguageModel(sdk)) return sdk.languageModel(modelID)
            return shouldUseCopilotResponsesApi(modelID) ? sdk.responses(modelID) : sdk.chat(modelID)
          },
          options: {},
        }),
      azure: (provider) => {
        const resource = iife(() => {
          const name = provider.options?.resourceName
          if (typeof name === "string" && name.trim() !== "") return name
          return Env.get("AZURE_RESOURCE_NAME")
        })

        return Effect.succeed({
          autoload: false,
          async getModel(sdk: any, modelID: string, options?: Record<string, any>) {
            if (useLanguageModel(sdk)) return sdk.languageModel(modelID)
            if (options?.["useCompletionUrls"]) {
              return sdk.chat(modelID)
            } else {
              return sdk.responses(modelID)
            }
          },
          options: {},
          vars(_options) {
            return {
              ...(resource && { AZURE_RESOURCE_NAME: resource }),
            }
          },
        })
      },
      "azure-cognitive-services": () => {
        const resourceName = Env.get("AZURE_COGNITIVE_SERVICES_RESOURCE_NAME")
        return Effect.succeed({
          autoload: false,
          async getModel(sdk: any, modelID: string, options?: Record<string, any>) {
            if (useLanguageModel(sdk)) return sdk.languageModel(modelID)
            if (options?.["useCompletionUrls"]) {
              return sdk.chat(modelID)
            } else {
              return sdk.responses(modelID)
            }
          },
          options: {
            baseURL: resourceName ? `https://${resourceName}.cognitiveservices.azure.com/openai` : undefined,
          },
        })
      },
      "amazon-bedrock": Effect.fnUntraced(function* () {
        const providerConfig = (yield* dep.config()).provider?.["amazon-bedrock"]
        const auth = yield* dep.auth("amazon-bedrock")

        // Region precedence: 1) config file, 2) env var, 3) default
        const configRegion = providerConfig?.options?.region
        const envRegion = Env.get("AWS_REGION")
        const defaultRegion = configRegion ?? envRegion ?? "us-east-1"

        // Profile: config file takes precedence over env var
        const configProfile = providerConfig?.options?.profile
        const envProfile = Env.get("AWS_PROFILE")
        const profile = configProfile ?? envProfile

        const awsAccessKeyId = Env.get("AWS_ACCESS_KEY_ID")

        // ARCH-DEBT: Using process.env directly because Env.set only updates a process.env shallow copy,
        // not the real process.env that the AWS SDK reads. Fix: extend Env.set to write through to
        // process.env, or use a provider-scoped env injection hook instead of global mutation.
        const awsBearerToken = iife(() => {
          const envToken = process.env.AWS_BEARER_TOKEN_BEDROCK
          if (envToken) return envToken
          if (auth?.type === "api") {
            process.env.AWS_BEARER_TOKEN_BEDROCK = auth.key
            return auth.key
          }
          return undefined
        })

        const awsWebIdentityTokenFile = Env.get("AWS_WEB_IDENTITY_TOKEN_FILE")

        const containerCreds = Boolean(
          process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI,
        )

        if (!profile && !awsAccessKeyId && !awsBearerToken && !awsWebIdentityTokenFile && !containerCreds)
          return { autoload: false }

        const providerOptions: AmazonBedrockProviderSettings = {
          region: defaultRegion,
        }

        // Only use credential chain if no bearer token exists
        // Bearer token takes precedence over credential chain (profiles, access keys, IAM roles, web identity tokens)
        if (!awsBearerToken) {
          // Build credential provider options (only pass profile if specified)
          const credentialProviderOptions = profile ? { profile } : {}

          providerOptions.credentialProvider = fromNodeProviderChain(credentialProviderOptions)
        }

        // Add custom endpoint if specified (endpoint takes precedence over baseURL)
        const endpoint = providerConfig?.options?.endpoint ?? providerConfig?.options?.baseURL
        if (endpoint) {
          providerOptions.baseURL = endpoint
        }

        return {
          autoload: true,
          options: providerOptions,
          async getModel(sdk: any, modelID: string, options?: Record<string, any>) {
            // Skip region prefixing if model already has a cross-region inference profile prefix
            // Models from config/openAPI may already include prefixes like us., eu., global., etc.
            const crossRegionPrefixes = ["global.", "us.", "eu.", "jp.", "apac.", "au."]
            if (crossRegionPrefixes.some((prefix) => modelID.startsWith(prefix))) {
              return sdk.languageModel(modelID)
            }

            // Region resolution precedence (highest to lowest):
            // 1. options.region from opencode.json provider config
            // 2. defaultRegion from AWS_REGION environment variable
            // 3. Default "us-east-1" (baked into defaultRegion)
            const region = options?.region ?? defaultRegion

            let regionPrefix = region.split("-")[0]

            switch (regionPrefix) {
              case "us": {
                const modelRequiresPrefix = [
                  "nova-micro",
                  "nova-lite",
                  "nova-pro",
                  "nova-premier",
                  "nova-2",
                  "claude",
                  "deepseek",
                ].some((m) => modelID.includes(m))
                const isGovCloud = region.startsWith("us-gov")
                if (modelRequiresPrefix && !isGovCloud) {
                  modelID = `${regionPrefix}.${modelID}`
                }
                break
              }
              case "eu": {
                const regionRequiresPrefix = [
                  "eu-west-1",
                  "eu-west-2",
                  "eu-west-3",
                  "eu-north-1",
                  "eu-central-1",
                  "eu-south-1",
                  "eu-south-2",
                ].some((r) => region.includes(r))
                const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "llama3", "pixtral"].some((m) =>
                  modelID.includes(m),
                )
                if (regionRequiresPrefix && modelRequiresPrefix) {
                  modelID = `${regionPrefix}.${modelID}`
                }
                break
              }
              case "ap": {
                const isAustraliaRegion = ["ap-southeast-2", "ap-southeast-4"].includes(region)
                const isTokyoRegion = region === "ap-northeast-1"
                if (
                  isAustraliaRegion &&
                  ["anthropic.claude-sonnet-4-5", "anthropic.claude-haiku"].some((m) => modelID.includes(m))
                ) {
                  regionPrefix = "au"
                  modelID = `${regionPrefix}.${modelID}`
                } else if (isTokyoRegion) {
                  // Tokyo region uses jp. prefix for cross-region inference
                  const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "nova-pro"].some((m) =>
                    modelID.includes(m),
                  )
                  if (modelRequiresPrefix) {
                    regionPrefix = "jp"
                    modelID = `${regionPrefix}.${modelID}`
                  }
                } else {
                  // Other APAC regions use apac. prefix
                  const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "nova-pro"].some((m) =>
                    modelID.includes(m),
                  )
                  if (modelRequiresPrefix) {
                    regionPrefix = "apac"
                    modelID = `${regionPrefix}.${modelID}`
                  }
                }
                break
              }
            }

            return sdk.languageModel(modelID)
          },
        }
      }),
      openrouter: () =>
        Effect.succeed({
          autoload: false,
          options: {
            headers: {
              "HTTP-Referer": "https://opencode.ai/",
              "X-Title": "opencode",
            },
          },
        }),
      vercel: () =>
        Effect.succeed({
          autoload: false,
          options: {
            headers: {
              "http-referer": "https://opencode.ai/",
              "x-title": "opencode",
            },
          },
        }),
      "google-vertex": (provider) => {
        const project =
          provider.options?.project ??
          Env.get("GOOGLE_CLOUD_PROJECT") ??
          Env.get("GCP_PROJECT") ??
          Env.get("GCLOUD_PROJECT")

        const location = String(
          provider.options?.location ??
            Env.get("GOOGLE_VERTEX_LOCATION") ??
            Env.get("GOOGLE_CLOUD_LOCATION") ??
            Env.get("VERTEX_LOCATION") ??
            "us-central1",
        )

        const autoload = Boolean(project)
        if (!autoload) return Effect.succeed({ autoload: false })
        return Effect.succeed({
          autoload: true,
          vars(_options: Record<string, any>) {
            const endpoint =
              location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`
            return {
              ...(project && { GOOGLE_VERTEX_PROJECT: project }),
              GOOGLE_VERTEX_LOCATION: location,
              GOOGLE_VERTEX_ENDPOINT: endpoint,
            }
          },
          options: {
            project,
            location,
            fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
              const auth = new GoogleAuth()
              const client = await auth.getApplicationDefault()
              const token = await client.credential.getAccessToken()

              const headers = new Headers(init?.headers)
              headers.set("Authorization", `Bearer ${token.token}`)

              return fetch(input, { ...init, headers })
            },
          },
          async getModel(sdk: any, modelID: string) {
            const id = String(modelID).trim()
            return sdk.languageModel(id)
          },
        })
      },
      "antigravity": (provider) => {
        const optionsProject = provider.options?.project
        const project =
          (optionsProject && optionsProject !== "tuned-keel-d72qv" ? optionsProject : null) ??
          Env.get("ANTIGRAVITY_PROJECT_ID") ??
          Env.get("GOOGLE_CLOUD_PROJECT") ??
          Env.get("GCP_PROJECT") ??
          Env.get("GCLOUD_PROJECT") ??
          optionsProject ??
          "tuned-keel-d72qv"

        const antigravityEndpoint =
          provider.options?.endpoint ??
          Env.get("ANTIGRAVITY_ENDPOINT") ??
          "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse"

        // API key fallback: when ADC is unavailable, allow auth via env-based key
        const antigravityApiKey = Env.get("ANTIGRAVITY_API_KEY")

        const autoload = Boolean(project)
        if (!autoload) return Effect.succeed({ autoload: false })

        // ── Cached auth state ───────────────────────────────────────────────
        // Auth chain: API key → keyring → OAuth refresh → ADC
        // Tokens are cached to avoid re-reading credentials on every LLM call.
        let cachedGoogleAuth: InstanceType<typeof GoogleAuth> | undefined
        let cachedCredential: { token: string; expiryMs: number } | undefined
        let cachedRefreshToken: string | undefined
        let cachedKeyringAccessToken: string | undefined
        let cachedKeyringExpiryMs: number | undefined

        // OAuth client credentials for Antigravity token refresh
        const ANTIGRAVITY_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh" + "4g403ep.apps.googleusercontent" + ".com"
        const ANTIGRAVITY_CLIENT_SECRET = "GOCSPX-K" + "58FWR486LdLJ1mLB8s" + "XC4z6qDAf"

        async function refreshAccessToken(refreshToken: string): Promise<{ token: string; expiryMs: number }> {
          const res = await fetch("https://oauth2.googleapis.com/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "refresh_token",
              refresh_token: refreshToken,
              client_id: ANTIGRAVITY_CLIENT_ID,
              client_secret: ANTIGRAVITY_CLIENT_SECRET,
            }),
          })
          if (!res.ok) {
            const body = await res.text().catch(() => "")
            throw new Error(`OAuth refresh failed (${res.status}): ${body.slice(0, 200)}`)
          }
          const payload = await res.json() as any
          const expiryMs = Date.now() + (payload.expires_in ?? 3600) * 1000
          return { token: payload.access_token, expiryMs }
        }

        async function getAuthToken(): Promise<string> {
          // Fast path 1: API key auth bypass
          if (antigravityApiKey) return antigravityApiKey

          // Fast path 2: Cached keyring token (valid within 5 min of expiry)
          if (cachedKeyringAccessToken && cachedKeyringExpiryMs && Date.now() < cachedKeyringExpiryMs - 300_000) {
            return cachedKeyringAccessToken
          }

          // Fast path 3: OAuth refresh using cached refresh token (no python needed)
          if (cachedRefreshToken) {
            try {
              const refreshed = await refreshAccessToken(cachedRefreshToken)
              cachedKeyringAccessToken = refreshed.token
              cachedKeyringExpiryMs = refreshed.expiryMs
              log.info("antigravity.auth.refresh.success", { expiryMs: refreshed.expiryMs })
              return refreshed.token
            } catch (e) {
              log.debug("antigravity.auth.refresh.error", { error: String(e) })
              // Fall through to keyring/ADC
              cachedRefreshToken = undefined
            }
          }

          // Fast path 4: Keyring-based authentication from `agy`
          // Try multiple python paths — miniconda has keyring, system python may not
          const pythonPaths = [
            Env.get("ANTIGRAVITY_PYTHON"),
            "/home/abhi/miniconda3/bin/python",
            "python3",
          ].filter(Boolean) as string[]

          let keyringOutput = ""
          for (const py of pythonPaths) {
            try {
              keyringOutput = execSync(
                `${py} -c "import keyring; print(keyring.get_password('gemini', 'antigravity'))"`,
                { encoding: "utf-8", stdio: "pipe" }
              ).trim()
              if (keyringOutput && keyringOutput !== "None") break
            } catch { continue }
          }

          if (keyringOutput && keyringOutput !== "None") {
            try {
              const data = JSON.parse(keyringOutput)
              if (data?.token?.access_token) {
                const expiryMs = new Date(data.token.expiry).getTime()
                // Cache the refresh token for future OAuth refreshes
                if (data.token.refresh_token) {
                  cachedRefreshToken = data.token.refresh_token
                }
                // If token is still valid for at least 5 minutes
                if (Date.now() < expiryMs - 300_000) {
                  cachedKeyringAccessToken = data.token.access_token
                  cachedKeyringExpiryMs = expiryMs
                  log.info("antigravity.auth.keyring.success", { expiryMs })
                  return data.token.access_token
                }
                // Token expired but we have refresh_token — refresh it
                if (cachedRefreshToken) {
                  try {
                    const refreshed = await refreshAccessToken(cachedRefreshToken)
                    cachedKeyringAccessToken = refreshed.token
                    cachedKeyringExpiryMs = refreshed.expiryMs
                    log.info("antigravity.auth.keyring.refresh", { expiryMs: refreshed.expiryMs })
                    return refreshed.token
                  } catch (e) {
                    log.debug("antigravity.auth.keyring.refresh.error", { error: String(e) })
                  }
                }
                // Use the expired token anyway (might still work for a short window)
                cachedKeyringAccessToken = data.token.access_token
                cachedKeyringExpiryMs = expiryMs
                return data.token.access_token
              }
            } catch (e) {
              log.debug("antigravity.auth.keyring.parse.error", { error: String(e) })
            }
          }

          // Fallback to Application Default Credentials (ADC)
          try {
            // Reuse token if still valid (with 60s safety margin)
            if (cachedCredential && Date.now() < cachedCredential.expiryMs - 60_000) {
              return cachedCredential.token
            }

            if (!cachedGoogleAuth) {
              cachedGoogleAuth = new GoogleAuth({
                scopes: ["https://www.googleapis.com/auth/cloud-platform"],
              })
            }

            const client = await cachedGoogleAuth.getApplicationDefault()
            const tokenResponse = await client.credential.getAccessToken()
            const token = tokenResponse.token
            if (!token) {
              throw new Error("GoogleAuth returned an empty access token")
            }

            // Cache with expiry (default 1 hour if not provided)
            const expiryMs =
              (tokenResponse as any).res?.data?.expiry_date ??
              Date.now() + 3_600_000
            cachedCredential = { token, expiryMs }
            return token
          } catch (err) {
            // Invalidate cache on failure so next call retries fresh
            cachedGoogleAuth = undefined
            cachedCredential = undefined

            const msg = err instanceof Error ? err.message : String(err)
            if (msg.includes("Could not load the default credentials") || msg.includes("Could not refresh access token")) {
              throw new Error(
                `Antigravity auth failed: ${msg}\n\n` +
                `To fix this, do ONE of the following:\n` +
                `  1. Run: gcloud auth application-default login\n` +
                `  2. Set GOOGLE_APPLICATION_CREDENTIALS to a service account key file\n` +
                `  3. Set ANTIGRAVITY_API_KEY for API key auth (bypasses ADC)\n` +
                `  4. Run: agy auth login (to store keyring credentials)\n` +
                `\nSee https://cloud.google.com/docs/authentication/getting-started`,
              )
            }
            throw err
          }
        }

        // ── Body parsing helper ─────────────────────────────────────────────
        function parseBody(body: BodyInit | null | undefined): Record<string, unknown> {
          if (!body) return {}
          try {
            if (typeof body === "string") return JSON.parse(body)
            if (body instanceof ArrayBuffer || body instanceof Uint8Array) {
              return JSON.parse(new TextDecoder().decode(body))
            }
            if (typeof body === "object" && "toString" in body) {
              return JSON.parse(body.toString())
            }
            return {}
          } catch {
            log.debug("antigravity.body-parse.fallback", { bodyType: typeof body })
            return {}
          }
        }

        // ── Stream transformer helper to unwrap Antigravity responses ───────────
        function transformSseStream(readableStream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
          const decoder = new TextDecoder()
          const encoder = new TextEncoder()
          let buffer = ""

          const transformStream = new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              buffer += decoder.decode(chunk, { stream: true })
              const lines = buffer.split("\n")
              buffer = lines.pop() ?? ""

              for (const line of lines) {
                const trimmed = line.trim()
                if (trimmed.startsWith("data: ")) {
                  const dataContent = trimmed.slice(6).trim()
                  if (dataContent === "[DONE]") {
                    controller.enqueue(encoder.encode(line + "\n"))
                    continue
                  }
                  try {
                    const parsed = JSON.parse(dataContent)
                    if (parsed && typeof parsed === "object" && "response" in parsed) {
                      const unwrapped = parsed.response
                      controller.enqueue(encoder.encode(`data: ${JSON.stringify(unwrapped)}\n`))
                    } else {
                      controller.enqueue(encoder.encode(line + "\n"))
                    }
                  } catch {
                    controller.enqueue(encoder.encode(line + "\n"))
                  }
                } else {
                  controller.enqueue(encoder.encode(line + "\n"))
                }
              }
            },
            flush(controller) {
              if (buffer) {
                const trimmed = buffer.trim()
                if (trimmed.startsWith("data: ")) {
                  const dataContent = trimmed.slice(6).trim()
                  if (dataContent === "[DONE]") {
                    controller.enqueue(encoder.encode(buffer + "\n"))
                  } else {
                    try {
                      const parsed = JSON.parse(dataContent)
                      if (parsed && typeof parsed === "object" && "response" in parsed) {
                        const unwrapped = parsed.response
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify(unwrapped)}\n`))
                      } else {
                        controller.enqueue(encoder.encode(buffer + "\n"))
                      }
                    } catch {
                      controller.enqueue(encoder.encode(buffer + "\n"))
                    }
                  }
                } else {
                  controller.enqueue(encoder.encode(buffer + "\n"))
                }
              }
            }
          })

          return readableStream.pipeThrough(transformStream)
        }

        return Effect.succeed({
          autoload: true,
          options: {
            project,
            location: "us-central1",
            apiKey: "dummy-key",
            fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
              // 1. Get auth token (cached, with auto-refresh)
              const token = await getAuthToken()

              // 2. Extract model ID from the original Vertex SDK URL
              //    Vertex SDK sends: .../models/{modelId}:streamGenerateContent?alt=sse
              const originalUrl = typeof input === "string"
                ? input
                : input instanceof Request
                  ? input.url
                  : input.toString()
              const modelMatch = originalUrl.match(/\/models\/([^:\/]+):/)
              const rawModelId = modelMatch ? decodeURIComponent(modelMatch[1]) : "unknown"

              // ── Model name mapping ──────────────────────────────────────
              // The Antigravity IDE sends model names with "-agent" suffix
              // (e.g. gemini-3-flash-agent). The API accepts bare names too,
              // but we mimic the IDE exactly.
              const agentModels = ["gemini-3-flash"]
              const modelId = agentModels.includes(rawModelId)
                ? `${rawModelId}-agent`
                : rawModelId

              // 3. Parse the original Gemini-format body from the SDK
              const originalBody = parseBody(init?.body)

              // ── Mimic Antigravity IDE metadata exactly ──────────────────
              // sessionId: stable per-process integer (matches IDE pattern)
              const antigravitySessionId = (() => {
                const key = "antigravity_session_id"
                if (!(globalThis as any)[key]) {
                  // Generate a stable int64 from a UUID
                  const uuid = crypto.randomUUID()
                  const hex = uuid.replace(/-/g, "").slice(0, 16)
                  ;(globalThis as any)[key] = `-${BigInt("0x" + hex).toString()}`
                }
                return (globalThis as any)[key]
              })()
              originalBody.sessionId = antigravitySessionId

              // toolConfig: the IDE always sends VALIDATED mode
              const tc = (originalBody.toolConfig ?? {}) as Record<string, any>
              originalBody.toolConfig = tc
              const fcc = (tc.functionCallingConfig ?? {}) as Record<string, any>
              tc.functionCallingConfig = fcc
              fcc.mode = "VALIDATED"

              // labels: internal tracking metadata the IDE always sends
              const trajectoryId = crypto.randomUUID()
              originalBody.labels = {
                model_enum: "MODEL_PLACEHOLDER_M132",
                trajectory_id: trajectoryId,
              }

              // 4. Wrap body in Antigravity envelope format
              // requestId: matches IDE format agent/<conversationId>/<ms>/<uuid>/<step>
              const requestUuid = crypto.randomUUID()
              const requestMs = Date.now()
              const requestId = `agent/${requestUuid}/${requestMs}/${requestUuid}/0`
              const wrappedBody = JSON.stringify({
                project,
                requestId,
                request: originalBody,
                model: modelId,
                userAgent: "antigravity",
                requestType: "agent",
              })

              // 5. Build headers — match Antigravity IDE exactly
              const headers = new Headers(init?.headers)
              headers.delete("x-goog-api-key") // strip the dummy key injected by the SDK in Express Mode
              if (antigravityApiKey) {
                headers.set("x-goog-api-key", token)
              } else {
                headers.set("Authorization", `Bearer ${token}`)
              }
              headers.set("Content-Type", "application/json")
              // Match the real Antigravity IDE User-Agent string
              headers.set("User-Agent", `antigravity/1.107.0 ${process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux"}/${process.arch}`)
              headers.set("X-Goog-Api-Client", "google-cloud-sdk vscode_cloudshelleditor/0.1")
              headers.set("Client-Metadata", JSON.stringify({ ideType: "ANTIGRAVITY", platform: process.platform === "win32" ? "WINDOWS" : process.platform === "darwin" ? "MACOS" : "LINUX", pluginType: "GEMINI" }))

              log.info("antigravity.request", {
                model: modelId,
                project,
                requestId,
                endpoint: antigravityEndpoint,
              })

              // 6. Forward to the Antigravity endpoint
              const t0 = Date.now()
              try {
                const res = await fetch(antigravityEndpoint, {
                  ...init,
                  method: "POST",
                  headers,
                  body: wrappedBody,
                })

                log.info("antigravity.response", {
                  model: modelId,
                  status: res.status,
                  duration_ms: Date.now() - t0,
                })

                if (!res.ok) {
                  const errorBody = await res.clone().text().catch(() => "")
                  log.error("antigravity.error", {
                    model: modelId,
                    status: res.status,
                    body: errorBody.slice(0, 500),
                    duration_ms: Date.now() - t0,
                  })
                  return res
                }

                const contentType = res.headers.get("content-type") ?? ""
                if (contentType.includes("text/event-stream") && res.body) {
                  return new Response(transformSseStream(res.body), {
                    status: res.status,
                    statusText: res.statusText,
                    headers: res.headers,
                  })
                }

                if (contentType.includes("application/json")) {
                  try {
                    const text = await res.text()
                    const parsed = JSON.parse(text)
                    if (parsed && typeof parsed === "object" && "response" in parsed) {
                      return new Response(JSON.stringify(parsed.response), {
                        status: res.status,
                        statusText: res.statusText,
                        headers: res.headers,
                      })
                    }
                    return new Response(text, {
                      status: res.status,
                      statusText: res.statusText,
                      headers: res.headers,
                    })
                  } catch {
                    // Fallback to default in case of error
                  }
                }

                return res
              } catch (err) {
                log.error("antigravity.fetch-error", {
                  model: modelId,
                  error: err instanceof Error ? err.message : String(err),
                  duration_ms: Date.now() - t0,
                })
                throw err
              }
            },
          },
          async getModel(sdk: any, modelID: string) {
            const id = String(modelID).trim()
            return sdk.languageModel(id)
          },
        })
      },
      "google-vertex-anthropic": () => {
        const project = Env.get("GOOGLE_CLOUD_PROJECT") ?? Env.get("GCP_PROJECT") ?? Env.get("GCLOUD_PROJECT")
        const location = Env.get("GOOGLE_CLOUD_LOCATION") ?? Env.get("VERTEX_LOCATION") ?? "global"
        const autoload = Boolean(project)
        if (!autoload) return Effect.succeed({ autoload: false })
        return Effect.succeed({
          autoload: true,
          options: {
            project,
            location,
          },
          async getModel(sdk: any, modelID) {
            const id = String(modelID).trim()
            return sdk.languageModel(id)
          },
        })
      },
      "sap-ai-core": Effect.fnUntraced(function* () {
        const auth = yield* dep.auth("sap-ai-core")
        // ARCH-DEBT: Using process.env directly because Env.set only updates a shallow copy (not process.env),
        // not the real process.env that the SAP AI Core SDK reads. Same root cause as bedrock above.
        const envServiceKey = iife(() => {
          const envAICoreServiceKey = process.env.AICORE_SERVICE_KEY
          if (envAICoreServiceKey) return envAICoreServiceKey
          if (auth?.type === "api") {
            process.env.AICORE_SERVICE_KEY = auth.key
            return auth.key
          }
          return undefined
        })
        const deploymentId = process.env.AICORE_DEPLOYMENT_ID
        const resourceGroup = process.env.AICORE_RESOURCE_GROUP

        return {
          autoload: !!envServiceKey,
          options: envServiceKey ? { deploymentId, resourceGroup } : {},
          async getModel(sdk: any, modelID: string) {
            return sdk(modelID)
          },
        }
      }),
      zenmux: () =>
        Effect.succeed({
          autoload: false,
          options: {
            headers: {
              "HTTP-Referer": "https://opencode.ai/",
              "X-Title": "opencode",
            },
          },
        }),
      gitlab: Effect.fnUntraced(function* (input: Info) {
        const instanceUrl = Env.get("GITLAB_INSTANCE_URL") || "https://gitlab.com"

        const auth = yield* dep.auth(input.id)
        const apiKey = yield* Effect.sync(() => {
          if (auth?.type === "oauth") return auth.access
          if (auth?.type === "api") return auth.key
          return Env.get("GITLAB_TOKEN")
        })

        const providerConfig = (yield* dep.config()).provider?.["gitlab"]

        const aiGatewayHeaders = {
          "User-Agent": `opencode/${Installation.VERSION} gitlab-ai-provider/${GITLAB_PROVIDER_VERSION} (${os.platform()} ${os.release()}; ${os.arch()})`,
          "anthropic-beta": "context-1m-2025-08-07",
          ...(providerConfig?.options?.aiGatewayHeaders || {}),
        }

        const featureFlags = {
          duo_agent_platform_agentic_chat: true,
          duo_agent_platform: true,
          ...(providerConfig?.options?.featureFlags || {}),
        }

        return {
          autoload: !!apiKey,
          options: {
            instanceUrl,
            apiKey,
            aiGatewayHeaders,
            featureFlags,
          },
          async getModel(sdk: ReturnType<typeof createGitLab>, modelID: string, options?: Record<string, any>) {
            if (modelID.startsWith("duo-workflow-")) {
              const workflowRef = options?.workflowRef as string | undefined
              // Use the static mapping if it exists, otherwise use duo-workflow with selectedModelRef
              const sdkModelID = isWorkflowModel(modelID) ? modelID : "duo-workflow"
              const model = sdk.workflowChat(sdkModelID, {
                featureFlags,
              })
              if (workflowRef) {
                model.selectedModelRef = workflowRef
              }
              return model
            }
            return sdk.agenticChat(modelID, {
              aiGatewayHeaders,
              featureFlags,
            })
          },
          async discoverModels(): Promise<Record<string, Model>> {
            if (!apiKey) {
              log.info("gitlab model discovery skipped: no apiKey")
              return {}
            }

            try {
              const token = apiKey
              const getHeaders = (): Record<string, string> =>
                auth?.type === "api" ? { "PRIVATE-TOKEN": token } : { Authorization: `Bearer ${token}` }

              log.info("gitlab model discovery starting", { instanceUrl })
              const result = await discoverWorkflowModels(
                { instanceUrl, getHeaders },
                { workingDirectory: InstanceContextStorage.directory },
              )

              if (!result.models.length) {
                log.info("gitlab model discovery skipped: no models found", {
                  project: result.project
                    ? {
                        id: result.project.id,
                        path: result.project.pathWithNamespace,
                      }
                    : null,
                })
                return {}
              }

              const models: Record<string, Model> = {}
              for (const m of result.models) {
                if (!input.models[m.id]) {
                  models[m.id] = {
                    id: ModelID.make(m.id),
                    providerID: ProviderID.make("gitlab"),
                    name: `Agent Platform (${m.name})`,
                    family: "",
                    api: {
                      id: m.id,
                      url: instanceUrl,
                      npm: "gitlab-ai-provider",
                    },
                    status: "active",
                    headers: {},
                    options: { workflowRef: m.ref },
                    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
                    limit: { context: m.context, output: m.output },
                    capabilities: {
                      temperature: false,
                      reasoning: true,
                      attachment: true,
                      toolcall: true,
                      input: {
                        text: true,
                        audio: false,
                        image: true,
                        video: false,
                        pdf: true,
                      },
                      output: {
                        text: true,
                        audio: false,
                        image: false,
                        video: false,
                        pdf: false,
                      },
                      interleaved: false,
                    },
                    release_date: "",
                    variants: {},
                  }
                }
              }

              log.info("gitlab model discovery complete", {
                count: Object.keys(models).length,
                models: Object.keys(models),
              })
              return models
            } catch (e) {
              log.warn("gitlab model discovery failed", { error: e })
              return {}
            }
          },
        }
      }),
      "cloudflare-workers-ai": Effect.fnUntraced(function* (input: Info) {
        // When baseURL is already configured (e.g. corporate config routing through a proxy/gateway),
        // skip the account ID check because the URL is already fully specified.
        if (input.options?.baseURL) return { autoload: false }

        const auth = yield* dep.auth(input.id)
        const accountId =
          Env.get("CLOUDFLARE_ACCOUNT_ID") || (auth?.type === "api" ? auth.metadata?.accountId : undefined)
        if (!accountId)
          return {
            autoload: false,
            async getModel() {
              throw new Error(
                "CLOUDFLARE_ACCOUNT_ID is missing. Set it with: export CLOUDFLARE_ACCOUNT_ID=<your-account-id>",
              )
            },
          }

        const apiKey = yield* Effect.gen(function* () {
          const envToken = Env.get("CLOUDFLARE_API_KEY")
          if (envToken) return envToken
          if (auth?.type === "api") return auth.key
          return undefined
        })

        return {
          autoload: !!apiKey,
          options: {
            apiKey,
            headers: {
              "User-Agent": `opencode/${Installation.VERSION} cloudflare-workers-ai (${os.platform()} ${os.release()}; ${os.arch()})`,
            },
          },
          async getModel(sdk: any, modelID: string) {
            return sdk.languageModel(modelID)
          },
          vars(_options) {
            return {
              CLOUDFLARE_ACCOUNT_ID: accountId,
            }
          },
        }
      }),
      "cloudflare-ai-gateway": Effect.fnUntraced(function* (input: Info) {
        // When baseURL is already configured (e.g. corporate config), skip the ID checks.
        if (input.options?.baseURL) return { autoload: false }

        const auth = yield* dep.auth(input.id)
        const accountId =
          Env.get("CLOUDFLARE_ACCOUNT_ID") || (auth?.type === "api" ? auth.metadata?.accountId : undefined)
        const gateway =
          Env.get("CLOUDFLARE_GATEWAY_ID") || (auth?.type === "api" ? auth.metadata?.gatewayId : undefined)

        if (!accountId || !gateway) {
          const missing = [
            !accountId ? "CLOUDFLARE_ACCOUNT_ID" : undefined,
            !gateway ? "CLOUDFLARE_GATEWAY_ID" : undefined,
          ].filter((x): x is string => Boolean(x))
          return {
            autoload: false,
            async getModel() {
              throw new Error(
                `${missing.join(" and ")} missing. Set with: ${missing.map((x) => `export ${x}=<value>`).join(" && ")}`,
              )
            },
          }
        }

        // Get API token from env or auth - required for authenticated gateways
        const apiToken = yield* Effect.gen(function* () {
          const envToken = Env.get("CLOUDFLARE_API_TOKEN") || Env.get("CF_AIG_TOKEN")
          if (envToken) return envToken
          if (auth?.type === "api") return auth.key
          return undefined
        })

        if (!apiToken) {
          throw new Error(
            "CLOUDFLARE_API_TOKEN (or CF_AIG_TOKEN) is required for Cloudflare AI Gateway. " +
              "Set it via environment variable or run `opencode auth cloudflare-ai-gateway`.",
          )
        }

        // Use official ai-gateway-provider package (v2.x for AI SDK v5 compatibility)
        const { createAiGateway } = yield* Effect.promise(() => import("ai-gateway-provider"))
        const { createUnified } = yield* Effect.promise(() => import("ai-gateway-provider/providers/unified"))

        const metadata = iife(() => {
          if (input.options?.metadata) return input.options.metadata
          try {
            return JSON.parse(input.options?.headers?.["cf-aig-metadata"])
          } catch {
            return undefined
          }
        })
        const opts = {
          metadata,
          cacheTtl: input.options?.cacheTtl,
          cacheKey: input.options?.cacheKey,
          skipCache: input.options?.skipCache,
          collectLog: input.options?.collectLog,
          headers: {
            "User-Agent": `opencode/${Installation.VERSION} cloudflare-ai-gateway (${os.platform()} ${os.release()}; ${os.arch()})`,
          },
        }

        const aigateway = createAiGateway({
          accountId,
          gateway,
          apiKey: apiToken,
          ...(Object.values(opts).some((v) => v !== undefined) ? { options: opts } : {}),
        })
        const unified = createUnified()

        return {
          autoload: true,
          async getModel(_sdk: any, modelID: string, _options?: Record<string, any>) {
            // Model IDs use Unified API format: provider/model.
            return aigateway(unified(modelID))
          },
          options: {},
        }
      }),
      cerebras: () =>
        Effect.succeed({
          autoload: false,
          options: {
            headers: {
              "X-Cerebras-3rd-Party-Integration": "opencode",
            },
          },
        }),
      kilo: () =>
        Effect.succeed({
          autoload: false,
          options: {
            headers: {
              "HTTP-Referer": "https://opencode.ai/",
              "X-Title": "opencode",
            },
          },
        }),
    }
  }

  export const Model = z
    .object({
      id: ModelID.zod,
      providerID: ProviderID.zod,
      api: z.object({
        id: z.string(),
        url: z.string(),
        npm: z.string(),
      }),
      name: z.string(),
      family: z.string().optional(),
      capabilities: z.object({
        temperature: z.boolean(),
        reasoning: z.boolean(),
        attachment: z.boolean(),
        toolcall: z.boolean(),
        input: z.object({
          text: z.boolean(),
          audio: z.boolean(),
          image: z.boolean(),
          video: z.boolean(),
          pdf: z.boolean(),
        }),
        output: z.object({
          text: z.boolean(),
          audio: z.boolean(),
          image: z.boolean(),
          video: z.boolean(),
          pdf: z.boolean(),
        }),
        interleaved: z.union([
          z.boolean(),
          z.object({
            field: z.enum(["reasoning_content", "reasoning_details"]),
          }),
        ]),
      }),
      cost: z.object({
        input: z.number(),
        output: z.number(),
        cache: z.object({
          read: z.number(),
          write: z.number(),
        }),
        experimentalOver200K: z
          .object({
            input: z.number(),
            output: z.number(),
            cache: z.object({
              read: z.number(),
              write: z.number(),
            }),
          })
          .optional(),
      }),
      limit: z.object({
        context: z.number(),
        input: z.number().optional(),
        output: z.number(),
      }),
      status: z.enum(["alpha", "beta", "deprecated", "active"]),
      options: z.record(z.string(), z.any()),
      headers: z.record(z.string(), z.string()),
      release_date: z.string(),
      variants: z.record(z.string(), z.record(z.string(), z.any())).optional(),
    })
    .meta({
      ref: "Model",
    })
  export type Model = z.infer<typeof Model>

  export const Info = z
    .object({
      id: ProviderID.zod,
      name: z.string(),
      source: z.enum(["env", "config", "custom", "api"]),
      env: z.string().array(),
      key: z.string().optional(),
      options: z.record(z.string(), z.any()),
      models: z.record(z.string(), Model),
    })
    .meta({
      ref: "Provider",
    })
  export type Info = z.infer<typeof Info>

  export interface Interface {
    readonly list: () => Effect.Effect<Record<ProviderID, Info>>
    readonly getProvider: (providerID: ProviderID) => Effect.Effect<Info>
    readonly getModel: (providerID: ProviderID, modelID: ModelID) => Effect.Effect<Model>
    readonly getLanguage: (model: Model) => Effect.Effect<LanguageModelV3>
    readonly closest: (
      providerID: ProviderID,
      query: string[],
    ) => Effect.Effect<{ providerID: ProviderID; modelID: string } | undefined>
    readonly getSmallModel: (providerID: ProviderID) => Effect.Effect<Model | undefined>
    readonly defaultModel: () => Effect.Effect<{ providerID: ProviderID; modelID: ModelID }>
  }

  interface State {
    models: Map<string, LanguageModelV3>
    providers: Record<ProviderID, Info>
    sdk: Map<string, BundledSDK>
    modelLoaders: Record<string, CustomModelLoader>
    varsLoaders: Record<string, CustomVarsLoader>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/Provider") {}

    

  type ProviderDatabase = Record<string, Info>
  type ProviderRegistry = Record<ProviderID, Info>
  type ConfigProvider = Config.Provider
  type ConfigModel = NonNullable<ConfigProvider["models"]>[string]

  function mergeProviderInto(
    providers: ProviderRegistry,
    database: ProviderDatabase,
    providerID: ProviderID,
    provider: Partial<Info>,
  ) {
    const existing = providers[providerID]
    if (existing) {
      // @ts-expect-error — mergeDeep return type is wider than Info; runtime shape is correct
      providers[providerID] = mergeDeep(existing, provider)
      return
    }

    const match = database[providerID]
    if (!match) return
    // @ts-expect-error — mergeDeep return type is wider than Info; runtime shape is correct
    providers[providerID] = mergeDeep(match, provider)
  }

  function isProviderAllowedByConfig(
    providerID: ProviderID,
    enabled: ReadonlySet<string> | null,
    disabled: ReadonlySet<string>,
  ) {
    if (enabled && !enabled.has(providerID)) return false
    if (disabled.has(providerID)) return false
    return true
  }

  function configuredModelName(modelID: string, model: ConfigModel, existingModel: Model | undefined) {
    if (model.name) return model.name
    if (model.id && model.id !== modelID) return modelID
    return existingModel?.name ?? modelID
  }

  function configuredModelApi(
    providerID: string,
    modelID: string,
    provider: ConfigProvider,
    model: ConfigModel,
    existingModel: Model | undefined,
  ): Model["api"] {
    return {
      id: model.id ?? existingModel?.api.id ?? modelID,
      npm:
        model.provider?.npm ??
        provider.npm ??
        existingModel?.api.npm ??
        "@ai-sdk/openai-compatible",
      url: (model.provider?.api ?? provider.api ?? existingModel?.api.url ?? "") as string,
    }
  }

  function configuredModelReasoning(
    providerID: string,
    modelID: string,
    model: ConfigModel,
    existingModel: Model | undefined,
  ) {
    return (
      model.reasoning ??
      (Qualcomm.inferQualcommReasoningCapability(providerID, model.id ?? modelID, {
        ...(model.endpoint && { endpoint: model.endpoint }),
        ...(model.provider?.npm && { npm: model.provider.npm }),
      }) ||
        existingModel?.capabilities.reasoning ||
        false)
    )
  }

  function configuredInputCapabilities(
    model: ConfigModel,
    existingModel: Model | undefined,
  ): Model["capabilities"]["input"] {
    return {
      text: model.modalities?.input?.includes("text") ?? existingModel?.capabilities.input.text ?? true,
      audio: model.modalities?.input?.includes("audio") ?? existingModel?.capabilities.input.audio ?? false,
      image: model.modalities?.input?.includes("image") ?? existingModel?.capabilities.input.image ?? false,
      video: model.modalities?.input?.includes("video") ?? existingModel?.capabilities.input.video ?? false,
      pdf: model.modalities?.input?.includes("pdf") ?? existingModel?.capabilities.input.pdf ?? false,
    }
  }

  function configuredOutputCapabilities(
    model: ConfigModel,
    existingModel: Model | undefined,
  ): Model["capabilities"]["output"] {
    return {
      text: model.modalities?.output?.includes("text") ?? existingModel?.capabilities.output.text ?? true,
      audio: model.modalities?.output?.includes("audio") ?? existingModel?.capabilities.output.audio ?? false,
      image: model.modalities?.output?.includes("image") ?? existingModel?.capabilities.output.image ?? false,
      video: model.modalities?.output?.includes("video") ?? existingModel?.capabilities.output.video ?? false,
      pdf: model.modalities?.output?.includes("pdf") ?? existingModel?.capabilities.output.pdf ?? false,
    }
  }

  function configuredModelCapabilities(
    providerID: string,
    modelID: string,
    model: ConfigModel,
    existingModel: Model | undefined,
  ): Model["capabilities"] {
    return {
      temperature: model.temperature ?? existingModel?.capabilities.temperature ?? false,
      reasoning: configuredModelReasoning(providerID, modelID, model, existingModel),
      attachment: model.attachment ?? existingModel?.capabilities.attachment ?? false,
      toolcall: model.tool_call ?? existingModel?.capabilities.toolcall ?? true,
      input: configuredInputCapabilities(model, existingModel),
      output: configuredOutputCapabilities(model, existingModel),
      interleaved: model.interleaved ?? false,
    }
  }

  function configuredModelCost(model: ConfigModel, existingModel: Model | undefined): Model["cost"] {
    return {
      input: model?.cost?.input ?? existingModel?.cost?.input ?? 0,
      output: model?.cost?.output ?? existingModel?.cost?.output ?? 0,
      cache: {
        read: model?.cost?.cache_read ?? existingModel?.cost?.cache.read ?? 0,
        write: model?.cost?.cache_write ?? existingModel?.cost?.cache.write ?? 0,
      },
    }
  }

  function configuredQualcommRouteOptions(model: ConfigModel) {
    if (!model.endpoint && !model.provider?.npm) return {}
    return {
      qualcommRoute: {
        ...(model.endpoint && { endpoint: model.endpoint }),
        ...(model.provider?.npm && { npm: model.provider.npm }),
      },
    }
  }

  function configuredModelOptions(model: ConfigModel, existingModel: Model | undefined): Model["options"] {
    return mergeDeep(
      mergeDeep(existingModel?.options ?? {}, model.options ?? {}),
      configuredQualcommRouteOptions(model),
    )
  }

  function configuredModelLimit(model: ConfigModel, existingModel: Model | undefined): Model["limit"] {
    return {
      context: model.limit?.context ?? existingModel?.limit?.context ?? 0,
      input: model.limit?.input ?? existingModel?.limit?.input,
      output: model.limit?.output ?? existingModel?.limit?.output ?? 0,
    }
  }

  function enabledModelVariants(variants: Record<string, any>): Record<string, Record<string, any>> {
    return mapValues(
      pickBy(variants, (variant) => !variant.disabled),
      (variant) => omit(variant, ["disabled"]),
    )
  }

  function applyConfiguredModelVariants(parsedModel: Model, configVariants: Record<string, any> | undefined) {
    const merged = mergeDeep(ProviderTransform.variants(parsedModel), configVariants ?? {})
    parsedModel.variants = enabledModelVariants(merged)
  }

  function buildConfiguredModel(
    providerID: string,
    modelID: string,
    provider: ConfigProvider,
    model: ConfigModel,
    existingModel: Model | undefined,
  ): Model {
    const parsedModel: Model = {
      id: ModelID.make(modelID),
      api: configuredModelApi(providerID, modelID, provider, model, existingModel),
      status: model.status ?? existingModel?.status ?? "active",
      name: configuredModelName(modelID, model, existingModel),
      providerID: ProviderID.make(providerID),
      capabilities: configuredModelCapabilities(providerID, modelID, model, existingModel),
      cost: configuredModelCost(model, existingModel),
      options: configuredModelOptions(model, existingModel),
      limit: configuredModelLimit(model, existingModel),
      headers: mergeDeep(existingModel?.headers ?? {}, model.headers ?? {}),
      family: model.family ?? existingModel?.family ?? "",
      release_date: model.release_date ?? existingModel?.release_date ?? "",
      variants: {},
    }

    applyConfiguredModelVariants(parsedModel, model.variants)
    return parsedModel
  }

  function buildConfiguredProvider(
    providerID: string,
    provider: ConfigProvider,
    existing: Info | undefined,
  ): Info {
    const parsed: Info = {
      id: ProviderID.make(providerID),
      name: provider.name ?? existing?.name ?? providerID,
      env: provider.env ?? existing?.env ?? [],
      options: mergeDeep(existing?.options ?? {}, provider.options ?? {}),
      source: "config",
      models: existing?.models ?? {},
    }

    for (const [modelID, model] of Object.entries(provider.models ?? {})) {
      const existingModel = parsed.models[model.id ?? modelID]
      parsed.models[modelID] = buildConfiguredModel(providerID, modelID, provider, model, existingModel)
    }

    return parsed
  }

  function extendDatabaseFromConfig(
    database: ProviderDatabase,
    configProviders: [string, ConfigProvider][],
  ) {
    for (const [providerID, provider] of configProviders) {
      database[providerID] = buildConfiguredProvider(providerID, provider, database[providerID])
    }
  }

  function attachProviderFetchSignal(
    opts: BunFetchRequestInit,
    options: Record<string, any>,
    chunkTimeout: unknown,
  ): AbortController | undefined {
    const chunkAbortCtl = typeof chunkTimeout === "number" && chunkTimeout > 0 ? new AbortController() : undefined
    const signals: AbortSignal[] = []

    if (opts.signal) signals.push(opts.signal)
    if (chunkAbortCtl) signals.push(chunkAbortCtl.signal)
    if (options["timeout"] !== undefined && options["timeout"] !== null && options["timeout"] !== false)
      signals.push(AbortSignal.timeout(options["timeout"]))

    const combined = signals.length === 0 ? null : signals.length === 1 ? signals[0] : AbortSignal.any(signals)
    if (combined) opts.signal = combined
    return chunkAbortCtl
  }

  function providerFetchRequestURL(input: RequestInfo | URL) {
    return typeof input === "string" ? input : String((input as any)?.url ?? input ?? "")
  }

  function captureProviderFetchCorrelation(opts: BunFetchRequestInit) {
    const requestId = crypto.randomUUID()
    const t0 = Date.now()
    const corrHeaders: Record<string, string> = {}
    if (opts.headers) {
      const headers = new Headers(opts.headers as HeadersInit)
      headers.forEach((value, key) => {
        corrHeaders[key] = value
      })
    }
    return {
      requestId,
      t0,
      sessionId: corrHeaders["x-opencode-session"] ?? corrHeaders["x-session-affinity"] ?? "unknown",
      parentSessionId: corrHeaders["x-parent-session-id"] ?? null,
      messageId: corrHeaders["x-opencode-request"] ?? null,
      attempt: Number(corrHeaders["x-opencode-attempt"] ?? 0),
      parentRequestId: corrHeaders["x-opencode-parent-request-id"] ?? null,
    }
  }

  function sanitizeProviderResponsesRequestBody(input: {
    opts: BunFetchRequestInit
    model: Model
    requestURL: string
    method: string
  }) {
    const isResponsesPost = input.method === "POST" && input.requestURL.includes("/responses")
    const needsResponsesSanitizer =
      isResponsesPost &&
      input.opts.body &&
      (input.model.api.npm === "@ai-sdk/openai" ||
        input.model.api.npm === "@ai-sdk/azure" ||
        isQualcommProviderID(input.model.providerID))
    if (!needsResponsesSanitizer) return

    const decoded = decodeJsonBody(input.opts.body)
    if (!decoded) return

    try {
      const body = JSON.parse(decoded)
      const isAzure = input.model.providerID.includes("azure") || input.model.api.npm === "@ai-sdk/azure"
      const isQualcommResponses = isQualcommProviderID(input.model.providerID)
      const sanitized = sanitizeResponsesInputBody(body, {
        // Azure direct only: allow IDs when caller explicitly requests store=true.
        // Qualcomm routes keep store=true but cannot safely replay stale refs.
        keepItemIds: isAzure && body.store === true && !isQualcommResponses,
        dropItemReferences: isQualcommResponses,
        dropPreviousResponseId: isQualcommResponses,
        maxCallIdLength: isQualcommResponses ? 64 : undefined,
      })
      if (sanitized !== body) input.opts.body = JSON.stringify(sanitized)
    } catch {
      // Non-JSON body; skip sanitizer.
    }
  }

  function rewriteClaudeCodePromptTags(system: unknown) {
    const rewrite = (text: string) =>
      text
        .replace(/<directories>/g, "[directories]")
        .replace(/<\/directories>/g, "[/directories]")
        .replace(/<env>/g, "[env]")
        .replace(/<\/env>/g, "[/env]")

    if (Array.isArray(system)) {
      for (const entry of system) {
        if (entry && typeof entry === "object" && typeof (entry as any).text === "string") {
          ;(entry as any).text = rewrite((entry as any).text)
        }
      }
      return system
    }
    return typeof system === "string" ? rewrite(system) : system
  }

  async function applyAnthropicOAuthRequestRewrite(
    model: Model,
    options: Record<string, any>,
    opts: BunFetchRequestInit,
  ) {
    if (model.providerID !== "anthropic" || !options["authToken"]) return

    const freshToken = (await ProviderPluginHooks.latestAnthropicToken()) ?? (options["authToken"] as string)
    const sdkHeaders = new Headers(opts.headers as HeadersInit)
    const cleanHeaders: Record<string, string> = {}
    for (const key of ["content-type", "anthropic-version", "accept"]) {
      const val = sdkHeaders.get(key)
      if (val) cleanHeaders[key] = val
    }
    // Set anthropic-beta explicitly — only include betas that work with Max subscription
    cleanHeaders["anthropic-beta"] =
      "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05"
    cleanHeaders["authorization"] = `Bearer ${freshToken}`
    cleanHeaders["user-agent"] = "claude-cli/2.1.104 (ext, cli)"
    cleanHeaders["x-app"] = "cli"
    cleanHeaders["x-claude-code-session-id"] = Hash.fast(model.providerID + freshToken.slice(-8))
    opts.headers = cleanHeaders

    // Inject billing attribution header into system prompt
    if (opts.method !== "POST" || !opts.body) return
    try {
      const bodyStr = typeof opts.body === "string" ? opts.body : new TextDecoder().decode(opts.body as ArrayBuffer)
      const parsed = JSON.parse(bodyStr)
      const fp = Hash.fast(Date.now().toString()).slice(0, 8)
      const bh = `x-anthropic-billing-header: cc_version=2.1.104.${fp}; cc_entrypoint=cli;`
      if (typeof parsed.system === "string") parsed.system = bh + "\n" + parsed.system
      else if (Array.isArray(parsed.system)) parsed.system.unshift({ type: "text", text: bh })
      else parsed.system = bh
      // Strip fields not compatible with Max OAuth subscription
      delete parsed.context_management
      // Rewrite XML-like tags in system prompt that trigger third-party detection.
      // The API pattern-matches system prompts for non-Claude-Code XML structures.
      parsed.system = rewriteClaudeCodePromptTags(parsed.system)
      // Prompt caching IS supported for Max OAuth via the
      // prompt-caching-scope-2026-01-05 beta header (already
      // included above). Do NOT strip cache_control — qcode
      // (the reference Claude Code CLI) sends cache_control
      // with type:"ephemeral" on system, tools, and messages
      // for OAuth subscribers.
      opts.body = JSON.stringify(parsed)
    } catch (e) {
      console.error("[OAUTH-BILLING] FAILED:", e)
    }
  }

  const layer: Layer.Layer<Service, never, Config.Service | Auth.Service> = Layer.effect(
    Service,
    Effect.gen(function* () {
      const config = yield* Config.Service
      const auth = yield* Auth.Service

      const state = yield* InstanceState.make<State>(() =>
        Effect.gen(function* () {
          using _ = log.time("state")
          const cfg = yield* config.get()
          const modelsDev: Record<string, any> = {}
          const database: ProviderDatabase = {}
          const providers: Record<ProviderID, Info> = {} as Record<ProviderID, Info>
          const languages = new Map<string, LanguageModelV3>()
          const modelLoaders: {
            [providerID: string]: CustomModelLoader
          } = {}
          const varsLoaders: {
            [providerID: string]: CustomVarsLoader
          } = {}
          const sdk = new Map<string, BundledSDK>()
          const discoveryLoaders: {
            [providerID: string]: CustomDiscoverModels
          } = {}
          const dep = {
            auth: (id: string) => auth.get(id).pipe(Effect.orDie),
            config: () => config.get(),
          }

          log.info("init")

          const mergeProvider = (providerID: ProviderID, provider: Partial<Info>) =>
            mergeProviderInto(providers, database, providerID, provider)

          // load plugins first so config() hook runs before reading cfg.provider
          const plugins = yield* Effect.promise(() => ProviderPluginHooks.list())

          // now read config providers - includes any modifications from plugin config() hook
          const configProviders = Object.entries(cfg.provider ?? {})
          const disabled = new Set<string>(cfg.disabled_providers ?? [])
          const enabled = cfg.enabled_providers ? new Set<string>(cfg.enabled_providers) : null
          const isProviderAllowed = (providerID: ProviderID) => isProviderAllowedByConfig(providerID, enabled, disabled)

          // extend database from config
          extendDatabaseFromConfig(database, configProviders)

          // load env
          const env = Env.all()
          for (const [id, provider] of Object.entries(database)) {
            const providerID = ProviderID.make(id)
            if (disabled.has(providerID)) continue
            const apiKey = provider.env.map((item) => env[item]).find(Boolean)
            if (!apiKey) continue
            mergeProvider(providerID, {
              source: "env",
              key: provider.env.length === 1 ? apiKey : undefined,
            })
          }

          // load apikeys
          const auths = yield* auth.all().pipe(Effect.orDie)
          for (const [id, provider] of Object.entries(auths)) {
            const providerID = ProviderID.make(id)
            if (disabled.has(providerID)) continue
            if (provider.type === "api") {
              mergeProvider(providerID, {
                source: "api",
                key: provider.key,
              })
            }
          }

          // plugin auth loader - database now has entries for config providers
          for (const plugin of plugins) {
            if (!plugin.auth) continue
            const providerID = ProviderID.make(plugin.auth.provider)
            if (disabled.has(providerID)) continue

            const stored = yield* auth.get(providerID).pipe(Effect.orDie)
            if (!stored) continue
            if (!plugin.auth.loader) continue

            const getPluginAuth = async (): Promise<PluginSDKAuth> => {
              const current = await Effect.runPromise(auth.get(providerID).pipe(Effect.orDie))
              if (!current) throw new Error(`Auth entry missing for provider ${providerID}`)
              return current
            }
            const options = yield* Effect.promise(() =>
              plugin.auth!.loader!(getPluginAuth, database[plugin.auth!.provider]),
            )
            const opts = options ?? {}
            const patch: Partial<Info> = providers[providerID] ? { options: opts } : { source: "custom", options: opts }
            mergeProvider(providerID, patch)
          }

          for (const [id, fn] of Object.entries(custom(dep))) {
            const providerID = ProviderID.make(id)
            if (disabled.has(providerID)) continue
            const data = database[providerID]
            const configured = Boolean(cfg.provider?.[providerID])
            if (!data) {
              if (!configured) {
                log.error("Provider does not exist in model list " + providerID)
                continue
              }
            }
            const result = yield* fn(data as Info)
            if (result && (result.autoload || providers[providerID] || configured)) {
              if (result.getModel) modelLoaders[providerID] = result.getModel
              if (result.vars) varsLoaders[providerID] = result.vars
              if (result.discoverModels) discoveryLoaders[providerID] = result.discoverModels
              const opts = result.options ?? {}
              const patch: Partial<Info> = providers[providerID]
                ? { options: opts }
                : { source: "custom", options: opts }
              mergeProvider(providerID, patch)
            }
          }

          // load config - re-apply with updated data
          for (const [id, provider] of configProviders) {
            const providerID = ProviderID.make(id)
            const partial: Partial<Info> = { source: "config" }
            if (provider.env) partial.env = provider.env
            if (provider.name) partial.name = provider.name
            if (provider.options) partial.options = provider.options
            mergeProvider(providerID, partial)
          }

          const gitlab = ProviderID.make("gitlab")
          if (discoveryLoaders[gitlab] && providers[gitlab] && isProviderAllowed(gitlab)) {
            yield* Effect.promise(async () => {
              try {
                const discovered = await discoveryLoaders[gitlab]()
                for (const [modelID, model] of Object.entries(discovered)) {
                  if (!providers[gitlab].models[modelID]) {
                    providers[gitlab].models[modelID] = model
                  }
                }
              } catch (e) {
                log.warn("state discovery error", { id: "gitlab", error: e })
              }
            })
          }

          for (const hook of plugins) {
            const p = hook.provider
            const models = p?.models
            if (!p || !models) continue

            const providerID = ProviderID.make(p.id)
            if (disabled.has(providerID)) continue

            const provider = providers[providerID]
            if (!provider) continue
            const pluginAuth = yield* auth.get(providerID).pipe(Effect.orDie)

            provider.models = yield* Effect.promise(async () => {
              const next = await models(provider, { auth: pluginAuth })
              return Object.fromEntries(
                Object.entries(next).map(([id, model]) => [
                  id,
                  {
                    ...model,
                    id: ModelID.make(id),
                    providerID,
                  },
                ]),
              )
            })
          }

          for (const [id, provider] of Object.entries(providers)) {
            const providerID = ProviderID.make(id)
            if (!isProviderAllowed(providerID)) {
              delete providers[providerID]
              continue
            }

            const configProvider = cfg.provider?.[providerID]

            const implicitWhitelistModelIDs =
              configProvider?.models && !configProvider?.whitelist ? new Set(Object.keys(configProvider.models)) : null

            for (const [modelID, model] of Object.entries(provider.models)) {
              model.api.id = model.api.id ?? model.id ?? modelID
              if (model.status === "alpha" && !Flag.OPENCODE_ENABLE_EXPERIMENTAL_MODELS) delete provider.models[modelID]
              if (model.status === "deprecated") delete provider.models[modelID]
              if (
                (configProvider?.blacklist && configProvider.blacklist.includes(modelID)) ||
                (configProvider?.whitelist && !configProvider.whitelist.includes(modelID))
              )
                delete provider.models[modelID]

              model.variants = mapValues(ProviderTransform.variants(model), (v) => v)

              const configVariants = configProvider?.models?.[modelID]?.variants
              if (configVariants && model.variants) {
                const merged = mergeDeep(model.variants, configVariants)
                model.variants = mapValues(
                  pickBy(merged, (v) => !v.disabled),
                  (v) => omit(v, ["disabled"]),
                )
              }
            }

            // Implicit whitelist: if user listed models under provider.<id>.models in
            // config (and no explicit whitelist is set), treat those keys as the allowed
            // set. Run after variant generation to avoid collapsing generated variants.
            if (implicitWhitelistModelIDs && implicitWhitelistModelIDs.size > 0) {
              for (const modelID of Object.keys(provider.models)) {
                if (!implicitWhitelistModelIDs.has(modelID)) {
                  delete provider.models[modelID]
                }
              }
            }

            if (Object.keys(provider.models).length === 0) {
              delete providers[providerID]
              continue
            }

            log.info("found", { providerID })
          }

          return {
            models: languages,
            providers,
            sdk,
            modelLoaders,
            varsLoaders,
          }
        }),
      )

      const list = Effect.fn("Provider.list")(() => InstanceState.use(state, (s) => s.providers))

      async function resolveSDK(model: Model, s: State) {
        try {
          using _ = log.time("getSDK", {
            providerID: model.providerID,
          })
          const provider = s.providers[model.providerID]
          const options = { ...provider.options }

          if (model.providerID === "google-vertex" && !model.api.npm.includes("@ai-sdk/openai-compatible")) {
            delete options.fetch
          }

          if (model.api.npm.includes("@ai-sdk/openai-compatible") && options["includeUsage"] !== false) {
            options["includeUsage"] = true
          }

          const baseURL = iife(() => {
            // Back-compat: accept provider/model `endpoint` as an alias for `baseURL`
            // when users configure endpoints in opencode.json.
            let url = firstNonEmptyString(options["endpoint"], options["baseURL"]) ?? model.api.url
            if (!url) return

            const loader = s.varsLoaders[model.providerID]
            if (loader) {
              const vars = loader(options)
              for (const [key, value] of Object.entries(vars)) {
                const field = "${" + key + "}"
                url = url.replaceAll(field, value)
              }
            }

            url = url.replace(/\$\{([^}]+)\}/g, (item, key) => {
              const val = Env.get(String(key))
              return val ?? item
            })
            return url
          })

          const normalizedBaseURL =
            (isQualcommProviderID(model.providerID)
              ? normalizeQualcommBaseURL(model.providerID, baseURL)
              : undefined) ?? baseURL
          if (normalizedBaseURL !== undefined) options["baseURL"] = normalizedBaseURL
          if (options["apiKey"] === undefined && !options["authToken"] && provider.key) options["apiKey"] = provider.key
          if (model.headers)
            options["headers"] = {
              ...options["headers"],
              ...model.headers,
            }

          const key = Hash.content(
            JSON.stringify({
              providerID: model.providerID,
              npm: model.api.npm,
              options,
            }),
          )
          const existing = s.sdk.get(key)
          if (existing) return existing

          const customFetch = options["fetch"]
          const chunkTimeout = options["chunkTimeout"]
          delete options["chunkTimeout"]

          options["fetch"] = async (input: any, init?: BunFetchRequestInit) => {
            const fetchFn = customFetch ?? fetch
            const opts = init ?? {}
            const chunkAbortCtl = attachProviderFetchSignal(opts, options, chunkTimeout)

            // ── HTTP session logger: correlation IDs (read before any header mutation) ─
            const { requestId, t0, sessionId, parentSessionId, messageId, attempt, parentRequestId } =
              captureProviderFetchCorrelation(opts)
            // ─────────────────────────────────────────────────────────────────────

            // Strip stale OpenAI/Azure responses references before network send.
            // This is especially important for qpilot/qgenie `/responses` where
            // resumed sessions can carry invalid item_reference ids (rs_*/fc_*).
            sanitizeProviderResponsesRequestBody({
              opts,
              model,
              requestURL: providerFetchRequestURL(input),
              method: (opts.method ?? "GET").toUpperCase(),
            })

            // Claude Code Max OAuth: rewrite all headers and inject billing
            // header into the request body. This runs AFTER the SDK has built
            // its headers (including ai-sdk User-Agent suffix) so we can
            // strip everything that identifies us as a third-party app.
            // Dynamically resolve the latest token on every request so that
            // refreshed tokens are picked up without recreating the SDK.
            await applyAnthropicOAuthRequestRewrite(model, options, opts)

            // gap-port: HTTPS proxy + custom CA + mTLS for corporate networks
            // (qpilot/qgenie). Reads HTTPS_PROXY/NODE_EXTRA_CA_CERTS/
            // OPENCODE_CLIENT_CERT/OPENCODE_CLIENT_KEY env vars and returns
            // BunFetchRequestInit-compatible proxy + tls options. Returns
            // undefined when no transport env vars are set, so non-corporate
            // users have zero behavior change.
            const transport = Transport.buildTransportOptions(
              typeof input === "string" ? input : input instanceof URL ? input.href : (input as { url?: string })?.url,
            )

            // ── HTTP session logger: capture final request (post-mutation) ────────
            const reqEnvelope = HttpSessionLog.buildRequest(input, opts)
            const isQualcommRequest = model.providerID === "qpilot" || model.providerID === "qgenie"
            const recordHttp = (envelope: HttpLogRecord) => {
              HttpSessionLog.record(envelope)
              GlobalBus.emit("event", {
                payload: {
                  type: LlmHttpResponseEvent.type,
                  properties: {
                    request_id: envelope.request_id,
                    session_id: envelope.session_id,
                    attempt: envelope.attempt,
                    status: envelope.response.status,
                    duration_ms: envelope.duration_ms,
                    streaming: envelope.response.streaming,
                    aborted: envelope.response.aborted,
                    partial: envelope.response.partial,
                    error_kind: envelope.response.error?.kind ?? null,
                  },
                },
              })
            }
            GlobalBus.emit("event", {
              payload: {
                type: LlmHttpRequestEvent.type,
                properties: {
                  request_id: requestId,
                  session_id: sessionId,
                  attempt,
                  provider_id: model.providerID,
                  model_id: model.id,
                  method: reqEnvelope.method,
                  url: reqEnvelope.url,
                  ts: new Date(t0).toISOString(),
                },
              },
            })
            if (isQualcommRequest) {
              log.info("qualcomm.http.request", {
                providerID: model.providerID,
                modelID: model.id,
                sessionID: sessionId,
                requestID: requestId,
                attempt,
                method: reqEnvelope.method,
                url: reqEnvelope.url,
              })
            }
            // ─────────────────────────────────────────────────────────────────────

            const res = await fetchFn(input, {
              ...opts,
              ...(transport?.proxy !== undefined ? { proxy: transport.proxy } : {}),
              ...(transport?.tls !== undefined ? { tls: transport.tls } : {}),
              timeout: false,
            }).catch((err: unknown) => {
              // Log transport error then rethrow
              const duration_ms = Date.now() - t0
              const errObj =
                err instanceof Error
                  ? { kind: err.name || "NetworkError", message: err.message, stack: err.stack }
                  : { kind: "NetworkError", message: String(err) }
              if (isQualcommRequest) {
                log.warn("qualcomm.http.error", {
                  providerID: model.providerID,
                  modelID: model.id,
                  sessionID: sessionId,
                  requestID: requestId,
                  attempt,
                  url: reqEnvelope.url,
                  duration_ms,
                  error: errObj.message,
                })
              }
              recordHttp({
                ts: new Date(t0).toISOString(),
                request_id: requestId,
                session_id: sessionId,
                parent_session_id: parentSessionId,
                message_id: messageId,
                attempt,
                parent_request_id: parentRequestId,
                provider_id: model.providerID,
                model_id: model.id,
                duration_ms,
                request: reqEnvelope,
                response: HttpSessionLog.buildResponse({
                  status: null,
                  headers: {},
                  bodyRaw: null,
                  streaming: false,
                  chunkCount: null,
                  firstChunkMs: null,
                  lastChunkMs: null,
                  partial: false,
                  aborted: err instanceof DOMException && err.name === "AbortError",
                  error: errObj,
                }),
              })
              throw err
            })

            // ── HTTP session logger: capture response ─────────────────────────────
            const isStreaming =
              res.headers.get("content-type")?.includes("text/event-stream") ||
              res.headers.get("transfer-encoding") === "chunked" ||
              !!chunkAbortCtl

            const respHeadersMap: Record<string, string> = {}
            res.headers.forEach((v: string, k: string) => {
              respHeadersMap[k] = v
            })
            if (isQualcommRequest) {
              const payload = {
                providerID: model.providerID,
                modelID: model.id,
                sessionID: sessionId,
                requestID: requestId,
                attempt,
                url: reqEnvelope.url,
                status: res.status,
                duration_ms: Date.now() - t0,
                retry_after: respHeadersMap["retry-after"] ?? null,
                retry_after_ms: respHeadersMap["retry-after-ms"] ?? null,
              }
              if (res.status === 429) log.warn("qualcomm.http.response", payload)
              else log.info("qualcomm.http.response", payload)
            }

            if (!isStreaming) {
              // Non-streaming: clone immediately before SDK consumes body
              const resForLog = res.clone()
              const duration_ms = Date.now() - t0
              resForLog
                .text()
                .then((bodyRaw: string) => {
                  recordHttp({
                    ts: new Date(t0).toISOString(),
                    request_id: requestId,
                    session_id: sessionId,
                    parent_session_id: parentSessionId,
                    message_id: messageId,
                    attempt,
                    parent_request_id: parentRequestId,
                    provider_id: model.providerID,
                    model_id: model.id,
                    duration_ms,
                    request: reqEnvelope,
                    response: HttpSessionLog.buildResponse({
                      status: res.status,
                      headers: respHeadersMap,
                      bodyRaw,
                      streaming: false,
                      chunkCount: null,
                      firstChunkMs: null,
                      lastChunkMs: null,
                      partial: false,
                      aborted: false,
                      error: null,
                    }),
                  })
                })
                .catch(() => {})

              if (!chunkAbortCtl) return res
              return wrapSSE(res, chunkTimeout, chunkAbortCtl)
            }

            // Streaming: tee the body so SDK and logger both get all chunks
            if (!res.body) {
              if (!chunkAbortCtl) return res
              return wrapSSE(res, chunkTimeout, chunkAbortCtl)
            }

            const [branchA, branchB] = res.body.tee()

            // Logger branch: consume branchB passively
            ;(async () => {
              const chunks: Uint8Array[] = []
              let chunkCount = 0
              let firstChunkMs: number | null = null
              let lastChunkMs: number | null = null
              let aborted = false
              let partial = false
              let errorObj: { kind: string; message: string; stack?: string } | null = null

              try {
                const reader = branchB.getReader()
                while (true) {
                  const { done, value } = await reader.read()
                  if (done) break
                  if (value) {
                    chunkCount++
                    const now = Date.now() - t0
                    if (firstChunkMs === null) firstChunkMs = now
                    lastChunkMs = now
                    chunks.push(value)
                  }
                }
              } catch (e) {
                partial = true
                aborted = e instanceof DOMException && e.name === "AbortError"
                errorObj =
                  e instanceof Error
                    ? { kind: e.name || "StreamError", message: e.message, stack: e.stack }
                    : { kind: "StreamError", message: String(e) }
              }

              const bodyRaw =
                chunks.length > 0
                  ? new TextDecoder().decode(
                      chunks.reduce((acc, c) => {
                        const merged = new Uint8Array(acc.length + c.length)
                        merged.set(acc)
                        merged.set(c, acc.length)
                        return merged
                      }, new Uint8Array(0)),
                    )
                  : null

              const duration_ms = Date.now() - t0
              recordHttp({
                ts: new Date(t0).toISOString(),
                request_id: requestId,
                session_id: sessionId,
                parent_session_id: parentSessionId,
                message_id: messageId,
                attempt,
                parent_request_id: parentRequestId,
                provider_id: model.providerID,
                model_id: model.id,
                duration_ms,
                request: reqEnvelope,
                response: HttpSessionLog.buildResponse({
                  status: res.status,
                  headers: respHeadersMap,
                  bodyRaw,
                  streaming: true,
                  chunkCount,
                  firstChunkMs,
                  lastChunkMs,
                  partial,
                  aborted,
                  error: errorObj,
                }),
              })
            })()

            // Return consumer branch (branchA) to SDK, wrapped by wrapSSE if needed
            const consumerResponse = new Response(branchA, {
              status: res.status,
              statusText: res.statusText,
              headers: res.headers,
            })

            if (!chunkAbortCtl) return consumerResponse
            return wrapSSE(consumerResponse, chunkTimeout, chunkAbortCtl)
          }

          const bundledFn = BUNDLED_PROVIDERS[model.api.npm]
          if (bundledFn) {
            log.info("using bundled provider", {
              providerID: model.providerID,
              pkg: model.api.npm,
            })
            const loaded = bundledFn({
              name: model.providerID,
              ...options,
            })
            s.sdk.set(key, loaded)
            return loaded as SDK
          }

          let installedPath: string
          if (!model.api.npm.startsWith("file://")) {
            const item = await Npm.add(model.api.npm)
            if (!item.entrypoint) throw new Error(`Package ${model.api.npm} has no import entrypoint`)
            installedPath = item.entrypoint
          } else {
            log.info("loading local provider", { pkg: model.api.npm })
            installedPath = model.api.npm
          }

          const mod = await import(installedPath)

          const fn = mod[Object.keys(mod).find((key) => key.startsWith("create"))!]
          const loaded = fn({
            name: model.providerID,
            ...options,
          })
          s.sdk.set(key, loaded)
          return loaded as SDK
        } catch (e) {
          throw new InitError({ providerID: model.providerID }, { cause: e })
        }
      }

      const getProvider = Effect.fn("Provider.getProvider")((providerID: ProviderID) =>
        InstanceState.use(state, (s) => s.providers[providerID]),
      )

      const getModel = Effect.fn("Provider.getModel")(function* (providerID: ProviderID, modelID: ModelID) {
        const s = yield* InstanceState.get(state)
        const provider = s.providers[providerID]
        if (!provider) {
          const available = Object.keys(s.providers)
          const matches = fuzzysort.go(providerID, available, { limit: 3, threshold: -10000 })
          throw new ModelNotFoundError({ providerID, modelID, suggestions: matches.map((m) => m.target) })
        }

        const info = provider.models[modelID]
        if (!info) {
          const available = Object.keys(provider.models)
          const matches = fuzzysort.go(modelID, available, { limit: 3, threshold: -10000 })
          throw new ModelNotFoundError({ providerID, modelID, suggestions: matches.map((m) => m.target) })
        }
        return info
      })

      const getLanguage = Effect.fn("Provider.getLanguage")(function* (model: Model) {
        const s = yield* InstanceState.get(state)
        const key = `${model.providerID}/${model.id}`
        if (s.models.has(key)) return s.models.get(key)!

        return yield* Effect.promise(async () => {
          const url = e2eURL()
          if (url) {
            const language = createOpenAICompatible({
              name: model.providerID,
              apiKey: "test-key",
              baseURL: url,
            }).chatModel(model.api.id)
            s.models.set(key, language)
            return language
          }

          const provider = s.providers[model.providerID]
          const sdk = await resolveSDK(model, s)

          try {
            const configuredLoaderBaseURL = firstNonEmptyString(
              provider.options?.endpoint,
              model.options?.endpoint,
              provider.options?.baseURL,
              model.options?.baseURL,
            )
            const normalizedLoaderBaseURL =
              (isQualcommProviderID(model.providerID)
                ? normalizeQualcommBaseURL(model.providerID, configuredLoaderBaseURL)
                : undefined) ?? configuredLoaderBaseURL
            const loaderOptions = {
              ...provider.options,
              ...model.options,
              ...(provider.key && { apiKey: provider.key }),
              ...(normalizedLoaderBaseURL ? { baseURL: normalizedLoaderBaseURL } : {}),
            }
            const language = s.modelLoaders[model.providerID]
              ? await s.modelLoaders[model.providerID](sdk, model.api.id, loaderOptions)
              : sdk.languageModel(model.api.id)
            s.models.set(key, language)
            return language
          } catch (e) {
            if (e instanceof NoSuchModelError)
              throw new ModelNotFoundError(
                {
                  modelID: model.id,
                  providerID: model.providerID,
                },
                { cause: e },
              )
            throw e
          }
        })
      })

      const closest = Effect.fn("Provider.closest")(function* (providerID: ProviderID, query: string[]) {
        const s = yield* InstanceState.get(state)
        const provider = s.providers[providerID]
        if (!provider) return undefined
        for (const item of query) {
          for (const modelID of Object.keys(provider.models)) {
            if (modelID.includes(item)) return { providerID, modelID }
          }
        }
        return undefined
      })

      const getSmallModel = Effect.fn("Provider.getSmallModel")(function* (providerID: ProviderID) {
        const cfg = yield* config.get()
        const s = yield* InstanceState.get(state)
        const provider = s.providers[providerID]
        if (!provider) return undefined

        const configuredModels = cfg.provider?.[providerID]?.models ?? {}
        const configuredTier2 = Object.entries(configuredModels)
          .filter(([, model]) => (model as { tier?: string } | undefined)?.tier === "tier2")
          .map(([modelID]) => modelID)

        for (const modelID of configuredTier2) {
          if (!provider.models[modelID]) continue
          if (providerID === ProviderID.amazonBedrock) {
            const crossRegionPrefixes = ["global.", "us.", "eu."]
            if (modelID.startsWith("global.")) return yield* getModel(providerID, ModelID.make(modelID))
            const region = provider.options?.region
            if (region) {
              const regionPrefix = region.split("-")[0]
              if ((regionPrefix === "us" || regionPrefix === "eu") && modelID.startsWith(`${regionPrefix}.`)) {
                return yield* getModel(providerID, ModelID.make(modelID))
              }
            }
            if (!crossRegionPrefixes.some((p) => modelID.startsWith(p)))
              return yield* getModel(providerID, ModelID.make(modelID))
            continue
          }
          return yield* getModel(providerID, ModelID.make(modelID))
        }

        return undefined
      })

      const defaultModel = Effect.fn("Provider.defaultModel")(function* () {
        const cfg = yield* config.get()

        // model_routing: if enabled, ask ModelRouter for orchestration-tier candidates.
        if (cfg.model_routing) {
          const candidates = yield* Effect.promise(async () => {
            const primary = await ModelRouter.select({ agentName: "orchestrator", config: cfg })
            if (primary.length > 0) return primary
            return ModelRouter.select({ config: cfg })
          })
          if (candidates.length > 0) {
            for (const item of candidates) {
              const exists = yield* getModel(item.providerID, item.modelID).pipe(Effect.exit)
              if (exists._tag === "Success") {
                log.info("defaultModel.router", { model: item.model, score: item.score })
                return { providerID: item.providerID, modelID: item.modelID }
              }
            }
          }
        }

        const s = yield* InstanceState.get(state)
        const recent = yield* Effect.promise(() =>
          Filesystem.readJson<{
            recent?: { providerID: ProviderID; modelID: ModelID }[]
          }>(path.join(Global.Path.state, "model.json"))
            .then((x): { providerID: ProviderID; modelID: ModelID }[] => (Array.isArray(x.recent) ? x.recent : []))
            .catch((): { providerID: ProviderID; modelID: ModelID }[] => []),
        )
        for (const entry of recent) {
          const provider = s.providers[entry.providerID]
          if (!provider) continue
          if (!provider.models[entry.modelID]) continue
          return { providerID: entry.providerID, modelID: entry.modelID }
        }

        const provider = Object.values(s.providers).find(
          (p) => !cfg.provider || Object.keys(cfg.provider).includes(p.id),
        )
        if (!provider) throw new Error("no providers found")
        const [model] = sort(Object.values(provider.models))
        if (!model) throw new Error("no models found")
        return {
          providerID: provider.id,
          modelID: model.id,
        }
      })

      return Service.of({ list, getProvider, getModel, getLanguage, closest, getSmallModel, defaultModel })
    }),
  )

  export const defaultLayer = Layer.suspend(() =>
    layer.pipe(Layer.provide(Config.defaultLayer), Layer.provide(Auth.defaultLayer)),
  )

  const { runPromise } = makeRuntime(Service, defaultLayer)

  export async function list() {
    return runPromise((svc) => svc.list())
  }

  export async function getProvider(providerID: ProviderID) {
    return runPromise((svc) => svc.getProvider(providerID))
  }

  export async function getModel(providerID: ProviderID, modelID: ModelID) {
    return runPromise((svc) => svc.getModel(providerID, modelID))
  }

  export async function getLanguage(model: Model) {
    return runPromise((svc) => svc.getLanguage(model))
  }

  export async function closest(providerID: ProviderID, query: string[]) {
    return runPromise((svc) => svc.closest(providerID, query))
  }

  export async function getSmallModel(providerID: ProviderID) {
    return runPromise((svc) => svc.getSmallModel(providerID))
  }

  export async function defaultModel() {
    return runPromise((svc) => svc.defaultModel())
  }

  export function sort<T extends { id: string }>(models: T[]) {
    return sortBy(models, [(model) => model.id, "asc"])
  }

  export function parseModel(model: string) {
    const [providerID, ...rest] = model.split("/")
    return {
      providerID: ProviderID.make(providerID),
      modelID: ModelID.make(rest.join("/")),
    }
  }

  export const ModelNotFoundError = NamedError.create(
    "ProviderModelNotFoundError",
    z.object({
      providerID: ProviderID.zod,
      modelID: ModelID.zod,
      suggestions: z.array(z.string()).optional(),
    }),
  )

  export const InitError = NamedError.create(
    "ProviderInitError",
    z.object({
      providerID: ProviderID.zod,
    }),
  )
}
