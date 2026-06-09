import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Session } from "@/process/session"
import { SessionID, MessageID, PartID } from "@/process/session/schema"
import { Instance } from "@/config/project/instance"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "@/process/session/message-v2"
import z from "zod"
import { Token } from "@/foundation/util/token"
import { buildCompactionPrompt } from "@/process/session/context-packet"
import { projectRoot } from "@/tool/notes/paths"
import { Log } from "@/foundation/util/log"
import { SessionProcessor } from "@/process/session/processor"
import { fn } from "@/foundation/util/fn"
import { Agent } from "@/agent/agent"
import { RuntimeRoles } from "@/agent/runtime-roles"
import { ProviderPluginHooks } from "@/provider/plugin-hooks"
import { Config } from "@/config/config"
import { NotFoundError } from "@/storage/db"
import { ModelID, ProviderID } from "@/provider/schema"
import { Effect, Layer, ServiceMap } from "effect"
import { makeRuntime } from "@/foundation/effect/run-service"
import { InstanceState } from "@/foundation/effect/instance-state"
import { isOverflow as overflow } from "@/process/session/overflow"
import { CompactionPrompt } from "@/process/session/compaction-prompt"
import { isOpusFamily } from "@/provider/transform"
import { ToolRegistry } from "@/tool/registry"
import { Permission } from "@/permission"
import { resolveCompactionTools } from "@/process/session/compaction-tools"

// ---------------------------------------------------------------------------
// Compaction model helpers
// ---------------------------------------------------------------------------

/**
 * Resolve one-hop fallback model for 403 / permission_error responses.
 *
 * Selection policy:
 *   1) Prefer top-level cfg.small_model when provider is enabled, model is
 *      registered under cfg.provider[providerID].models, and tier === "tier2".
 *   2) Else pick the first registered tier2 model from enabled providers.
 *   3) Else fail closed with a clear no-eligible-model error.
 */
function resolveCompactionForbiddenFallback(input: { cfg: Awaited<ReturnType<typeof Config.get>> }): {
  providerID: string
  modelID: string
} {
  const providerMap =
    (input.cfg.provider as Record<string, { models?: Record<string, { tier?: string }> }> | undefined) ?? {}
  const enabledProviders =
    input.cfg.enabled_providers && input.cfg.enabled_providers.length > 0
      ? input.cfg.enabled_providers.filter((providerID) => Boolean(providerMap[providerID]))
      : Object.keys(providerMap)
  const enabledSet = new Set(enabledProviders)

  const isEligibleTier2 = (providerID: string, modelID: string) => {
    if (!enabledSet.has(providerID)) return false
    return providerMap[providerID]?.models?.[modelID]?.tier === "tier2"
  }

  for (const providerID of enabledProviders) {
    const modelMap = providerMap[providerID]?.models ?? {}
    for (const [modelID, modelCfg] of Object.entries(modelMap)) {
      if (modelCfg.tier === "tier2") return { providerID, modelID }
    }
  }

  throw new Error("session.compaction: no eligible tier2 fallback model configured across enabled providers")
}

/** Returns true for 403 / permission_error responses from any provider. */
function isForbiddenError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false
  const e = err as Record<string, unknown>
  if (e["statusCode"] === 403) return true
  if (e["status"] === 403) return true
  const data = e["data"] as Record<string, unknown> | undefined
  if (data?.["error"] && typeof data["error"] === "object") {
    const errObj = data["error"] as Record<string, unknown>
    if (errObj["type"] === "permission_error") return true
  }
  return false
}

/**
 * Resolve the model to use for compaction, enforcing the Opus denylist.
 * Candidate models come from opencode.json agent/model routing config or the
 * current session model; prompt cards do not pin model IDs.
 */
function resolveCompactionModelID(input: {
  /** Ordered list from opencode.json agent config/model routing. */
  agentModels?: Array<{ providerID: string; modelID: string }>
  userModelID: string
  userProviderID: string
}): { providerID: string; modelID: string; downgraded: boolean } {
  const candidates: Array<{ providerID: string; modelID: string }> = []
  if (input.agentModels && input.agentModels.length > 0) candidates.push(...input.agentModels)
  candidates.push({ providerID: input.userProviderID, modelID: input.userModelID })

  for (const c of candidates) {
    if (!isOpusFamily(c.modelID)) return { ...c, downgraded: c !== candidates[0] }
  }
  // All candidates are Opus — throw so the caller can surface a clear error
  // rather than silently using a hardcoded model.
  throw new Error(
    `resolveCompactionModelID: all candidate models are Opus-family and cannot be used for compaction. ` +
      `Configure a non-Opus compaction candidate in opencode.json.`,
  )
}

