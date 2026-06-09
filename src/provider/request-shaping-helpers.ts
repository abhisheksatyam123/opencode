import type { ModelMessage } from "ai"
import type { JSONSchema7 } from "@ai-sdk/provider"
import type { Provider } from "@/provider/provider"
import type { ModelsDev } from "@/provider/models"
import { compactToolCallId } from "@/provider/tool-call-id"
import type { QualcommModelRoute } from "@/provider/qualcomm"
import {
  isQualcommOpenAIResponsesModel,
  isQualcommVertexGeminiModelID,
  qualcommRouteForModel,
} from "@/provider/qualcomm"

type Modality = NonNullable<ModelsDev.Model["modalities"]>["input"][number]

function mapToolCallIdsInMessages(msgs: ModelMessage[], mapID: (id: string) => string): ModelMessage[] {
  return msgs.map((msg): ModelMessage => {
    if ((msg.role === "assistant" || msg.role === "tool") && Array.isArray(msg.content)) {
      return {
        ...msg,
        content: msg.content.map((part) => {
          if ((part.type === "tool-call" || part.type === "tool-result") && "toolCallId" in part) {
            return { ...part, toolCallId: mapID((part as { toolCallId: string }).toolCallId) }
          }
          return part
        }),
      } as ModelMessage
    }
    return msg
  })
}

function mimeToModality(mime: string): Modality | undefined {
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("audio/")) return "audio"
  if (mime.startsWith("video/")) return "video"
  if (mime === "application/pdf") return "pdf"
  return undefined
}

// Maps npm package to the key the AI SDK expects for providerOptions
export function sdkKey(npm: string): string | undefined {
  switch (npm) {
    case "@ai-sdk/github-copilot":
      return "copilot"
    case "@ai-sdk/azure":
      return "azure"
    case "@ai-sdk/openai":
      return "openai"
    case "@ai-sdk/amazon-bedrock":
      return "bedrock"
    case "@ai-sdk/anthropic":
    case "@ai-sdk/google-vertex/anthropic":
      return "anthropic"
    case "@ai-sdk/google-vertex":
      return "vertex"
    case "@ai-sdk/google":
      return "google"
    case "@ai-sdk/gateway":
      return "gateway"
    case "@openrouter/ai-sdk-provider":
      return "openrouter"
  }
  return undefined
}

export type QualcommRoute = QualcommModelRoute

export function qualcommRoute(model: Pick<Provider.Model, "providerID" | "api" | "id" | "options">): QualcommRoute {
  return qualcommRouteForModel(model)
}

export function isQualcommOpenAIResponsesRoute(
  model: Pick<Provider.Model, "providerID" | "api" | "id" | "options">,
): boolean {
  return isQualcommOpenAIResponsesModel(model)
}

// Predicate: true for qpilot/qgenie models routed to Vertex AI Gemini.
// Reused by schemaBucket, the strict nested sanitizer wiring, and the
// rejectsTopLevelSchemaKeywords gate so all three stay in sync.
export function isQualcommVertexGeminiModel(model: Pick<Provider.Model, "providerID" | "api">): boolean {
  return isQualcommVertexGeminiModelID(model.providerID, model.api.id)
}

function removeEmptyAnthropicMessages(msgs: ModelMessage[]): ModelMessage[] {
  // Anthropic rejects messages with empty content - filter out empty string messages
  // and remove empty text/reasoning parts from array content.
  return msgs
    .map((msg) => {
      if (typeof msg.content === "string") return msg.content === "" ? undefined : msg
      if (!Array.isArray(msg.content)) return msg

      const filtered = msg.content.filter((part) => {
        if (part.type === "text" || part.type === "reasoning") return part.text !== ""
        return true
      })
      return filtered.length === 0 ? undefined : { ...msg, content: filtered }
    })
    .filter((msg): msg is ModelMessage => msg !== undefined && msg.content !== "")
}

