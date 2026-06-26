import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { MessageV2 } from "@/process/session/message-v2"
import { Token } from "@/foundation/util/token"
import { TokenAttribution } from "@/process/session/token-attribution"
import z from "zod"

export const TokenCounts = z.object({
  input: z.number(),
  output: z.number(),
  reasoning: z.number(),
  cache: z.object({
    read: z.number(),
    write: z.number(),
  }),
})

export function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

export function normalizeTokens(value: unknown): z.infer<typeof TokenCounts> {
  const root = record(value)
  const cache = record(root.cache)
  return {
    input: numeric(root.input),
    output: numeric(root.output),
    reasoning: numeric(root.reasoning),
    cache: {
      read: numeric(cache.read),
      write: numeric(cache.write),
    },
  }
}

export function tokenTotal(tokens: z.infer<typeof TokenCounts>) {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

export function promptTokenTotal(tokens: z.infer<typeof TokenCounts>) {
  return tokens.input + tokens.cache.read + tokens.cache.write
}

type ContextComponent = { name: string; tokens: number; detail?: string }

function addContextComponent(map: Map<string, ContextComponent>, name: string, tokens: number, detail?: string) {
  if (!Number.isFinite(tokens) || tokens <= 0) return
  const rounded = Math.round(tokens)
  const existing = map.get(name)
  if (existing) {
    existing.tokens += rounded
    if (detail && !existing.detail) existing.detail = detail
  } else {
    map.set(name, { name, tokens: rounded, detail })
  }
}

function estimateString(value: unknown) {
  if (typeof value !== "string" || value.length === 0) return 0
  return Token.estimate(value)
}

function estimateJson(value: unknown) {
  try {
    return Token.estimate(JSON.stringify(value) ?? "")
  } catch {
    return Token.estimate(String(value ?? ""))
  }
}

export async function calculateEstimatedTotal(
  messages: MessageV2.WithParts[],
  model: Provider.Model | undefined,
  latestUser: MessageV2.User | undefined,
  inputs?: {
    envStable?: string[]
    envVolatile?: string
    agentPrompt?: string
  },
) {
  const components = new Map<string, ContextComponent>()

  if (inputs?.envStable) {
    addContextComponent(
      components,
      "system prompt",
      inputs.envStable.reduce((sum: number, part: string) => sum + estimateString(part), 0),
      "environment",
    )
  }
  if (inputs?.envVolatile) {
    addContextComponent(components, "system prompt", estimateString(inputs.envVolatile), "environment")
  }
  if (inputs?.agentPrompt) {
    addContextComponent(components, "system prompt", estimateString(inputs.agentPrompt), "agent")
  }
  if (latestUser?.system) {
    addContextComponent(components, "system prompt", estimateString(latestUser.system), "custom")
  }

  for (const message of messages) {
    if (message.info.role === "user") {
      addContextComponent(components, "summaries", estimateString(message.info.summary?.body), "compaction")
    }
    for (const part of message.parts) {
      if (part.type === "text") {
        addContextComponent(
          components,
          message.info.role === "user" ? "user input" : "assistant text",
          estimateString(part.text),
        )
        continue
      }
      if (part.type === "reasoning") {
        addContextComponent(components, "assistant reasoning", estimateString(part.text))
        continue
      }
      if (part.type === "file") {
        addContextComponent(
          components,
          "files",
          estimateString(part.source?.text.value) || estimateString(part.filename),
        )
        continue
      }
      if (part.type === "agent") {
        addContextComponent(
          components,
          "agent mentions",
          estimateString(part.name) + estimateString(part.source?.value),
        )
        continue
      }
      if (part.type === "patch") {
        addContextComponent(components, "patches", estimateJson(part.files))
        continue
      }
      if (part.type === "snapshot") {
        addContextComponent(components, "snapshots", estimateString(part.snapshot))
      }
    }
  }

  const tools = TokenAttribution.analyze(messages)
  addContextComponent(components, "tool calls", tools.totalTokens, `${tools.totalCalls} calls`)

  const estimatedTotal = Array.from(components.values()).reduce((sum, part) => sum + part.tokens, 0)
  return { estimatedTotal, components, tools }
}

export async function contextWindowStats(input: {
  messages: MessageV2.WithParts[]
  providers: Record<string, Provider.Info>
  triggerTokens?: number
  envStable?: string[]
  envVolatile?: string
  agentPrompt?: string
}) {
  const infos = input.messages.map((msg) => msg.info)
  const latestAssistant = infos
    .filter((msg): msg is MessageV2.Assistant => msg.role === "assistant")
    .toSorted((a, b) => b.time.created - a.time.created)[0]
  const latestUser = infos
    .filter((msg): msg is MessageV2.User => msg.role === "user")
    .toSorted((a, b) => b.time.created - a.time.created)[0]

  const providerID = latestAssistant?.providerID ?? latestUser?.model.providerID ?? ""
  const modelID = latestAssistant?.modelID ?? latestUser?.model.modelID ?? ""
  const model = providerID && modelID ? input.providers[providerID]?.models[modelID] : undefined
  const hardLimit = model?.limit.context || undefined
  const outputReserve = model ? ProviderTransform.maxOutputTokens(model) : undefined
  const inputLimit = model
    ? model.limit.input ||
      (hardLimit && outputReserve !== undefined ? Math.max(0, hardLimit - outputReserve) : undefined)
    : undefined
  const triggerTokens = input.triggerTokens ?? 0

  const softLimit = triggerTokens > 0 && inputLimit
    ? Math.min(Math.floor(inputLimit * 0.8), triggerTokens)
    : inputLimit
      ? Math.floor(inputLimit * 0.8)
      : undefined

  const { estimatedTotal, components, tools } = await calculateEstimatedTotal(input.messages, model, latestUser, {
    envStable: input.envStable,
    envVolatile: input.envVolatile,
    agentPrompt: input.agentPrompt,
  })

  let estimatedBase = estimatedTotal
  if (latestAssistant) {
    const latestAssistantIndex = input.messages.findIndex(
      (msg) => msg.info.role === "assistant" && msg.info.id === latestAssistant.id
    )
    if (latestAssistantIndex !== -1) {
      const baseMessages = input.messages.slice(0, latestAssistantIndex + 1)
      const baseUser = baseMessages
        .map((msg) => msg.info)
        .filter((msg): msg is MessageV2.User => msg.role === "user")
        .toSorted((a, b) => b.time.created - a.time.created)[0]
      const { estimatedTotal: baseTotal } = await calculateEstimatedTotal(baseMessages, model, baseUser, {
        envStable: input.envStable,
        envVolatile: input.envVolatile,
        agentPrompt: input.agentPrompt,
      })
      estimatedBase = baseTotal
    }
  }

  const estimatedNew = Math.max(0, estimatedTotal - estimatedBase)
  const latestTokens = latestAssistant ? normalizeTokens(latestAssistant.tokens) : undefined
  const exactBase = latestTokens
    ? promptTokenTotal(latestTokens) + latestTokens.output
    : 0

  const used = exactBase
    ? exactBase + estimatedNew
    : estimatedTotal

  const assistantMessages = input.messages.filter((msg) => msg.info.role === "assistant")
  const callCount = assistantMessages.length
  const toolCallsByAssistant = assistantMessages.map((msg) => msg.parts.filter((part) => part.type === "tool").length)
  const totalToolCalls = toolCallsByAssistant.reduce((sum, calls) => sum + calls, 0)
  const maxToolCallsPerLLM = toolCallsByAssistant.reduce((max, calls) => Math.max(max, calls), 0)
  const avgToolCallsPerLLM = callCount > 0 ? Math.round((totalToolCalls / callCount) * 10) / 10 : 0
  const avgCallTokens = callCount > 0 ? Math.round(estimatedTotal / callCount) : 0

  const availableHard = hardLimit ? Math.max(0, hardLimit - used) : undefined
  const availableInput = inputLimit ? Math.max(0, inputLimit - used) : undefined
  const availableSoft = softLimit ? Math.max(0, softLimit - used) : undefined
  const usedPctHard = hardLimit ? Math.round((used / hardLimit) * 100) : undefined
  const usedPctInput = inputLimit ? Math.round((used / inputLimit) * 100) : undefined
  const usedPctSoft = softLimit ? Math.round((used / softLimit) * 100) : undefined
  const pctBase = Math.max(1, used)

  return {
    providerID: providerID || undefined,
    modelID: modelID || undefined,
    modelName: model?.name,
    hardLimit,
    inputLimit,
    outputReserve,
    softLimit,
    used,
    availableHard,
    availableInput,
    availableSoft,
    usedPctHard,
    usedPctInput,
    usedPctSoft,
    estimatedTotal,
    callCount,
    avgCallTokens,
    totalToolCalls,
    totalToolCallTokens: tools.totalTokens,
    avgToolCallsPerLLM,
    maxToolCallsPerLLM,
    components: Array.from(components.values())
      .toSorted((a, b) => b.tokens - a.tokens)
      .map((part) => ({
        ...part,
        pct: Math.round((part.tokens / pctBase) * 1000) / 10,
      })),
    tools: tools.tools.slice(0, 8),
  }
}

export function addTokens(target: z.infer<typeof TokenCounts>, next: z.infer<typeof TokenCounts>) {
  target.input += next.input
  target.output += next.output
  target.reasoning += next.reasoning
  target.cache.read += next.cache.read
  target.cache.write += next.cache.write
}
