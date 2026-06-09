// session/forked-agent.ts
//
// Forked-subagent primitive (Phase 2a of the token-efficiency overhaul).
//
// A "forked agent" is a one-shot LLM call that runs in isolation from the
// main session loop — same model, same agent definition, but with its own
// abort controller and a hand-built message list. It does NOT participate
// in the parent session's DB persistence, doesn't write parts, doesn't
// trigger snapshot tracking, doesn't fire packet rebuild events, and
// doesn't drive tool calls. It just runs ONE model call and returns the
// resulting text + usage.
//
// Why a primitive: Phase 2b (SessionMemory), 2c (extractMemories), and 2d
// (autoDream) all need to spawn a background LLM call that summarizes or
// extracts content from the parent's conversation without polluting the
// parent loop. The shared shape is "consume LLM.stream events into a text
// buffer and return when the stream completes".
//
// Provider scope: this is fully provider-agnostic. It uses LLM.stream which
// dispatches via the AI SDK's per-provider language model. Cache benefits
// from Phase 1f (single-marker strategy) come automatically because the
// fork sends the parent's message prefix unchanged.
//
// Reference (heavy / Claude-Code-specific):
//   instructkr-claude-code/src/utils/forkedAgent.ts:runForkedAgent
// Opencode's variant is intentionally much smaller — most of the
// reference's complexity (CacheSafeParams, ToolUseContext cloning, sidechain
// transcript recording) is solving problems that don't exist in opencode
// because we don't have the same shared-state architecture.

import type { ModelMessage, Tool } from "ai"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "@/process/session/message-v2"
import { LLM } from "@/process/session/llm"
import { Session } from "@/process/session"
import { Log } from "@/foundation/util/log"
import { MessageID } from "@/process/session/schema"

export namespace ForkedAgent {
  const log = Log.create({ service: "session.forked-agent" })

  export type RunInput = {
    /** Model to use. Should match parent's model for cache hits. */
    model: Provider.Model
    /** Agent definition (for agent.name, agent.permission, etc). */
    agent: Agent.Info
    /** Parent sessionID — recorded in stream tags for log correlation. */
    parentSessionID: string
    /** Optional label for log correlation (e.g. "session-memory"). */
    label?: string
    /**
     * System prompt fragments — concatenated by LLM.stream into a single
     * system message. Pass an empty array if you want LLM.stream to derive
     * the default agent prompt + provider system from the agent definition.
     */
    system: string[]
    /**
     * Conversation prefix to feed the model. For SessionMemory this is the
     * parent session's flattened message history; for extractMemories it's
     * the task note + extraction prompt. The forked agent will NOT mutate
     * this array.
     */
    messages: ModelMessage[]
    /**
     * Optional final user message text to append. Convenience for callers
     * that want to send `messages + "Now do X"` without having to build the
     * ModelMessage shape themselves.
     */
    prompt?: string
    /**
     * Tool map for the forked call. DEFAULT is an empty object — most
     * forked agents are summarizers/extractors that don't need tools.
     * Set explicitly to a non-empty map to enable tools.
     */
    tools?: Record<string, Tool>
    /**
     * Maximum wall time in ms before the call is aborted. Default 5 minutes.
     * The reference impl uses no cap; we add one to make sure a stuck fork
     * never wedges the parent indefinitely.
     */
    timeoutMs?: number
    /**
     * Caller-supplied abort signal. The fork creates its own controller
     * that's wired to abort when this signal fires (so the fork inherits
     * the parent's cancellation lifetime).
     */
    parentAbort?: AbortSignal
  }

  export type RunResult = {
    /** Final text output, with leading/trailing whitespace trimmed. */
    text: string
    /** Total tokens used — sums input, output, reasoning, and cache fields. */
    usage: {
      input: number
      output: number
      reasoning: number
      cache: { read: number; write: number }
      total?: number
    }
    /** Model's finish reason if the stream emitted one. */
    finishReason?: string
    /** Wall-clock duration in ms. */
    durationMs: number
    /** True iff the run was aborted (timeout or parent cancellation). */
    aborted: boolean
  }

