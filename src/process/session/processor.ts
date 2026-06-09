import { Cause, Duration, Effect, Layer, Schedule, ServiceMap } from "effect"
import * as Stream from "effect/Stream"
import { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { ProviderPluginHooks } from "@/provider/plugin-hooks"
import { Snapshot } from "@/storage/snapshot"
import { Log } from "@/foundation/util/log"
import { Session } from "@/process/session"
import { LLM } from "@/process/session/llm"
import { MessageV2 } from "@/process/session/message-v2"
import { isOverflow } from "@/process/session/overflow"
import { PartID } from "@/process/session/schema"
import type { SessionID } from "@/process/session/schema"
import { SessionRetry } from "@/process/session/retry"
import { SessionStatus } from "@/process/session/status"
import { SessionSummary } from "@/process/session/summary"
import { Provider } from "@/provider/provider"
import { ModelRouter } from "@/provider/model-router"
import { DelegationHealthState } from "@/provider/delegation-health-state"
import type { ModelID, ProviderID } from "@/provider/schema"

export namespace SessionProcessor {
  const DOOM_LOOP_THRESHOLD = 3
  const log = Log.create({ service: "session.processor" })

  export type Result = "compact" | "stop" | "continue"

  export type Event = LLM.Event

  export interface Handle {
    readonly message: MessageV2.Assistant
    readonly partFromToolCall: (toolCallID: string) => MessageV2.ToolPart | undefined
    readonly abort: () => Effect.Effect<void>
    readonly process: (streamInput: LLM.StreamInput) => Effect.Effect<Result>
  }

  type Input = {
    assistantMessage: MessageV2.Assistant
    sessionID: SessionID
    model: Provider.Model
    modelFallbacks?: { providerID: ProviderID; modelID: ModelID }[]
  }

  export interface Interface {
    readonly create: (input: Input) => Effect.Effect<Handle>
  }

  interface ProcessorContext extends Input {
    toolcalls: Record<string, MessageV2.ToolPart>
    shouldBreak: boolean
    snapshot: string | undefined
    blocked: boolean
    needsCompaction: boolean
    currentText: MessageV2.TextPart | undefined
    reasoningMap: Record<string, MessageV2.ReasoningPart>
    attemptStartMs?: number
    ttftMs?: number
    inputTokens?: number
  }

  function record(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object"
  }

  function streamErrorCode(error: unknown, parseError: (error: unknown) => unknown) {
    const parsed = parseError(error)
    if (record(parsed)) {
      const data = parsed.data
      if (record(data) && data.statusCode !== undefined) return String(data.statusCode)
      if (typeof parsed.name === "string") return parsed.name
    }
    return typeof error === "string" ? error : undefined
  }

  function inferTaskType(agentName: string, inputTokens?: number, toolCallsCount?: number): string {
    if (agentName === "title" || agentName === "compaction" || agentName === "halt-auditor") {
      return "chat_simple"
    }
    if (agentName === "adviser" || agentName === "orchestrator") {
      if (inputTokens && inputTokens > 20000) return "chat_long_context"
      return "chat_simple"
    }
    if (agentName === "planner") {
      return "plan_design"
    }
    if (agentName === "implementer") {
      if (inputTokens && inputTokens > 40000) return "code_patch_large"
      return "code_patch_small"
    }
    if (agentName === "searcher" || agentName === "worker") {
      if (toolCallsCount && toolCallsCount > 1) return "tool_multi"
      return "tool_single"
    }
    return "chat_simple"
  }

  type StreamEvent = Event

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/SessionProcessor") {}

  export const layer: Layer.Layer<
    Service,
    never,
    | Session.Service
    | Config.Service
    | Bus.Service
    | Snapshot.Service
    | Agent.Service
    | LLM.Service
    | Permission.Service
    | SessionStatus.Service
  > = Layer.effect(
    Service,
    Effect.gen(function* () {
      const session = yield* Session.Service
      const config = yield* Config.Service
      const bus = yield* Bus.Service
      const snapshot = yield* Snapshot.Service
      const agents = yield* Agent.Service
      const llm = yield* LLM.Service
      const permission = yield* Permission.Service
      const status = yield* SessionStatus.Service

      const create = Effect.fn("SessionProcessor.create")(function* (input: Input) {
        // Pre-capture snapshot before the LLM stream starts. The AI SDK
        // may execute tools internally before emitting start-step events,
        // so capturing inside the event handler can be too late.
        const initialSnapshot = yield* snapshot.track()
        const ctx: ProcessorContext = {
          assistantMessage: input.assistantMessage,
          sessionID: input.sessionID,
          model: input.model,
          toolcalls: {},
          shouldBreak: false,
          snapshot: initialSnapshot,
          blocked: false,
          needsCompaction: false,
          currentText: undefined,
          reasoningMap: {},
        }
        let aborted = false
        let pauseRequested = false
        let currentModel = input.model
        let fallbackIndex = 0
        const selectedProviderID = String(input.model.providerID)
        // Hard guard: fallback attempts must remain on the selected provider.
        // This prevents qpilot-selected runs from drifting onto qgenie (and vice versa).
        const fallbacks = (input.modelFallbacks ?? []).filter((f) => String(f.providerID) === selectedProviderID)

        const unsubPause = Bus.subscribe(Bus.SubagentPause, (event) => {
          if (event.properties.sessionID === input.sessionID) {
            pauseRequested = true
          }
        })

        const unsubModelChange = Bus.subscribe(Bus.SubagentModelChange, (event) => {
          if (event.properties.sessionID === input.sessionID) {
            const parsed = Provider.parseModel(event.properties.model)
            Provider.getModel(parsed.providerID, parsed.modelID)
              .then((resolved) => {
                currentModel = resolved
              })
              .catch(() => {
                // If model can't be resolved, keep current model
              })
          }
        })

        const unsubResume = Bus.subscribe(Bus.SubagentResume, (event) => {
          if (event.properties.sessionID === input.sessionID) {
            pauseRequested = false
            Effect.runPromise(status.set(input.sessionID, { type: "busy" }))
            Effect.runPromise(bus.publish(Bus.SubagentResumed, { sessionID: input.sessionID }))
          }
        })

        const parse = (e: unknown) =>
          MessageV2.fromError(e, {
            providerID: input.model.providerID,
            aborted,
          })

        const handleEvent = Effect.fn("SessionProcessor.handleEvent")(function* (value: StreamEvent) {
          if (
            ctx.ttftMs === undefined &&
            ctx.attemptStartMs !== undefined &&
            (value.type === "reasoning-start" ||
              value.type === "text-start" ||
              value.type === "tool-input-start" ||
              value.type === "text-delta" ||
              value.type === "tool-call")
          ) {
            ctx.ttftMs = Date.now() - ctx.attemptStartMs
          }
          switch (value.type) {
            case "start":
              yield* status.set(ctx.sessionID, { type: "busy" })
              return

            case "reasoning-start":
              if (value.id in ctx.reasoningMap) return
              ctx.reasoningMap[value.id] = {
                id: PartID.ascending(),
                messageID: ctx.assistantMessage.id,
                sessionID: ctx.assistantMessage.sessionID,
                type: "reasoning",
                text: "",
                time: { start: Date.now() },
                metadata: (() => {
                  if (!isGemini3Model(input.model)) return value.providerMetadata
                  if (extractThoughtSignature(value.providerMetadata)) return value.providerMetadata
                  // Proxy (e.g. QPilot) strips extra_content so real signature never arrives.
                  // Inject the official dummy value to skip VertexAI's signature validator.
                  return skipThoughtSignatureMetadata()
                })(),
              }
              yield* session.updatePart(ctx.reasoningMap[value.id])
              return

            case "reasoning-delta":
              if (!(value.id in ctx.reasoningMap)) return
              ctx.reasoningMap[value.id].text += value.text
              if (value.providerMetadata) {
                // Only overwrite stored metadata if the incoming delta carries a real
                // thought_signature. QPilot strips extra_content so deltas arrive with
                // providerMetadata that has no signature — overwriting would clobber the
                // dummy injected at reasoning-start and cause a 400 on the next turn.
                if (
                  isGemini3Model(input.model) &&
                  !extractThoughtSignature(value.providerMetadata) &&
                  extractThoughtSignature(ctx.reasoningMap[value.id].metadata)
                ) {
                  // keep existing metadata (has the dummy / real signature)
                } else {
                  ctx.reasoningMap[value.id].metadata = value.providerMetadata
                }
              }
              yield* session.updatePartDelta({
                sessionID: ctx.reasoningMap[value.id].sessionID,
                messageID: ctx.reasoningMap[value.id].messageID,
                partID: ctx.reasoningMap[value.id].id,
                field: "text",
                delta: value.text,
              })
              return

            case "reasoning-end":
              if (!(value.id in ctx.reasoningMap)) return
              ctx.reasoningMap[value.id].text = ctx.reasoningMap[value.id].text.trimEnd()
              ctx.reasoningMap[value.id].time = { ...ctx.reasoningMap[value.id].time, end: Date.now() }
              if (value.providerMetadata) {
                // Same guard as reasoning-delta: don't clobber a stored dummy/real signature
                // with a signatureless providerMetadata from a proxy-stripped event.
                if (
                  isGemini3Model(input.model) &&
                  !extractThoughtSignature(value.providerMetadata) &&
                  extractThoughtSignature(ctx.reasoningMap[value.id].metadata)
                ) {
                  // keep existing metadata
                } else {
                  ctx.reasoningMap[value.id].metadata = value.providerMetadata
                }
              }
              yield* session.updatePart(ctx.reasoningMap[value.id])
              delete ctx.reasoningMap[value.id]
              return

            case "tool-input-start":
              ctx.toolcalls[value.id] = yield* session.updatePart({
                id: ctx.toolcalls[value.id]?.id ?? PartID.ascending(),
                messageID: ctx.assistantMessage.id,
                sessionID: ctx.assistantMessage.sessionID,
                type: "tool",
                tool: value.toolName,
                callID: value.id,
                state: { status: "pending", input: {}, raw: "" },
              } satisfies MessageV2.ToolPart)
              return

            case "tool-input-delta":
              return

            case "tool-input-end":
              return

            case "tool-call": {
              const match = ctx.toolcalls[value.toolCallId]
              if (!match) return
              ctx.toolcalls[value.toolCallId] = yield* session.updatePart({
                ...match,
                tool: value.toolName,
                state: { status: "running", input: value.input, time: { start: Date.now() } },
                metadata: (() => {
                  if (!isGemini3Model(input.model)) return value.providerMetadata
                  if (extractThoughtSignature(value.providerMetadata)) return value.providerMetadata
                  // Same fallback as reasoning-start: proxies strip extra_content on
                  // tool-call events, so inject the skip sentinel on next-turn replay.
                  return skipThoughtSignatureMetadata()
                })(),
              } satisfies MessageV2.ToolPart)

              const parts = MessageV2.parts(ctx.assistantMessage.id)
              const recentParts = parts.slice(-DOOM_LOOP_THRESHOLD)

              if (
                recentParts.length !== DOOM_LOOP_THRESHOLD ||
                !recentParts.every(
                  (part) =>
                    part.type === "tool" &&
                    part.tool === value.toolName &&
                    part.state.status !== "pending" &&
                    JSON.stringify(part.state.input) === JSON.stringify(value.input),
                )
              ) {
                return
              }

              const agent = yield* agents.get(ctx.assistantMessage.agent)
              yield* permission.ask({
                permission: "doom_loop",
                patterns: [value.toolName],
                sessionID: ctx.assistantMessage.sessionID,
                metadata: { tool: value.toolName, input: value.input },
                always: [value.toolName],
                ruleset: agent.permission,
              })
              return
            }

            case "tool-result": {
              const match = ctx.toolcalls[value.toolCallId]
              if (!match || match.state.status !== "running") return
              yield* session.updatePart({
                ...match,
                state: {
                  status: "completed",
                  input: value.input ?? match.state.input,
                  output: value.output.output,
                  metadata: value.output.metadata,
                  title: value.output.title,
                  time: { start: match.state.time.start, end: Date.now() },
                  attachments: value.output.attachments,
                },
              })
              delete ctx.toolcalls[value.toolCallId]
              return
            }

            case "tool-error": {
              const match = ctx.toolcalls[value.toolCallId]
              if (!match || match.state.status !== "running") return
              yield* session.updatePart({
                ...match,
                state: {
                  status: "error",
                  input: value.input ?? match.state.input,
                  error: value.error instanceof Error ? value.error.message : String(value.error),
                  metadata: match.state.metadata,
                  time: { start: match.state.time.start, end: Date.now() },
                },
              })
              if (value.error instanceof Permission.RejectedError) {
                ctx.blocked = ctx.shouldBreak
              }
              delete ctx.toolcalls[value.toolCallId]
              return
            }

            case "error":
              return yield* Effect.fail(value.error)

            case "start-step":
              if (!ctx.snapshot) ctx.snapshot = yield* snapshot.track()
              yield* session.updatePart({
                id: PartID.ascending(),
                messageID: ctx.assistantMessage.id,
                sessionID: ctx.sessionID,
                snapshot: ctx.snapshot,
                type: "step-start",
              })
              return

            case "finish-step": {
              if (value.usage && typeof value.usage.inputTokens === "number") {
                ctx.inputTokens = value.usage.inputTokens
              }
              const usage = Session.getUsage({
                model: ctx.model,
                usage: value.usage,
                metadata: value.providerMetadata,
              })
              ctx.assistantMessage.finish = value.finishReason
              ctx.assistantMessage.cost += usage.cost
              ctx.assistantMessage.tokens = usage.tokens
              yield* session.updatePart({
                id: PartID.ascending(),
                reason: value.finishReason,
                snapshot: yield* snapshot.track(),
                messageID: ctx.assistantMessage.id,
                sessionID: ctx.assistantMessage.sessionID,
                type: "step-finish",
                tokens: usage.tokens,
                cost: usage.cost,
              })
              yield* session.updateMessage(ctx.assistantMessage)
              if (ctx.snapshot) {
                const patch = yield* snapshot.patch(ctx.snapshot)
                if (patch.files.length) {
                  yield* session.updatePart({
                    id: PartID.ascending(),
                    messageID: ctx.assistantMessage.id,
                    sessionID: ctx.sessionID,
                    type: "patch",
                    hash: patch.hash,
                    files: patch.files,
                  })
                }
                ctx.snapshot = undefined
              }
              SessionSummary.summarize({
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.parentID,
              })
              if (
                !ctx.assistantMessage.summary &&
                isOverflow({ cfg: yield* config.get(), tokens: usage.tokens, model: ctx.model })
              ) {
                ctx.needsCompaction = true
              }
              return
            }

            case "text-start":
              ctx.currentText = {
                id: PartID.ascending(),
                messageID: ctx.assistantMessage.id,
                sessionID: ctx.assistantMessage.sessionID,
                type: "text",
                text: "",
                time: { start: Date.now() },
                metadata: value.providerMetadata,
              }
              yield* session.updatePart(ctx.currentText)
              return

            case "text-delta":
              if (!ctx.currentText) return
              ctx.currentText.text += value.text
              if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
              yield* session.updatePartDelta({
                sessionID: ctx.currentText.sessionID,
                messageID: ctx.currentText.messageID,
                partID: ctx.currentText.id,
                field: "text",
                delta: value.text,
              })
              return

            case "text-end":
              if (!ctx.currentText) return
              ctx.currentText.text = ctx.currentText.text.trimEnd()
              ctx.currentText.text = (yield* ProviderPluginHooks.triggerEffect(
                "experimental.text.complete",
                {
                  sessionID: ctx.sessionID,
                  messageID: ctx.assistantMessage.id,
                  partID: ctx.currentText.id,
                },
                { text: ctx.currentText.text },
              )).text
              ctx.currentText.time = { start: Date.now(), end: Date.now() }
              if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
              yield* session.updatePart(ctx.currentText)
              ctx.currentText = undefined
              return

            case "finish":
              return

            default:
              log.info("unhandled", { ...value })
              return
          }
        })

        const cleanup = Effect.fn("SessionProcessor.cleanup")(function* () {
          if (ctx.snapshot) {
            const patch = yield* snapshot.patch(ctx.snapshot)
            if (patch.files.length) {
              yield* session.updatePart({
                id: PartID.ascending(),
                messageID: ctx.assistantMessage.id,
                sessionID: ctx.sessionID,
                type: "patch",
                hash: patch.hash,
                files: patch.files,
              })
            }
            ctx.snapshot = undefined
          }

          unsubPause()
          unsubModelChange()
          unsubResume()

          if (ctx.currentText) {
            const end = Date.now()
            ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
            yield* session.updatePart(ctx.currentText)
            ctx.currentText = undefined
          }

          for (const part of Object.values(ctx.reasoningMap)) {
            const end = Date.now()
            yield* session.updatePart({
              ...part,
              time: { start: part.time.start ?? end, end },
            })
          }
          ctx.reasoningMap = {}

          const parts = MessageV2.parts(ctx.assistantMessage.id)
          for (const part of parts) {
            if (part.type !== "tool" || part.state.status === "completed" || part.state.status === "error") continue
            yield* session.updatePart({
              ...part,
              state: {
                ...part.state,
                status: "error",
                error: "Tool execution aborted (parent session stopped). Pass task_id to resume.",
                time: { start: Date.now(), end: Date.now() },
              },
            })
          }
          ctx.assistantMessage.time.completed = Date.now()
          yield* session.updateMessage(ctx.assistantMessage)
        })

        const halt = Effect.fn("SessionProcessor.halt")(function* (e: unknown) {
          log.error("process", { error: e, stack: e instanceof Error ? e.stack : undefined })
          const error = parse(e)
          if (pauseRequested) return
          if (MessageV2.ContextOverflowError.isInstance(error)) {
            ctx.needsCompaction = true
            yield* bus.publish(Session.Event.Error, { sessionID: ctx.sessionID, error })
            return
          }
          ctx.assistantMessage.error = error
          yield* bus.publish(Session.Event.Error, {
            sessionID: ctx.assistantMessage.sessionID,
            error: ctx.assistantMessage.error,
          })
          yield* status.set(ctx.sessionID, { type: "idle" })
        })

        const abort = Effect.fn("SessionProcessor.abort")(() =>
          Effect.gen(function* () {
            if (!ctx.assistantMessage.error) {
              yield* halt(new DOMException("Aborted", "AbortError"))
            }
            if (!ctx.assistantMessage.time.completed) {
              yield* cleanup()
              return
            }
            yield* session.updateMessage(ctx.assistantMessage)
          }),
        )

        const tryStream = (streamInput: LLM.StreamInput) =>
          Effect.gen(function* () {
            ctx.currentText = undefined
            ctx.reasoningMap = {}

            // Tool-aware idle timeout: resets whenever a tool is actively running
            // so long-running tools (e.g. `bun test`) are never killed by the
            // LLM-hang guard. The 120 s clock only ticks while the LLM is
            // generating tokens with no tool in flight.
            const LLM_IDLE_MS = 120_000
            const POLL_MS = 1_000
            const idleWatcher = Effect.gen(function* () {
              let idle = 0
              while (idle < LLM_IDLE_MS) {
                yield* Effect.sleep(Duration.millis(POLL_MS))
                const toolsRunning = Object.values(ctx.toolcalls).some((p) => p.state.status === "running")
                idle = toolsRunning ? 0 : idle + POLL_MS
              }
              return yield* Effect.fail(new Cause.TimeoutError())
            })

            const stream = llm.stream(streamInput)
            yield* Effect.raceFirst(
              stream.pipe(
                Stream.tap((event) => handleEvent(event)),
                Stream.takeUntil(() => ctx.needsCompaction),
                Stream.runDrain,
              ),
              idleWatcher,
            )
          }).pipe(
            Effect.onInterrupt(() => Effect.sync(() => void (aborted = true))),
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (cause) => Effect.fail(Cause.squash(cause)),
            ),
            Effect.retry(
              Schedule.both(
                SessionRetry.policy({
                  parse,
                  set: (info) =>
                    status.set(ctx.sessionID, {
                      type: "retry",
                      attempt: info.attempt,
                      message: info.message,
                      next: info.next,
                    }),
                }),
                Schedule.recurs(4),
              ),
            ),
          )

        const process = Effect.fn("SessionProcessor.process")(function* (streamInput: LLM.StreamInput) {
          log.info("process")
          ctx.needsCompaction = false
          ctx.shouldBreak = (yield* config.get()).experimental?.continue_loop_on_deny !== true

          if (pauseRequested) {
            yield* status.set(input.sessionID, { type: "paused" })
            yield* bus.publish(Bus.SubagentPaused, { sessionID: input.sessionID })
            return "stop"
          }
          if (currentModel.id !== input.model.id || currentModel.providerID !== input.model.providerID) {
            const previousModel = `${input.model.providerID}/${input.model.id}`
            const newModel = `${currentModel.providerID}/${currentModel.id}`
            log.info("model changed", { previous: previousModel, current: newModel })
            input.model = currentModel
            streamInput.model = currentModel
            yield* bus.publish(Bus.SubagentModelChanged, {
              sessionID: input.sessionID,
              model: newModel,
              previous_model: previousModel,
            })
          }

          return yield* Effect.gen(function* () {
            // Build the candidate list: current model first, then any unused fallbacks
            const modelCandidates = [
              streamInput.model,
              ...fallbacks.slice(fallbackIndex).map((f) => ({
                ...streamInput.model,
                id: f.modelID,
                providerID: f.providerID,
              })),
            ]

            let streamErr: unknown
            for (const candidate of modelCandidates) {
              streamInput.model = candidate
              ctx.attemptStartMs = Date.now()
              ctx.ttftMs = undefined
              ctx.inputTokens = undefined
              const t0 = Date.now()
              const exit = yield* tryStream(streamInput).pipe(Effect.exit)
              const latencyMs = Date.now() - t0
              const modelKey = `${candidate.providerID}/${candidate.id}`
              if (exit._tag === "Success") {
                // Record success sample non-blocking — must not throw on the hot path.
                const toolCallsCount = Object.keys(ctx.toolcalls).length
                const taskType = inferTaskType(streamInput.agent.name, ctx.inputTokens, toolCallsCount)
                ModelRouter.record(modelKey, true, latencyMs, {
                  ttftMs: ctx.ttftMs,
                  inputTokens: ctx.inputTokens,
                  taskType,
                }).catch(() => {})
                DelegationHealthState.append({
                  providerID: String(candidate.providerID),
                  modelID: String(candidate.id),
                  success: true,
                  latencyMs,
                }).catch(() => {})
                streamErr = undefined
                break
              }
              const e = exit._tag === "Failure" ? Cause.squash(exit.cause) : exit
              const cls = SessionRetry.classify(e)
              const rateLimited = SessionRetry.isRateLimited(e)
              const errorCode = streamErrorCode(e, parse)
              const toolCallsCount = Object.keys(ctx.toolcalls).length
              const taskType = inferTaskType(streamInput.agent.name, ctx.inputTokens, toolCallsCount)
              // Record failure sample non-blocking.
              ModelRouter.record(modelKey, false, latencyMs, {
                ttftMs: ctx.ttftMs,
                inputTokens: ctx.inputTokens,
                errorCode,
                taskType,
              }).catch(() => {})
              DelegationHealthState.append({
                providerID: String(candidate.providerID),
                modelID: String(candidate.id),
                success: false,
                latencyMs,
                errorClass: cls,
                rateLimited,
              }).catch(() => {})
              const isLast = candidate === modelCandidates[modelCandidates.length - 1]
              if (!isLast && cls !== "halt") {
                fallbackIndex++
                log.warn("process.model-fallback", {
                  failed: `${candidate.providerID}/${candidate.id}`,
                  reason: cls,
                  next: modelCandidates[fallbackIndex]
                    ? `${modelCandidates[fallbackIndex].providerID}/${modelCandidates[fallbackIndex].id}`
                    : "none",
                  error: e instanceof Error ? e.message : String(e),
                })
                currentModel = candidate
                streamErr = e
                continue
              }
              streamErr = e
              break
            }

            if (streamErr !== undefined) {
              yield* halt(streamErr).pipe(Effect.ensuring(cleanup()))
            } else {
              yield* cleanup()
            }

            if (aborted && !ctx.assistantMessage.error) {
              yield* abort()
            }
            if (ctx.needsCompaction) return "compact"
            if (ctx.blocked || ctx.assistantMessage.error || aborted) return "stop"
            return "continue"
          }).pipe(Effect.onInterrupt(() => abort().pipe(Effect.asVoid)))
        })

        return {
          get message() {
            return ctx.assistantMessage
          },
          partFromToolCall(toolCallID: string) {
            return ctx.toolcalls[toolCallID]
          },
          abort,
          process,
        } satisfies Handle
      })

      return Service.of({ create })
    }),
  )

  export const defaultLayer = Layer.unwrap(
    Effect.sync(() =>
      layer.pipe(
        Layer.provide(Session.defaultLayer),
        Layer.provide(Snapshot.defaultLayer),
        Layer.provide(Agent.defaultLayer),
        Layer.provide(LLM.defaultLayer),
        Layer.provide(Permission.defaultLayer),
        Layer.provide(SessionStatus.layer.pipe(Layer.provide(Bus.layer))),
        Layer.provide(Bus.layer),
        Layer.provide(Config.defaultLayer),
      ),
    ),
  )
}
import {
  isGemini3Model,
  extractThoughtSignature,
  skipThoughtSignatureMetadata,
} from "@/process/session/thought-signature"