export namespace SessionCompaction {
  const log = Log.create({ service: "session.compaction" })

  export const Event = {
    Compacted: BusEvent.define(
      "session.compacted",
      z.object({
        sessionID: SessionID.zod,
      }),
    ),
  }

  export const PRUNE_MINIMUM = 20_000
  export const PRUNE_PROTECT = 40_000

  // Phase 1b — two-category microcompact (mirror of
  // instructkr-claude-code/src/services/compact/apiMicrocompact.ts).
  //
  // PRUNE_CLEARABLE is an explicit allow-list of tools whose tool-result
  // outputs are cheap to recover (file_read can be re-read on demand, bash
  // can be re-run, grep/glob can be re-queried, web_* can be re-fetched).
  // Everything else is implicitly PROTECTED:
  //   * notes/todo/task/plan_* — durable coordination state
  //   * edit/write/multiedit/apply_patch — the call itself is the record of
  //     what changed; clearing the input would erase the model's edit memory
  //   * question — too small or stateful to bother clearing
  //
  // The previous one-line denylist cleared
  // every other tool's output, including file edit history. The allow-list
  // is more conservative: we only clear tools whose results we know are
  // recoverable, so the agent never loses track of what it did.
  const PRUNE_CLEARABLE = new Set<string>([
    // file inspection — re-readable on demand
    "read",
    "list",
    // search — re-queryable
    "grep",
    "glob",
    // shell — re-runnable (model usually knows the command)
    "bash",
    "bash_background",
  ])

  export interface Interface {
    readonly isOverflow: (input: {
      tokens: MessageV2.Assistant["tokens"]
      model: Provider.Model
    }) => Effect.Effect<boolean>
    readonly prune: (input: { sessionID: SessionID }) => Effect.Effect<void>
    readonly process: (input: {
      parentID: MessageID
      messages: MessageV2.WithParts[]
      sessionID: SessionID
      auto: boolean
      overflow?: boolean
    }) => Effect.Effect<"continue" | "stop">
    readonly create: (input: {
      sessionID: SessionID
      agent: string
      model: { providerID: ProviderID; modelID: ModelID }
      auto: boolean
      overflow?: boolean
    }) => Effect.Effect<void>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/SessionCompaction") {}

  export const layer: Layer.Layer<
    Service,
    never,
    | Bus.Service
    | Config.Service
    | Session.Service
    | Agent.Service
    | SessionProcessor.Service
    | Provider.Service
    | ToolRegistry.Service
    | Permission.Service
  > = Layer.effect(
    Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const config = yield* Config.Service
      const session = yield* Session.Service
      const agents = yield* Agent.Service
      const processors = yield* SessionProcessor.Service
      const provider = yield* Provider.Service
      const registry = yield* ToolRegistry.Service
      const permission = yield* Permission.Service
      const isOverflow = Effect.fn("SessionCompaction.isOverflow")(function* (input: {
        tokens: MessageV2.Assistant["tokens"]
        model: Provider.Model
      }) {
        return overflow({ cfg: yield* config.get(), tokens: input.tokens, model: input.model })
      })

      // Two-category microcompact (Phase 1b). Walks backwards through tool
      // parts until PRUNE_PROTECT tokens of recent tool output have been
      // skipped, then marks every PRUNE_CLEARABLE part further back as
      // compacted. The renderer (message-v2.ts) substitutes a sentinel
      // string for the cleared output and forwards the on-disk truncation
      // path when one is present, so the model can still rehydrate the
      // result via Read if needed.
      //
      // Tools NOT in PRUNE_CLEARABLE are implicitly protected — durable
      // notes, todo state, task delegations, and edit/write history all
      // stay verbatim regardless of how old they get.
      const prune = Effect.fn("SessionCompaction.prune")(function* (input: { sessionID: SessionID }) {
        const cfg = yield* config.get()
        if (cfg.compaction?.prune === false) return
        log.info("pruning")

        const msgs = yield* session
          .messages({ sessionID: input.sessionID })
          .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
        if (!msgs) return

        let total = 0
        let pruned = 0
        const toPrune: MessageV2.ToolPart[] = []
        let turns = 0

        loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
          const msg = msgs[msgIndex]
          if (msg.info.role === "user") turns++
          if (turns < 2) continue
          if (msg.info.role === "assistant" && msg.info.summary) break loop
          for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
            const part = msg.parts[partIndex]
            if (part.type === "tool")
              if (part.state.status === "completed") {
                // Tools not in the explicit clearable set are protected by
                // construction — durable state and edit history. Skip them
                // without affecting the running token total so the protect
                // window only counts genuinely-recoverable output.
                if (!PRUNE_CLEARABLE.has(part.tool)) continue
                if (part.state.time.compacted) break loop
                const output = part.state.output
                const estimate = Token.estimate(output)
                total += estimate
                if (total > PRUNE_PROTECT) {
                  pruned += estimate
                  toPrune.push(part)
                }
              }
          }
        }

        log.info("found", { pruned, total })
        if (pruned > PRUNE_MINIMUM) {
          for (const part of toPrune) {
            if (part.state.status === "completed") {
              part.state.time.compacted = Date.now()
              yield* session.updatePart(part)
            }
          }
          log.info("pruned", { count: toPrune.length, tools: toPrune.map((p) => p.tool) })
        }
      })

