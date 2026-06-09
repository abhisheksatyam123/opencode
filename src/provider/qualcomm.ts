import { randomBytes, randomUUID } from "node:crypto"
import { Env } from "@/filesystem/env"
import { Log } from "@/foundation/util/log"
import { resolveProviderRouteFamily, type ProviderRouteFamily } from "@/provider/route-family"
import { isGemini3LikeId, SKIP_THOUGHT_SIGNATURE } from "@/provider/support/gemini-thought-signature"
import { compactToolCallId } from "@/provider/tool-call-id"

const log = Log.create({ service: "provider" })

export function isCodexModel(modelID: string): boolean {
  return modelID.toLowerCase().includes("codex")
}

export type QualcommModelRoute = ProviderRouteFamily
export type QualcommProviderID = "qpilot" | "qgenie"
export type QualcommRouteConfig = {
  endpoint?: string
  npm?: string
}

export function qualcommModelRoute(
  providerID: string,
  modelID: string,
  config?: QualcommRouteConfig,
): QualcommModelRoute {
  if (providerID !== "qgenie" && providerID !== "qpilot") return "openai-chat"

  return resolveProviderRouteFamily({
    endpoint: config?.endpoint,
    npm: config?.npm,
    modelID,
  }).family
}

export function qualcommRouteForModel(model: {
  providerID: string
  api: { id: string }
  options?: { qualcommRoute?: QualcommRouteConfig }
}): QualcommModelRoute {
  return qualcommModelRoute(model.providerID, model.api.id, model.options?.qualcommRoute)
}

export function isQualcommOpenAIResponsesModel(model: {
  providerID: string
  api: { id: string }
  options?: { qualcommRoute?: QualcommRouteConfig }
}): boolean {
  return qualcommRouteForModel(model) === "openai-responses"
}

export function isQualcommVertexGeminiModelID(providerID: string, modelID: string): boolean {
  return isQualcommProviderID(providerID) && modelID.toLowerCase().startsWith("vertexai::gemini-")
}

export function inferQualcommReasoningCapability(
  providerID: string,
  modelID: string,
  config?: QualcommRouteConfig,
): boolean {
  if (!isQualcommProviderID(providerID)) return false
  const id = modelID.toLowerCase()
  const route = qualcommModelRoute(providerID, modelID, config)
  if (route === "openai-responses") {
    return id.includes("gpt-5") || id.includes("codex") || id.includes("o1") || id.includes("o3") || id.includes("o4")
  }
  if (route === "anthropic") {
    return id.includes("claude") || id.includes("anthropic")
  }
  return false
}

export function shouldUseQualcommResponsesApi(
  providerID: string,
  modelID: string,
  config?: QualcommRouteConfig,
): boolean {
  return qualcommModelRoute(providerID, modelID, config) === "openai-responses"
}

function normalizeQgenieMessageContent(content: unknown) {
  if (typeof content === "string") return [{ type: "input_text", text: content }]
  if (!Array.isArray(content)) return content

  return content.map((part) => {
    if (typeof part === "string") return { type: "input_text", text: part }
    if (!part || typeof part !== "object") return part
    const p = part as Record<string, unknown>
    if ("type" in part && p.type === "text" && typeof p.text === "string") {
      return { type: "input_text", text: p.text }
    }
    return part
  })
}

function normalizeQgenieResponsesInputItem(item: unknown) {
  if (!item || typeof item !== "object") return item
  const obj = item as Record<string, unknown>
  if ("type" in obj) return item
  if (!("role" in obj)) return item

  const role = obj.role === "system" ? "developer" : obj.role
  return {
    type: "message",
    role,
    content: normalizeQgenieMessageContent(obj.content),
  }
}

function normalizeQgenieResponsesTool(tool: unknown) {
  if (!tool || typeof tool !== "object") return tool
  const t = tool as Record<string, any>
  if (t.type !== "function") return tool
  if (!t.parameters && t.inputSchema) {
    return {
      ...t,
      parameters: t.inputSchema,
    }
  }
  return tool
}