function normalizeMistralMessages(msgs: ModelMessage[]): ModelMessage[] {
  const scrub = (id: string) =>
    id
      .replace(/[^a-zA-Z0-9]/g, "")
      .substring(0, 9)
      .padEnd(9, "0")
  const result: ModelMessage[] = []

  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i]
    const nextMsg = msgs[i + 1]

    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      msg.content = msg.content.map((part) => {
        if (part.type === "tool-call" || part.type === "tool-result")
          return { ...part, toolCallId: scrub(part.toolCallId) }
        return part
      })
    }
    if (msg.role === "tool" && Array.isArray(msg.content)) {
      msg.content = msg.content.map((part) => {
        if (part.type === "tool-result") return { ...part, toolCallId: scrub(part.toolCallId) }
        return part
      })
    }
    result.push(msg)

    // Fix message sequence: tool messages cannot be followed by user messages.
    if (msg.role === "tool" && nextMsg?.role === "user") {
      result.push({ role: "assistant", content: [{ type: "text", text: "Done." }] })
    }
  }

  return result
}

function moveInterleavedReasoningToProviderOptions(msgs: ModelMessage[], field: string): ModelMessage[] {
  return msgs.map((msg) => {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) return msg

    const reasoningParts = msg.content.filter((part: any) => part.type === "reasoning")
    const reasoningText = reasoningParts.map((part: any) => part.text).join("")
    const filteredContent = msg.content.filter((part: any) => part.type !== "reasoning")
    if (!reasoningText) return { ...msg, content: filteredContent }

    // Include reasoning_content | reasoning_details directly on the message for all assistant messages.
    return {
      ...msg,
      content: filteredContent,
      providerOptions: {
        ...msg.providerOptions,
        openaiCompatible: {
          ...(msg.providerOptions?.["openaiCompatible"] as
            | Record<string, import("@ai-sdk/provider").JSONValue>
            | undefined),
          [field]: reasoningText,
        },
      },
    }
  })
}

function isMistralFamily(model: Provider.Model): boolean {
  return (
    model.providerID === "mistral" ||
    model.api.id.toLowerCase().includes("mistral") ||
    model.api.id.toLocaleLowerCase().includes("devstral")
  )
}

export function normalizeMessages(
  msgs: ModelMessage[],
  model: Provider.Model,
  options: Record<string, unknown>,
): ModelMessage[] {
  if (model.api.npm === "@ai-sdk/anthropic" || model.api.npm === "@ai-sdk/amazon-bedrock") {
    msgs = removeEmptyAnthropicMessages(msgs)
  }

  if (model.api.id.includes("claude")) {
    const scrub = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_")
    return mapToolCallIdsInMessages(msgs, (id) => compactToolCallId(id, 64, { scrub }))
  }

  if (model.api.npm === "@ai-sdk/azure") {
    // Azure OpenAI enforces short tool call IDs. Preserve linkage while
    // compacting with a hash suffix to avoid prefix-collision bugs.
    return mapToolCallIdsInMessages(msgs, (id) => compactToolCallId(id, 40))
  }

  if ((model.providerID === "qpilot" || model.providerID === "qgenie") && isQualcommOpenAIResponsesRoute(model)) {
    // Qualcomm Azure/OpenAI Responses routes reject replayed upstream tool IDs
    // longer than 64 chars (e.g. qpilot Vertex Gemini can emit ~1KB call IDs).
    return mapToolCallIdsInMessages(msgs, (id) => compactToolCallId(id, 64))
  }

  if (isMistralFamily(model)) return normalizeMistralMessages(msgs)

  const interleaved = model.capabilities.interleaved
  if (typeof interleaved === "object" && interleaved.field) {
    return moveInterleavedReasoningToProviderOptions(msgs, interleaved.field)
  }

  return msgs
}

export function unsupportedParts(msgs: ModelMessage[], model: Provider.Model): ModelMessage[] {
  return msgs.map((msg) => {
    if (msg.role !== "user" || !Array.isArray(msg.content)) return msg

    const filtered = msg.content.map((part) => {
      if (part.type !== "file" && part.type !== "image") return part

      // Check for empty base64 image data
      if (part.type === "image") {
        const imageStr = part.image.toString()
        if (imageStr.startsWith("data:")) {
          const match = imageStr.match(/^data:([^;]+);base64,(.*)$/)
          if (match && (!match[2] || match[2].length === 0)) {
            return {
              type: "text" as const,
              text: "ERROR: Image file is empty or corrupted. Please provide a valid image.",
            }
          }
        }
      }

      const mime = part.type === "image" ? part.image.toString().split(";")[0].replace("data:", "") : part.mediaType
      const filename = part.type === "file" ? part.filename : undefined
      const modality = mimeToModality(mime)
      if (!modality) return part
      if (model.capabilities.input[modality]) return part

      const name = filename ? `"${filename}"` : modality
      return {
        type: "text" as const,
        text: `ERROR: Cannot read ${name} (this model does not support ${modality} input). Inform the user.`,
      }
    })

    return { ...msg, content: filtered }
  })
}

