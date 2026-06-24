import { Provider } from "@/provider/provider"
import { Log } from "@/foundation/util/log"
import { Cause, Effect, Layer, Record, ServiceMap } from "effect"
import * as Queue from "effect/Queue"
import * as Stream from "effect/Stream"
import { streamText, wrapLanguageModel, type ModelMessage, type Tool, tool, jsonSchema } from "ai"
import { mergeDeep, pipe } from "remeda"
import { GitLabWorkflowLanguageModel } from "gitlab-ai-provider"
import { ProviderTransform } from "@/provider/transform"
import { Config } from "@/config/config"
import { Instance } from "@/config/project/instance"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "@/process/session/message-v2"
import { ProviderPluginHooks } from "@/provider/plugin-hooks"
import { Flag } from "@/foundation/flag/flag"
import { Permission } from "@/permission"
import { Auth } from "@/init/auth"
import { Installation } from "@/init/installation"
import { ContextManagement } from "@/process/session/context-management"
import { TokenEstimate } from "@/process/session/token-estimate"
import { getCompactionReservedTokens, getCompactionTriggerTokens } from "@/process/session/overflow"
import * as Upstream from "@/provider/upstream"
import { normalizeProviderQualifiedToolName } from "@/tool/name"

export namespace LLM {
  const log = Log.create({ service: "llm" })
  export const OUTPUT_TOKEN_MAX = ProviderTransform.OUTPUT_TOKEN_MAX

  export type StreamInput = {
    user: MessageV2.User
    sessionID: string
    parentSessionID?: string
    model: Provider.Model
    agent: Agent.Info
    permission?: Permission.Ruleset
    system: string[]
    messages: ModelMessage[]
    small?: boolean
    tools: Record<string, Tool>
    retries?: number
    toolChoice?: "auto" | "required" | "none"
    attempt?: number
    parentRequestId?: string
  }

  export type StreamRequest = StreamInput & {
    abort: AbortSignal
  }

  export type Event = Awaited<ReturnType<typeof stream>>["fullStream"] extends AsyncIterable<infer T> ? T : never