  /**
   * Run a one-shot forked LLM call. Streams the response, accumulates text
   * deltas, and returns when the stream completes (or when the abort
   * controller fires).
   *
   * This intentionally avoids the SessionProcessor — no DB writes, no
   * snapshots, no tool execution machinery. The caller is responsible for
   * persisting the returned text (e.g. to a memory.md file) if it wants
   * the work to outlive the function call.
   */
  export async function run(input: RunInput): Promise<RunResult> {
    const startTime = Date.now()
    const timeoutMs = input.timeoutMs ?? 5 * 60_000
    const label = input.label ?? "forked"
    const ctrl = new AbortController()

    // Wire parent abort → child abort. If parentAbort fires we cancel the
    // fork. We DON'T wire child abort → parent — the fork must never be
    // able to cancel the parent's main loop.
    let unsubscribeParent: (() => void) | undefined
    if (input.parentAbort) {
      if (input.parentAbort.aborted) {
        ctrl.abort()
      } else {
        const handler = () => ctrl.abort()
        input.parentAbort.addEventListener("abort", handler, { once: true })
        unsubscribeParent = () => input.parentAbort!.removeEventListener("abort", handler)
      }
    }

    const timer = setTimeout(() => {
      log.warn("forked agent timed out", { label, timeoutMs })
      ctrl.abort()
    }, timeoutMs)

    // Build the message list with the optional trailing prompt.
    const messages: ModelMessage[] = input.prompt
      ? [...input.messages, { role: "user", content: input.prompt }]
      : [...input.messages]

    // Synthetic user message ID — LLM.stream wants a MessageV2.User shape
    // for log/header propagation. We construct a minimal one in-memory and
    // never persist it.
    const syntheticUser: MessageV2.User = {
      id: MessageID.ascending(),
      role: "user",
      sessionID: input.parentSessionID as MessageV2.User["sessionID"],
      time: { created: Date.now() },
      agent: input.agent.name,
      model: { providerID: input.model.providerID, modelID: input.model.id as any }, // ModelID brand: synthetic in-memory object, never persisted
    }

    let text = ""
    let usage: RunResult["usage"] = {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    }
    let finishReason: string | undefined
    let aborted = false

    try {
      const result = await LLM.stream({
        user: syntheticUser,
        sessionID: input.parentSessionID,
        parentSessionID: input.parentSessionID,
        model: input.model,
        agent: input.agent,
        system: input.system,
        messages,
        tools: input.tools ?? {},
        // No tool calls in forked-agent runs by default. Callers wanting
        // tools must opt in via input.tools.
        toolChoice: input.tools && Object.keys(input.tools).length > 0 ? "auto" : "none",
        abort: ctrl.signal,
      })

      for await (const event of result.fullStream) {
        if (ctrl.signal.aborted) {
          aborted = true
          break
        }
        switch (event.type) {
          case "text-delta": {
            text += event.text
            break
          }
          case "finish-step": {
            const fromUsage = Session.getUsage({
              model: input.model,
              usage: event.usage,
              metadata: event.providerMetadata,
            })
            usage = {
              input: usage.input + fromUsage.tokens.input,
              output: usage.output + fromUsage.tokens.output,
              reasoning: usage.reasoning + fromUsage.tokens.reasoning,
              cache: {
                read: usage.cache.read + fromUsage.tokens.cache.read,
                write: usage.cache.write + fromUsage.tokens.cache.write,
              },
              total: (usage.total ?? 0) + (fromUsage.tokens.total ?? 0),
            }
            finishReason = event.finishReason
            break
          }
          case "error": {
            const err = event.error
            log.warn("forked agent stream error", { label, err: (err as Error)?.message ?? String(err) })
            break
          }
        }
      }
    } catch (err) {
      if (ctrl.signal.aborted) {
        aborted = true
      } else {
        log.error("forked agent run failed", { label, err: (err as Error)?.message ?? String(err) })
        throw err
      }
    } finally {
      clearTimeout(timer)
      unsubscribeParent?.()
    }

    const durationMs = Date.now() - startTime
    log.info("forked agent done", {
      label,
      durationMs,
      aborted,
      textLength: text.length,
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cache.read,
    })

    return {
      text: text.trim(),
      usage,
      finishReason,
      durationMs,
      aborted,
    }
  }
}