// Recursive sanitizer for qpilot/qgenie Vertex Gemini schemas.
//
// Vertex AI Gemini (served via the Qualcomm proxy) rejects tool parameter
// schemas that contain anyOf / oneOf / allOf / enum / not at ANY depth —
// not just at the top level. The existing sanitizeGemini pass handles the
// google/gemini bucket (integer enum → string, missing array items, etc.)
// but does NOT strip combiners at nested depth.
//
// Strategy: forbidden-key denylist — drop only the provider-rejected or
// provider-unsupported keys Vertex AI Gemini rejects on this route;
// preserve all other keys (additionalProperties, format, minimum, maximum,
// description, $ref, type, …). Recurse into every object value and every
// element of array values so the invariant holds at every depth. Nested
// anyOf/oneOf/allOf collapses to the first recursively sanitized branch; if
// a property node would otherwise become schema-empty after stripping, fall
// back to an explicit safe type inferred from the stripped schema shape.
//
// Non-target providers are never touched — the caller gates on
// isQualcommVertexGeminiModel().
// NOTE: plain `ref` (without `$`) is intentionally forbidden on this route.
// `$ref` stays allowed and is handled via schemaIntentKeys.
const qualcommVertexGeminiPlainRefKeyword = "ref" as const
const forbiddenQualcommVertexGeminiNestedSchemaKeys: ReadonlySet<string> = new Set([
  "anyOf",
  "oneOf",
  "allOf",
  "enum",
  "not",
  "const",
  "propertyNames",
  qualcommVertexGeminiPlainRefKeyword,
])

const schemaIntentKeys: ReadonlySet<string> = new Set([
  "type",
  "properties",
  "items",
  "prefixItems",
  "enum",
  "const",
  "$ref",
  "additionalProperties",
  "patternProperties",
  "required",
  "not",
  "if",
  "then",
  "else",
])

function isPlainSchemaObject(node: unknown): node is Record<string, any> {
  return typeof node === "object" && node !== null && !Array.isArray(node)
}

function hasSchemaIntent(node: unknown): boolean {
  if (!isPlainSchemaObject(node)) return false
  if (Array.isArray(node.anyOf) || Array.isArray(node.oneOf) || Array.isArray(node.allOf)) return true
  return [...schemaIntentKeys].some((key) => key in node)
}

function isBareEmptySchemaObject(node: unknown): node is Record<string, any> {
  return isPlainSchemaObject(node) && Object.keys(node).length === 0
}

function fallbackQualcommVertexGeminiSchema(out: any, propertyContext: boolean): any | undefined {
  if (isBareEmptySchemaObject(out)) {
    return { type: "string" }
  }

  if (propertyContext && !hasSchemaIntent(out)) {
    return out.description !== undefined ? { description: out.description, type: "string" } : { type: "string" }
  }

  return undefined
}

function normalizeQualcommVertexGeminiArrayItems(out: Record<string, any>): void {
  if (out.type !== "array") return

  if (out.items == null) out.items = {}
  if (isPlainSchemaObject(out.items) && !hasSchemaIntent(out.items)) {
    out.items.type = "string"
  }
}

function removeQualcommVertexGeminiObjectKeywordsFromScalar(out: Record<string, any>): void {
  if (!out.type || out.type === "object" || qualcommVertexGeminiCombinerKey(out)) return

  // Remove properties/required from non-object types (Gemini rejects these)
  delete out.properties
  delete out.required
}

function hasQualcommVertexGeminiProperties(out: Record<string, any>): boolean {
  return isPlainSchemaObject(out.properties) && Object.keys(out.properties).length > 0
}

function pruneQualcommVertexGeminiRequired(out: Record<string, any>): void {
  if (!Array.isArray(out.required)) return

  out.required = out.required.filter((field: any) => field in out.properties)
  if (out.required.length === 0) delete out.required
}

function normalizeQualcommVertexGeminiObjectShape(out: Record<string, any>): void {
  if (out.type !== "object") return

  if (hasQualcommVertexGeminiProperties(out)) {
    pruneQualcommVertexGeminiRequired(out)
    return
  }

  delete out.properties
  delete out.required
}