  export interface Interface {
    readonly stream: (input: StreamInput) => Stream.Stream<Event, unknown>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/LLM") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      return Service.of({
        stream(input) {
          return Stream.scoped(
            Stream.unwrap(
              Effect.gen(function* () {
                const ctrl = yield* Effect.acquireRelease(
                  Effect.sync(() => new AbortController()),
                  (ctrl) => Effect.sync(() => ctrl.abort()),
                )

                const result = yield* Effect.promise(() => LLM.stream({ ...input, abort: ctrl.signal }))

                return Stream.fromAsyncIterable(result.fullStream, (e) =>
                  e instanceof Error ? e : new Error(String(e)),
                )
              }),
            ),
          )
        },
      })
    }),
  )

  export const defaultLayer = layer

  export async function stream(input: StreamRequest) {
    const l = log
      .clone()
      .tag("providerID", input.model.providerID)
      .tag("modelID", input.model.id)
      .tag("sessionID", input.sessionID)
      .tag("small", (input.small ?? false).toString())
      .tag("agent", input.agent.name)
      .tag("mode", input.agent.mode)
    l.info("stream", {
      modelID: input.model.id,
      providerID: input.model.providerID,
    })
    const [language, cfg, provider, auth] = await Promise.all([
      Provider.getLanguage(input.model),
      Config.get(),
      Provider.getProvider(input.model.providerID),
      Auth.get(input.model.providerID),
    ])
    // ARCH-DEBT: OpenAI OAuth detection belongs in a provider hook, not inline here.
    // Move to Provider.getProvider() or a dedicated auth-capability query once the
    // provider hook API is stable enough to carry per-provider capability flags.
    const isOpenaiOauth = provider.id === "openai" && auth?.type === "oauth"

    const system: string[] = []
    const systemJoined = [
      ...(input.agent.prompt ? [input.agent.prompt] : []),
      // any custom prompt passed into this call
      ...input.system,
      // any custom prompt from last user message
      ...(input.user.system ? [input.user.system] : []),
    ]
      .filter((x) => x)
      .join("\n")
    // Bedrock (and Anthropic) reject system messages with empty text.
    // Only push when the joined string is non-empty.
    if (systemJoined) system.push(systemJoined)

    // System prompt policy: only shared agent prompt + task/user-specific additions.
    // Do NOT apply model-specific system prompt transforms here.

    const variant =
      !input.small && input.model.variants && input.user.variant ? input.model.variants[input.user.variant] : {}
    const base = input.small
      ? ProviderTransform.smallOptions(input.model)
      : ProviderTransform.options({
          model: input.model,
          sessionID: input.sessionID,
          providerOptions: provider.options,
        })
    const options: Record<string, any> = pipe(
      base,
      mergeDeep(input.model.options),
      mergeDeep(input.agent.options),
      mergeDeep(variant),
    )
    if (isOpenaiOauth) {
      options.instructions = system.join("\n")
    }

    const isWorkflow = language instanceof GitLabWorkflowLanguageModel
    const messages = isOpenaiOauth
      ? input.messages
      : isWorkflow
        ? input.messages
        : [
            ...system.map(
              (x): ModelMessage => ({
                role: "system",
                content: x,
              }),
            ),
            ...input.messages,
          ]

    const maxOutputTokens =
      isOpenaiOauth || provider.id.includes("github-copilot")
        ? undefined
        : ProviderTransform.maxOutputTokens(input.model)

    const params = await ProviderPluginHooks.trigger(
      "chat.params",
      {
        sessionID: input.sessionID,
        agent: input.agent.name,
        model: input.model,
        provider,
        message: input.user,
      },
      {
        temperature: input.model.capabilities.temperature
          ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
          : undefined,
        topP: input.agent.topP ?? ProviderTransform.topP(input.model),
        topK: ProviderTransform.topK(input.model),
        maxOutputTokens,
        options,
      },
    )

    // Phase 1a — provider-side context-management dispatch. The registry in
    // session/context-management.ts walks every registered strategy and
    // returns the first one that claims this model (or undefined when no
    // strategy applies). Today only the Anthropic clear_tool_uses_20250919
    // beta is wired; other providers fall through to opencode's existing
    // client-side compaction path. The call site is provider-blind: it
    // merges the strategy's options at the TOP of params.options and lets
    // ProviderTransform.providerOptions wrap them under the model's SDK
    // key automatically.
    const ctxManagement = ContextManagement.build({ model: input.model, cfg })
    if (ctxManagement) {
      params.options = { ...params.options, ...ctxManagement.options }
      l.info("context-management enabled", { strategy: ctxManagement.name })
    }

    // Upstream-aware cache headers (X-Opencode-Cache-*) for proxy providers
    // (qpilot/qgenie). Built BEFORE the chat.headers plugin trigger so plugins
    // can still override or extend them. Header-based hints ride alongside
    // body-field hints so a proxy with strict body validation still receives
    // the cache intent via headers. See provider/upstream.ts for the per-
    // upstream strategy.
    const upstreamCacheHeaders = Upstream.buildCacheHeaders({
      model: input.model,
      sessionID: input.sessionID,
    })

    const { headers } = await ProviderPluginHooks.trigger(
      "chat.headers",
      {
        sessionID: input.sessionID,
        agent: input.agent.name,
        model: input.model,
        provider,
        message: input.user,
      },
      {
        headers: { ...upstreamCacheHeaders } as Record<string, string>,
      },
    )

    const tools = await resolveTools(input)

    // Phase 1d — pre-call token estimate. Cheap heuristic check that the
    // request is not about to overflow the model context window. We log the
    // estimate vs. usable so the prompt loop can act on it (or future
    // proactive-compaction wiring can read it from logs/metrics). For now
    // this is a non-blocking observation: the existing reactive overflow
    // catch in the prompt loop still handles the failure case if the
    // estimate is wrong.
    try {
      const est = TokenEstimate.wouldOverflow({
        system,
        messages: input.messages,
        tools,
        model: input.model,
        reservedTokens: getCompactionReservedTokens(cfg, input.model),
        triggerTokens: getCompactionTriggerTokens(cfg),
      })
      if (est.overflow) {
        l.warn("pre-call token estimate exceeds usable context", {
          estimated: est.estimated,
          usable: est.usable,
          messages: input.messages.length,
          tools: Object.keys(tools).length,
        })
      } else if (est.estimated > est.usable * 0.85) {
        l.info("pre-call token estimate near usable context", {
          estimated: est.estimated,
          usable: est.usable,
          pct: Math.round((est.estimated / est.usable) * 100),
        })
      }
    } catch (err) {
      // Estimation is best-effort — never break the request path.
      l.warn("token estimate failed", { err: (err as Error)?.message })
    }

    // LiteLLM and some Anthropic proxies require the tools parameter to be present
    // when message history contains tool calls, even if no tools are being used.
    // Add a dummy tool that is never called to satisfy this validation.
    // This is enabled for:
    // 1. Providers with "litellm" in their ID or API ID (auto-detected)
    // 2. Providers with explicit "litellmProxy: true" option (opt-in for custom gateways)
    const isLiteLLMProxy =
      provider.options?.["litellmProxy"] === true ||
      input.model.providerID.toLowerCase().includes("litellm") ||
      input.model.api.id.toLowerCase().includes("litellm")

    // LiteLLM/Bedrock rejects requests where the message history contains tool
    // calls but no tools param is present. When there are no active tools (e.g.
    // during compaction), inject a stub tool to satisfy the validation requirement.
    // The stub description explicitly tells the model not to call it.
    if (isLiteLLMProxy && Object.keys(tools).length === 0 && hasToolCalls(input.messages)) {
      tools["_noop"] = tool({
        description: "Do not call this tool. It exists only for API compatibility and must never be invoked.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            reason: { type: "string", description: "Unused" },
          },
        }),
        execute: async () => ({ output: "", title: "", metadata: {} }),
      })
    }

    // Wire up toolExecutor for DWS workflow models so that tool calls
    // from the workflow service are executed via opencode's tool system
    // and results sent back over the WebSocket.
    if (language instanceof GitLabWorkflowLanguageModel) {
      const workflowModel = language
      workflowModel.systemPrompt = system.join("\n")
      workflowModel.toolExecutor = async (toolName, argsJson, _requestID) => {
        const t = tools[toolName]
        if (!t || !t.execute) {
          return { result: "", error: `Unknown tool: ${toolName}` }
        }
        try {
          const result = await t.execute!(JSON.parse(argsJson), {
            toolCallId: _requestID,
            messages: input.messages,
            abortSignal: input.abort,
          })
          const output = typeof result === "string" ? result : (result?.output ?? JSON.stringify(result))
          return {
            result: output,
            metadata: typeof result === "object" ? result?.metadata : undefined,
            title: typeof result === "object" ? result?.title : undefined,
          }
        } catch (e: any) {
          return { result: "", error: e.message ?? String(e) }
        }
      }
    }

    return streamText({
      onError(error) {
        l.error("stream error", {
          error,
        })
      },
      async experimental_repairToolCall(failed) {
        const normalized = normalizeProviderQualifiedToolName(failed.toolCall.toolName, Object.keys(tools))
        if (normalized !== failed.toolCall.toolName && tools[normalized]) {
          l.info("repairing provider-qualified tool call", {
            tool: failed.toolCall.toolName,
            repaired: normalized,
          })
          return {
            ...failed.toolCall,
            toolName: normalized,
          }
        }

        const lower = failed.toolCall.toolName.toLowerCase()
        if (lower !== failed.toolCall.toolName && tools[lower]) {
          l.info("repairing tool call", {
            tool: failed.toolCall.toolName,
            repaired: lower,
          })
          return {
            ...failed.toolCall,
            toolName: lower,
          }
        }
        return null
      },
      allowSystemInMessages: true,
      temperature: params.temperature,
      topP: params.topP,
      topK: params.topK,
      providerOptions: ProviderTransform.providerOptions(input.model, params.options),
      activeTools: Object.keys(tools),
      tools,
      toolChoice: input.toolChoice,
      maxOutputTokens: params.maxOutputTokens,
      abortSignal: input.abort,
      headers: {
        ...(input.model.providerID.startsWith("opencode")
          ? {
              "x-opencode-project": Instance.project.id,
              "x-opencode-session": input.sessionID,
              "x-opencode-request": input.user.id,
              "x-opencode-client": Flag.OPENCODE_CLIENT,
            }
          : {
              "x-session-affinity": input.sessionID,
              ...(input.parentSessionID ? { "x-parent-session-id": input.parentSessionID } : {}),
              "User-Agent": `opencode/${Installation.VERSION}`,
            }),
        ...(input.attempt !== undefined && input.attempt > 0
          ? {
              "x-opencode-attempt": String(input.attempt),
              ...(input.parentRequestId ? { "x-opencode-parent-request-id": input.parentRequestId } : {}),
            }
          : {}),
        ...input.model.headers,
        ...headers,
      },
      maxRetries: input.retries ?? 0,
      messages,
      model: wrapLanguageModel({
        model: language,
        middleware: [
          {
            specificationVersion: "v3" as const,
            async transformParams(args) {
              if (args.type === "stream") {
                // @ts-expect-error
                args.params.prompt = ProviderTransform.message(
                  args.params.prompt,
                  input.model,
                  options,
                  input.sessionID,
                )
              }
              return args.params
            },
          },
        ],
      }),
      experimental_telemetry: {
        isEnabled: cfg.experimental?.openTelemetry,
        metadata: {
          userId: cfg.username ?? "unknown",
          sessionId: input.sessionID,
        },
      },
    })
  }

  function resolveTools(input: Pick<StreamInput, "tools" | "agent" | "permission" | "user">) {
    const disabled = Permission.disabled(
      Object.keys(input.tools),
      Permission.merge(input.agent.permission, input.permission ?? []),
    )
    return Record.filter(input.tools, (_, k) => input.user.tools?.[k] !== false && !disabled.has(k))
  }

  // Check if messages contain any tool-call content
  // Used to determine if a dummy tool should be added for LiteLLM proxy compatibility
  export function hasToolCalls(messages: ModelMessage[]): boolean {
    for (const msg of messages) {
      if (!Array.isArray(msg.content)) continue
      for (const part of msg.content) {
        if (part.type === "tool-call" || part.type === "tool-result") return true
      }
    }
    return false
  }
}