      const processCompaction = Effect.fn("SessionCompaction.process")(function* (input: {
        parentID: MessageID
        messages: MessageV2.WithParts[]
        sessionID: SessionID
        auto: boolean
        overflow?: boolean
      }) {
        const compactionStartTime = Date.now()
        // Lifecycle hook — fires BEFORE the compaction agent runs.
        yield* Effect.promise(() =>
          ProviderPluginHooks.notify("session.compact.before", {
            sessionID: input.sessionID,
            parentID: input.parentID,
            auto: input.auto,
            overflow: input.overflow,
          }),
        ).pipe(Effect.ignore)

        const parent = input.messages.findLast((m) => m.info.id === input.parentID)
        if (!parent || parent.info.role !== "user") {
          throw new Error(`Compaction parent must be a user message: ${input.parentID}`)
        }
        const userMessage = parent.info

        let messages = input.messages
        let replay:
          | {
              info: MessageV2.User
              parts: MessageV2.Part[]
            }
          | undefined
        if (input.overflow) {
          const idx = input.messages.findIndex((m) => m.info.id === input.parentID)
          for (let i = idx - 1; i >= 0; i--) {
            const msg = input.messages[i]
            if (msg.info.role === "user" && !msg.parts.some((p) => p.type === "compaction")) {
              replay = { info: msg.info, parts: msg.parts }
              messages = input.messages.slice(0, i)
              break
            }
          }
          const hasContent =
            replay && messages.some((m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction"))
          if (!hasContent) {
            replay = undefined
            messages = input.messages
          }
        }

        // Resolve via RuntimeRoles binding (cfg.runtime_roles.compaction → name).
        // Defaults to "compaction" — preserves prior behavior.
        const compactionAgentName = yield* Effect.promise(() => RuntimeRoles.resolve("compaction"))
        const agent = yield* agents.get(compactionAgentName)
        const resolved = resolveCompactionModelID({
          // Pass any opencode.json agent model list before falling back to the user model.
          agentModels: agent.models?.map((m) => ({ providerID: m.providerID, modelID: m.modelID })),
          userModelID: userMessage.model.modelID,
          userProviderID: userMessage.model.providerID,
        })
        if (resolved.downgraded) {
          log.warn("compaction.model.downgraded", {
            original: agent.model?.modelID ?? userMessage.model.modelID,
            using: resolved.modelID,
          })
        }
        const model = yield* provider.getModel(ProviderID.make(resolved.providerID), ModelID.make(resolved.modelID))
        // Allow plugins to inject context or replace compaction prompt.
        const compacting = yield* ProviderPluginHooks.triggerEffect(
          "experimental.session.compacting",
          { sessionID: input.sessionID },
          { context: [], prompt: undefined },
        )
        // Build task-note-centered context refresh packet (Stage 1b).
        // Falls back to the legacy broad summary if no task note is available.
        const taskNotePath = undefined
        const defaultPrompt = yield* Effect.promise(() =>
          buildCompactionPrompt({
            taskNotePath,
            notesRoot: projectRoot(),
          }),
        )

        // Wrap the notes-aware base prompt with the compact two-section handoff
        // template and tool-use guardrails. Plugin overrides bypass this on
        // purpose so experiments can ship raw prompts.
        const baseNotesAwarePrompt = [defaultPrompt, ...compacting.context].join("\n\n")
        const prompt = compacting.prompt ?? CompactionPrompt.build(baseNotesAwarePrompt)
        const msgs = structuredClone(messages)
        yield* ProviderPluginHooks.triggerEffect("experimental.chat.messages.transform", {}, { messages: msgs })
        const modelMessages = yield* MessageV2.toModelMessagesEffect(msgs, model, { stripMedia: true })
        const ctx = yield* InstanceState.context
        const msg: MessageV2.Assistant = {
          id: MessageID.ascending(),
          role: "assistant",
          parentID: input.parentID,
          sessionID: input.sessionID,
          mode: "compaction",
          agent: "compaction",
          variant: userMessage.variant,
          summary: true,
          path: {
            cwd: ctx.directory,
            root: ctx.worktree,
          },
          cost: 0,
          tokens: {
            output: 0,
            input: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: model.id,
          providerID: model.providerID,
          time: {
            created: Date.now(),
          },
        }
        yield* session.updateMessage(msg)
        const processor = yield* processors.create({
          assistantMessage: msg,
          sessionID: input.sessionID,
          model,
        })
        const sessionInfo = yield* session.get(input.sessionID)
        const tools = yield* resolveCompactionTools({
          agent,
          model,
          session: sessionInfo,
          processor,
          messages: msgs,
          sessionService: session,
          permission,
          registry,
        })
        const processInput = {
          user: userMessage,
          agent,
          sessionID: input.sessionID,
          tools,
          system: [CompactionPrompt.TOOL_USE_PREAMBLE],
          messages: [
            ...modelMessages,
            {
              role: "user" as const,
              content: [{ type: "text" as const, text: prompt }],
            },
          ],
          model,
          toolChoice: Object.keys(tools).length > 0 ? ("auto" as const) : ("none" as const),
        }
        const attempted: string[] = [model.id]
        // Wrap processor.process with 403 catch + one-hop downgrade to a
        // config-derived eligible tier2 fallback model. On a second 403
        // (the fallback also rejected), log compaction.skipped.double-403
        // and return "continue" (skip compaction non-fatally).
        const result = yield* processor
          .process(processInput)
          .pipe(Effect.onInterrupt(() => processor.abort()))
          .pipe(
            Effect.catchIf(isForbiddenError, () =>
              Effect.gen(function* () {
                // First 403 → one-hop downgrade to config-derived tier2 fallback.
                const fallback = resolveCompactionForbiddenFallback({ cfg: yield* Effect.promise(() => Config.get()) })
                log.warn("compaction.403.downgrade", {
                  from: { providerID: model.providerID, modelID: model.id },
                  to: { providerID: fallback.providerID, modelID: fallback.modelID },
                  attempted,
                })
                const fallbackModel = yield* provider.getModel(
                  ProviderID.make(fallback.providerID),
                  ModelID.make(fallback.modelID),
                )
                attempted.push(fallbackModel.id)
                const fallbackProcessor = yield* processors.create({
                  assistantMessage: msg,
                  sessionID: input.sessionID,
                  model: fallbackModel,
                })
                return yield* fallbackProcessor
                  .process({ ...processInput, model: fallbackModel })
                  .pipe(Effect.onInterrupt(() => fallbackProcessor.abort()))
                  .pipe(
                    Effect.catchIf(isForbiddenError, () =>
                      Effect.gen(function* () {
                        // Second 403 → skip compaction non-fatally.
                        log.warn("compaction.skipped.double-403", {
                          attempted,
                          reason: "primary + sonnet fallback both forbidden",
                        })
                        return "continue" as const
                      }),
                    ),
                  )
              }),
            ),
          )

        // Phase 1g — strip the <analysis> drafting scratchpad from any text
        // parts the model emitted before persisting the message. The summary
        // itself stays untouched; only the disposable analysis block is
        // removed so the next session sees only the final structured summary.
        if (result === "continue") {
          const finalParts = yield* session
            .messages({ sessionID: input.sessionID })
            .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed([] as MessageV2.WithParts[])))
          const compactionMsg = finalParts.findLast((m) => m.info.id === processor.message.id)
          if (compactionMsg) {
            for (const part of compactionMsg.parts) {
              if (part.type === "text" && typeof part.text === "string" && part.text.includes("<analysis>")) {
                const stripped = CompactionPrompt.stripAnalysis(part.text)
                if (stripped !== part.text) {
                  part.text = stripped
                  yield* session.updatePart(part)
                }
              }
            }
          }
        }

        if (result === "compact") {
          processor.message.error = MessageV2.AssistantError.parse(
            new MessageV2.ContextOverflowError({
              message: replay
                ? "Conversation history too large to compact - exceeds model context limit"
                : "Session too large to compact - context exceeds model limit even after stripping media",
            }).toObject(),
          )
          processor.message.finish = "error"
          yield* session.updateMessage(processor.message)
          return "stop"
        }

        if (result === "continue" && input.auto) {
          if (replay) {
            const original = replay.info
            const replayMsg = yield* session.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: input.sessionID,
              time: { created: Date.now() },
              agent: original.agent,
              model: original.model,
              format: original.format,
              tools: original.tools,
              system: original.system,
              variant: original.variant,
            })
            for (const part of replay.parts) {
              if (part.type === "compaction") continue
              const replayPart =
                part.type === "file" && MessageV2.isMedia(part.mime)
                  ? { type: "text" as const, text: `[Attached ${part.mime}: ${part.filename ?? "file"}]` }
                  : part
              yield* session.updatePart({
                ...replayPart,
                id: PartID.ascending(),
                messageID: replayMsg.id,
                sessionID: input.sessionID,
              })
            }
          }

          if (!replay) {
            const continueMsg = yield* session.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: input.sessionID,
              time: { created: Date.now() },
              agent: userMessage.agent,
              model: userMessage.model,
            })
            const text =
              (input.overflow
                ? "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n"
                : "") +
              "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: continueMsg.id,
              sessionID: input.sessionID,
              type: "text",
              synthetic: true,
              text,
              time: {
                start: Date.now(),
                end: Date.now(),
              },
            })
          }
        }

        // Lifecycle hook — fires AFTER compaction completes (success or stop).
        // Fire BEFORE the early return on error so plugins always observe the
        // final result, even when the message has an error attached.
        const finalResult: "compact" | "continue" | "stop" = processor.message.error ? "stop" : result
        yield* Effect.promise(() =>
          ProviderPluginHooks.notify("session.compact.after", {
            sessionID: input.sessionID,
            result: finalResult,
            durationMs: Date.now() - compactionStartTime,
          }),
        ).pipe(Effect.ignore)

        if (processor.message.error) return "stop"
        if (result === "continue") yield* bus.publish(Event.Compacted, { sessionID: input.sessionID })
        return result
      })

      const create = Effect.fn("SessionCompaction.create")(function* (input: {
        sessionID: SessionID
        agent: string
        model: { providerID: ProviderID; modelID: ModelID }
        auto: boolean
        overflow?: boolean
      }) {
        const msg = yield* session.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          model: input.model,
          sessionID: input.sessionID,
          agent: input.agent,
          time: { created: Date.now() },
        })
        yield* session.updatePart({
          id: PartID.ascending(),
          messageID: msg.id,
          sessionID: msg.sessionID,
          type: "compaction",
          auto: input.auto,
          overflow: input.overflow,
        })
      })

      return Service.of({
        isOverflow,
        prune,
        process: processCompaction,
        create,
      })
    }),
  )

  export const defaultLayer = Layer.unwrap(
    Effect.sync(() =>
      layer.pipe(
        Layer.provide(Provider.defaultLayer),
        Layer.provide(Session.defaultLayer),
        Layer.provide(SessionProcessor.defaultLayer),
        Layer.provide(Agent.defaultLayer),
        Layer.provide(ToolRegistry.defaultLayer),
        Layer.provide(Permission.defaultLayer),
        Layer.provide(Bus.layer),
        Layer.provide(Config.defaultLayer),
      ),
    ),
  )

  const { runPromise } = makeRuntime(Service, defaultLayer)

  export async function isOverflow(input: { tokens: MessageV2.Assistant["tokens"]; model: Provider.Model }) {
    return runPromise((svc) => svc.isOverflow(input))
  }

  export async function prune(input: { sessionID: SessionID }) {
    return runPromise((svc) => svc.prune(input))
  }

  export const process = fn(
    z.object({
      parentID: MessageID.zod,
      messages: z.custom<MessageV2.WithParts[]>(),
      sessionID: SessionID.zod,
      auto: z.boolean(),
      overflow: z.boolean().optional(),
    }),
    (input) => runPromise((svc) => svc.process(input)),
  )

  export const create = fn(
    z.object({
      sessionID: SessionID.zod,
      agent: z.string(),
      model: z.object({ providerID: ProviderID.zod, modelID: ModelID.zod }),
      auto: z.boolean(),
      overflow: z.boolean().optional(),
    }),
    (input) => runPromise((svc) => svc.create(input)),
  )
}