// Exported for direct unit testing — see test/provider/qpilot-parse-body.test.ts.
// The contract is "only normalize top-level `input` and `tools` arrays;
// every other field passes through unchanged". Tests pin this contract
// because a future refactor that touches more fields could silently
// strip `prompt_cache_key` (or any other top-level extension) and break
// qpilot/qgenie session caching without surfacing as a runtime error.
export function normalizeQgenieResponsesBody(body: unknown) {
  if (!body || typeof body !== "object") return body
  const b = { ...(body as Record<string, any>) }
  if (Array.isArray(b.input)) {
    b.input = b.input.map(normalizeQgenieResponsesInputItem)
  }
  if (Array.isArray(b.tools)) {
    b.tools = b.tools.map(normalizeQgenieResponsesTool)
  }
  const modelID = typeof b.model === "string" ? b.model.toLowerCase() : ""
  const isReasoningModel =
    modelID.includes("gpt-5") || modelID.includes("codex") || modelID.includes("o1") || modelID.includes("o3")
  const includesEncryptedReasoning = Array.isArray(b.include) && b.include.includes("reasoning.encrypted_content")
  if (isReasoningModel && includesEncryptedReasoning && b.reasoning === undefined) {
    b.reasoning = { effort: "high", summary: "auto" }
  }
  return b
}

// Exported for direct unit testing — see test/provider/qpilot-parse-body.test.ts.
// Wraps `normalizeQgenieResponsesBody` for the three body shapes the
// fetch interceptor in `createQualcommResponsesModel` may receive
// (string, Uint8Array, ArrayBuffer). Always returns a string when the
// input was parseable, so the downstream `fetch` call ships JSON.
//
// IMPORTANT:
// Qualcomm `/responses` requests must strip the `previous_response_id` field
// and item `id` fields to prevent stale-reference errors from Azure.
//
// DO NOT drop `item_reference` entries here. The qpilot/qgenie proxy resolves
// item_references from its store. Dropping them causes a worse bug:
//   "No tool call found for function call output with call_id ..."
// because the function_call_output that follows the dropped item_reference
// becomes orphaned with no matching inline function_call.
//
// NOTE: The proxy does NOT resolve item_references indefinitely. On long sessions
// the proxy evicts old rs_*/fc_* IDs and returns 400 "Item with id '...' not found".
// That case is handled by a retry in createQualcommResponsesModel: on 400 item-not-found,
// the request is retried with dropItemReferences=true AND orphaned function_call_outputs
// also dropped. See the retry block in the inner fetch closure of createQualcommResponsesModel.
//
// What IS safe to drop: `previous_response_id` (can cause "Previous response
// not found" if the response was from a different session/context).
// What IS safe to strip: item `id` fields (Azure rejects stale item ids on
// inline items, but item_reference ids are resolved by the proxy, not Azure).
export function parseQgenieBody(body: unknown) {
  const sanitizeQualcommResponsesBody = (parsed: unknown) => {
    const normalized = normalizeQgenieResponsesBody(parsed)
    const sanitized = sanitizeResponsesInputBody(normalized, {
      keepItemIds: false,
      dropItemReferences: false, // DO NOT drop — proxy resolves them; dropping orphans function_call_output
      dropPreviousResponseId: true,
      maxCallIdLength: 64,
    })

    // Diagnostic logging: surface item_reference and function_call_output
    // counts so future regressions are visible in the log without needing
    // to decode the full request body.
    if (sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)) {
      const input = (sanitized as Record<string, any>).input
      if (Array.isArray(input)) {
        const itemRefs = input.filter((i: any) => i?.type === "item_reference").length
        const fcoCount = input.filter((i: any) => i?.type === "function_call_output").length
        const fcCount = input.filter((i: any) => i?.type === "function_call").length
        if (itemRefs > 0 || fcoCount > 0) {
          log.info("qualcomm.responses.sanitize", {
            item_references: itemRefs,
            function_calls: fcCount,
            function_call_outputs: fcoCount,
            // Warn if any function_call_output has no matching inline function_call —
            // this is the exact condition that caused Azure 400 before the fix.
            orphaned_outputs:
              fcoCount > 0
                ? (() => {
                    const callIds = new Set(
                      input
                        .filter((i: any) => i?.type === "function_call")
                        .map((i: any) => i?.call_id)
                        .filter(Boolean),
                    )
                    return input.filter((i: any) => i?.type === "function_call_output" && !callIds.has(i?.call_id))
                      .length
                  })()
                : 0,
          })
        }
      }
    }

    return sanitized
  }

  if (typeof body === "string") {
    const parsed = JSON.parse(body)
    return JSON.stringify(sanitizeQualcommResponsesBody(parsed))
  }
  if (body instanceof Uint8Array) {
    const parsed = JSON.parse(new TextDecoder().decode(body))
    return JSON.stringify(sanitizeQualcommResponsesBody(parsed))
  }
  if (body instanceof ArrayBuffer) {
    const parsed = JSON.parse(new TextDecoder().decode(new Uint8Array(body)))
    return JSON.stringify(sanitizeQualcommResponsesBody(parsed))
  }
  return body
}