function normalizeQualcommVertexGeminiSchema(out: any, propertyContext: boolean): any {
  const fallback = fallbackQualcommVertexGeminiSchema(out, propertyContext)
  if (fallback) return fallback

  normalizeQualcommVertexGeminiArrayItems(out)
  removeQualcommVertexGeminiObjectKeywordsFromScalar(out)
  normalizeQualcommVertexGeminiObjectShape(out)

  return out
}

function qualcommVertexGeminiCombinerKey(node: Record<string, any>): "anyOf" | "oneOf" | "allOf" | undefined {
  return (["anyOf", "oneOf", "allOf"] as const).find((key) => Array.isArray(node[key]))
}

function sanitizeQualcommVertexGeminiValue(key: string, val: any): any {
  if (key === "additionalProperties" && isBareEmptySchemaObject(val)) return true
  if (val === null || typeof val !== "object") return val

  const sanitizedValue = sanitizeQualcommVertexGemini(val, false)
  return key === "additionalProperties" && isBareEmptySchemaObject(sanitizedValue) ? true : sanitizedValue
}

function sanitizeQualcommVertexGeminiProperties(val: Record<string, any>): Record<string, any> | undefined {
  const props: Record<string, any> = {}
  for (const [propKey, propValue] of Object.entries(val)) {
    const sanitizedProp = sanitizeQualcommVertexGemini(propValue, true)
    if (!isBareEmptySchemaObject(sanitizedProp)) props[propKey] = sanitizedProp
  }
  return Object.keys(props).length > 0 ? props : undefined
}

function sanitizeQualcommVertexGeminiCombiner(
  node: Record<string, any>,
  combinerKey: "anyOf" | "oneOf" | "allOf",
  propertyContext: boolean,
): any {
  const branches = node[combinerKey] as unknown[] // verified by qualcommVertexGeminiCombinerKey
  const selected = branches.length > 0 ? sanitizeQualcommVertexGemini(branches[0], propertyContext) : undefined
  const out: Record<string, any> = isPlainSchemaObject(selected) ? { ...selected } : {}

  for (const [key, val] of Object.entries(node)) {
    if (key === combinerKey || forbiddenQualcommVertexGeminiNestedSchemaKeys.has(key)) continue
    if (key === "properties" || key === "required") continue
    if (key in out && (val === null || typeof val !== "object")) continue
    out[key] = sanitizeQualcommVertexGeminiValue(key, val)
  }

  return normalizeQualcommVertexGeminiSchema(out, propertyContext)
}

function sanitizeQualcommVertexGeminiObject(node: Record<string, any>, propertyContext: boolean): any {
  const out: Record<string, any> = {}

  for (const [key, val] of Object.entries(node)) {
    if (forbiddenQualcommVertexGeminiNestedSchemaKeys.has(key)) continue
    if (key === "properties" && isPlainSchemaObject(val)) {
      const props = sanitizeQualcommVertexGeminiProperties(val)
      if (props) out[key] = props
      continue
    }
    out[key] = sanitizeQualcommVertexGeminiValue(key, val)
  }

  return normalizeQualcommVertexGeminiSchema(out, propertyContext)
}

export function sanitizeQualcommVertexGemini(node: any, propertyContext = false): any {
  if (node === null || typeof node !== "object") return node
  if (Array.isArray(node)) return node.map((item) => sanitizeQualcommVertexGemini(item, false))
  if (!isPlainSchemaObject(node)) return node

  const combinerKey = qualcommVertexGeminiCombinerKey(node)
  if (combinerKey) return sanitizeQualcommVertexGeminiCombiner(node, combinerKey, propertyContext)
  return sanitizeQualcommVertexGeminiObject(node, propertyContext)
}

type SchemaCacheBucket = WeakMap<object, JSONSchema7>

export function schemaBucket(model: Provider.Model): "gemini" | "qualcommVertexGemini" | "passthrough" {
  if (isQualcommVertexGeminiModel(model)) return "qualcommVertexGemini"
  if (model.providerID === "google" || model.api.id.includes("gemini")) return "gemini"
  return "passthrough"
}

export const schemaCache: {
  gemini: SchemaCacheBucket
  qualcommVertexGemini: SchemaCacheBucket
  passthrough: SchemaCacheBucket
} = {
  gemini: new WeakMap(),
  qualcommVertexGemini: new WeakMap(),
  passthrough: new WeakMap(),
}