type ResponsesInputSanitizerOptions = {
  keepItemIds?: boolean
  dropItemReferences?: boolean
  dropPreviousResponseId?: boolean
  maxCallIdLength?: number
}

/**
 * Normalize OpenAI Responses request bodies across provider adapters.
 *
 * Why this exists:
 * - Azure/OpenAI "item not found" errors are commonly caused by stale
 *   provider-scoped `id` references in `input`.
 * - qpilot/qgenie `/responses` can also carry stale `item_reference`
 *   entries after resumed sessions; those must be dropped defensively.
 */
export function sanitizeResponsesInputBody(body: unknown, options: ResponsesInputSanitizerOptions = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body
  const source = body as Record<string, any>

  let out: Record<string, any> | undefined
  const ensureOut = () => {
    if (!out) out = { ...source }
    return out
  }

  if (Array.isArray(source.input)) {
    const nextInput: unknown[] = []
    let inputChanged = false

    for (const raw of source.input) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        nextInput.push(raw)
        continue
      }

      const item = { ...(raw as Record<string, any>) }
      const isItemReference = item.type === "item_reference"
      if (options.dropItemReferences && isItemReference) {
        inputChanged = true
        continue
      }

      // Strip item `id` from inline items (stale ids cause Azure errors).
      // Never strip from item_reference entries — the id IS the reference.
      if (!options.keepItemIds && !isItemReference && "id" in item) {
        delete item.id
        inputChanged = true
      }

      if (
        options.maxCallIdLength &&
        (item.type === "function_call" || item.type === "function_call_output") &&
        typeof item.call_id === "string"
      ) {
        const compacted = compactToolCallId(item.call_id, options.maxCallIdLength)
        if (compacted !== item.call_id) {
          item.call_id = compacted
          inputChanged = true
        }
      }

      nextInput.push(item)
    }

    // When item_references are dropped, also drop any function_call_output whose
    // call_id has no matching inline function_call. These "orphaned" outputs arise
    // because the matching function_call was only present as an item_reference.
    // Sending orphaned outputs causes: "No tool call found for function call output".
    if (options.dropItemReferences) {
      const inlineCallIds = new Set(
        nextInput
          .filter((i: any) => i?.type === "function_call")
          .map((i: any) => i?.call_id)
          .filter(Boolean),
      )
      const beforeOrphanDrop = nextInput.length
      const withoutOrphans = nextInput.filter(
        (i: any) => i?.type !== "function_call_output" || inlineCallIds.has(i?.call_id),
      )
      if (withoutOrphans.length !== beforeOrphanDrop) {
        nextInput.length = 0
        nextInput.push(...withoutOrphans)
        inputChanged = true
      }
    }

    if (inputChanged) ensureOut().input = nextInput
  }

  if (options.dropPreviousResponseId) {
    if ("previous_response_id" in source) {
      delete ensureOut().previous_response_id
    }
    if ("previousResponseId" in source) {
      delete ensureOut().previousResponseId
    }
  }

  return out ?? body
}

export function decodeJsonBody(body: unknown): string | undefined {
  if (typeof body === "string") return body
  if (body instanceof Uint8Array) return new TextDecoder().decode(body)
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body))
  return undefined
}

function qualcommResponsesHeaders(providerID: string, modelID?: string) {
  const cliName =
    modelID && isCodexModel(modelID) ? "qgenie_cli" : providerID === "qpilot" ? "qpilot_cli" : "qgenie_cli"
  const turnID = randomUUID()
  return {
    originator: "codex_cli_rs",
    version: "0.1.12",
    "user-agent": `x86_64 / linux / terminal / ${cliName} / 0.1.12`,
    session_id: randomUUID(),
    "x-codex-beta-features": "multi_agent",
    "x-codex-turn-metadata": JSON.stringify({ turn_id: turnID, sandbox: "none" }),
    "x-encrypted-key": randomBytes(32).toString("hex"),
  }
}

export function qualcommApiKey(providerID: string, options?: Record<string, any>) {
  const configured = options?.apiKey ?? options?.authToken
  if (typeof configured === "string" && configured.length > 0 && configured !== "unused") return configured

  const envNames = providerID === "qgenie" || providerID === "qpilot" ? ["QPILOT_API_KEY"] : []
  for (const envName of envNames) {
    const value = Env.get(envName)
    if (value) return value
  }
}

export function normalizeQualcommBaseURL(providerID: "qpilot" | "qgenie", input: unknown): string | undefined {
  if (typeof input !== "string") return undefined
  const raw = input.trim()
  if (!raw) return undefined

  const fromHost = providerID === "qpilot" ? "qgenie-api.qualcomm.com" : "qpilot-api.qualcomm.com"
  const toHost = providerID === "qpilot" ? "qpilot-api.qualcomm.com" : "qgenie-api.qualcomm.com"
  if (!raw.toLowerCase().includes(fromHost)) return raw

  // Guard against cross-wired public Qualcomm endpoints:
  // selecting qpilot must not hit qgenie host (and vice versa).
  try {
    const url = new URL(raw)
    if (url.hostname.toLowerCase() === fromHost) {
      url.hostname = toHost
      return url.toString()
    }
  } catch {
    // Non-URL input: fall through to safe string replacement.
  }

  return raw.replace(new RegExp(fromHost, "ig"), toHost)
}

export function isQualcommProviderID(providerID: string): providerID is "qpilot" | "qgenie" {
  return providerID === "qpilot" || providerID === "qgenie"
}

export function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue
    const trimmed = value.trim()
    if (!trimmed) continue
    return trimmed
  }
  return undefined
}

export function qualcommHeaders(
  providerID: string,
  modelID: string,
  options?: Record<string, any>,
  authMode: "sdk" | "bearer" = "sdk",
) {
  const explicitHeaders = (options?.headers ?? {}) as Record<string, string>
  const authHeaders: Record<string, string> = {}
  if (authMode === "bearer" && options?.apiKey && !explicitHeaders.authorization && !explicitHeaders.Authorization) {
    authHeaders.Authorization = `Bearer ${options.apiKey}`
  }
  return {
    ...qualcommResponsesHeaders(providerID, modelID),
    ...authHeaders,
    ...explicitHeaders,
  }
}

export function isQualcommGeminiVertexModelID(modelID: string) {
  return isGemini3LikeId(modelID)
}

export function injectQualcommVertexThoughtSignatures(providerID: string, modelID: string, body: unknown) {
  if (providerID !== "qpilot" && providerID !== "qgenie") return body
  if (!isQualcommGeminiVertexModelID(modelID)) return body
  if (!body || typeof body !== "object") return body

  const messages = (body as { messages?: unknown }).messages
  if (!Array.isArray(messages)) return body

  for (const message of messages) {
    if (!message || typeof message !== "object") continue
    if ((message as { role?: unknown }).role !== "assistant") continue
    const toolCalls = (message as { tool_calls?: unknown }).tool_calls
    if (!Array.isArray(toolCalls)) continue

    for (const toolCall of toolCalls) {
      if (!toolCall || typeof toolCall !== "object") continue
      const record = toolCall as Record<string, any>
      if (!record.function || typeof record.function !== "object") continue
      const extra = record.extra_content && typeof record.extra_content === "object" ? record.extra_content : {}
      const google = extra.google && typeof extra.google === "object" ? extra.google : {}
      if (typeof google.thought_signature === "string" && google.thought_signature.length > 0) continue
      record.extra_content = {
        ...extra,
        google: {
          ...google,
          thought_signature: SKIP_THOUGHT_SIGNATURE,
        },
      }
    }
  }

  return body
}