// ── Gemini schema sanitizer ──────────────────────────────────────────────────
// Handles google/gemini bucket: integer enum→string, missing array items,
// non-object cleanup. Called before the anyOf-flatten pass.
function sanitizeGeminiSchemaObject(obj: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (key === "enum" && Array.isArray(value)) {
      result[key] = value.map((v) => String(v))
      if (result.type === "integer" || result.type === "number") result.type = "string"
      continue
    }
    result[key] = typeof value === "object" && value !== null ? sanitizeGeminiSchema(value) : value
  }
  return result
}

function normalizeGeminiObjectRequired(result: Record<string, any>) {
  if (result.type !== "object" || !result.properties || !Array.isArray(result.required)) return
  result.required = result.required.filter((field: any) => field in result.properties)
}

function ensureGeminiArrayItems(result: Record<string, any>) {
  if (result.type !== "array" || hasCombiner(result)) return
  if (result.items == null) result.items = {}
  if (isPlainSchemaObject(result.items) && !hasSchemaIntent(result.items)) result.items.type = "string"
}

function removeGeminiNonObjectProperties(result: Record<string, any>) {
  if (!result.type || result.type === "object" || hasCombiner(result)) return
  delete result.properties
  delete result.required
}

export function sanitizeGeminiSchema(obj: any): any {
  if (obj === null || typeof obj !== "object") return obj
  if (Array.isArray(obj)) return obj.map(sanitizeGeminiSchema)

  const result = sanitizeGeminiSchemaObject(obj)
  normalizeGeminiObjectRequired(result)
  ensureGeminiArrayItems(result)
  removeGeminiNonObjectProperties(result)
  return result
}

function hasCombiner(node: unknown): boolean {
  if (!isPlainSchemaObject(node)) return false
  return Array.isArray(node["anyOf"]) || Array.isArray(node["oneOf"]) || Array.isArray(node["allOf"])
}

// ── anyOf/oneOf/allOf flattener ──────────────────────────────────────────────
// Merges combiner branches into a single object schema for providers that
// reject top-level anyOf/oneOf/allOf (Anthropic, Bedrock, qpilot/qgenie Azure).

type Leaf = { props: Record<string, JSONSchema7>; required: string[]; addlProps?: boolean | JSONSchema7 }

function collectLeaf(node: JSONSchema7): Leaf {
  if (node.allOf) {
    return (node.allOf as JSONSchema7[]).reduce<Leaf>(
      (acc, sub) => {
        const leaf = collectLeaf(sub)
        Object.assign(acc.props, leaf.props)
        acc.required.push(...leaf.required)
        if (leaf.addlProps !== undefined) acc.addlProps = leaf.addlProps
        return acc
      },
      { props: {}, required: [] },
    )
  }
  return {
    props: (node.properties as Record<string, JSONSchema7>) ?? {},
    required: (node.required as string[]) ?? [],
    addlProps: node.additionalProperties as boolean | JSONSchema7 | undefined,
  }
}

export function flattenAnyOfSchema(result: JSONSchema7): JSONSchema7 {
  const branches = (result.anyOf ?? result.oneOf ?? result.allOf ?? []) as JSONSchema7[]
  const merged: Record<string, JSONSchema7> = {}
  const requiredSets: Set<string>[] = []
  let additionalProperties: boolean | JSONSchema7 | undefined
  for (const branch of branches) {
    const leaf = collectLeaf(branch)
    for (const [key, value] of Object.entries(leaf.props)) {
      const existing = merged[key]
      if (!existing) {
        merged[key] = value
        continue
      }
      const existingConst = existing.const
      const nextConst = value.const
      if (existingConst !== undefined && nextConst !== undefined && existingConst !== nextConst) {
        const priorValues = Array.isArray(existing.enum) ? existing.enum : [existingConst]
        const values = new Set([...priorValues, nextConst])
        merged[key] = { ...existing, enum: [...values], const: undefined } as JSONSchema7
      }
    }
    requiredSets.push(new Set(leaf.required))
    if (leaf.addlProps !== undefined) additionalProperties = leaf.addlProps
  }
  return {
    type: "object",
    properties: merged,
    ...(requiredSets.length > 0 && {
      required: [...requiredSets[0]!].filter((field) => requiredSets.every((set) => set.has(field))),
    }),
    ...(additionalProperties !== undefined && { additionalProperties }),
    ...(result.$schema && { $schema: result.$schema }),
  }
}
