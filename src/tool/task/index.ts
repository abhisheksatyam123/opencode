export * from "@/tool/task/contract/port"
import { Tool } from "@/tool/tool"
import z from "zod"
import { SessionID, MessageID } from "@/foundation/identifier/session"
import { ToolSessionPort } from "@/tool/session-port"
import { Identifier } from "@/foundation/id"
import { AgentCatalog } from "@/permission/policy/agent-catalog"
import { iife } from "@/foundation/util/iife"
import { defer } from "@/foundation/util/defer"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { ProviderPluginHooks } from "@/provider/plugin-hooks"
import * as fs from "fs/promises"
import path from "path"
import { InstanceContextStorage as Instance } from "@/foundation/effect/instance-context"
import { Log } from "@/foundation/util/log"
import { Sleep } from "@/foundation/util/sleep"
import { BackgroundTaskSlots, type BackgroundTaskResult } from "@/process/background-slots"
import { executeLifecycleOp } from "@/tool/task/lifecycle"
import { TaskToolRuntimeParameters as parameters, formatTaskToolValidationError } from "@/tool/task/parameters"
import { classifyRateLimit, executeTaskResultOp, safeBackgroundTask, storeCompletedTask } from "@/tool/task/result"
import { lastAssistantModel, parseTaskModelOverride, resolveTaskModel } from "@/tool/task/model-selection"
export {
  backgroundTaskIDForSession,
  getBackgroundTask,
  getCompletedTask,
  storeCompletedTask,
  getTaskLastDeliveredAt,
  taskCompletedSince,
  taskRunning,
  markTaskDelivered,
  resetTaskCursor,
  deleteBackgroundTask,
} from "@/tool/task/result"

const log = Log.create({ service: "tool.task" })

export const SubagentResultSchema = z.record(z.string(), z.unknown())
export type SubagentResult = z.infer<typeof SubagentResultSchema>

function emptySubagentResult(): SubagentResult {
  return {}
}

export type ParsedSubagentResult = {
  structured: boolean
  /**
   * True when the subagent produced no final text part (empty or whitespace).
   * Distinct from structured=false which also covers "unparseable text" and
   * "invalid schema". `empty` specifically flags the silent-no-op mode so the
   * orchestrator can distinguish it from a deliberate empty-JSON return.
   */
  empty: boolean
  result: SubagentResult
  raw_result_text: string
}

/**
 * Build the visible warning that replaces the empty `<task_result>` block when
 * a subagent session terminates without a final text part. Pure — unit-testable.
 */
export function formatEmptyResultWarning(subagentType: string, sessionID: string): string {
  return (
    `⚠ Subagent @${subagentType} returned no final text. ` +
    `Likely causes: context window exhausted, tool-call budget hit, ` +
    `model backend returned empty, or subagent terminated mid-thought. ` +
    `Session id: ${sessionID} (pass as task_id to resume and investigate). ` +
    `Parsed packet will be empty.`
  )
}

export function parseSubagentResult(text: string): ParsedSubagentResult {
  const trimmed = text.trim()
  if (!trimmed) {
    return {
      structured: false,
      empty: true,
      result: emptySubagentResult(),
      raw_result_text: text,
    }
  }

  const fallback = {
    structured: false,
    empty: false,
    result: emptySubagentResult(),
    raw_result_text: text,
  }

  const parsed = iife(() => {
    try {
      return JSON.parse(trimmed)
    } catch {
      return null
    }
  })
  if (!parsed) return fallback

  const validated = SubagentResultSchema.safeParse(parsed)
  if (!validated.success) return fallback

  return {
    structured: true,
    empty: false,
    result: validated.data,
    raw_result_text: text,
  }
}

const SUBAGENT_CONCURRENCY_LIMIT = 5
const activeSubagentCounts = new Map<string, number>() // parentSessionID → active child count

// Abort counter per (parentSessionID, subagent_type) — circuit-breaker.
// If the same subagent_type aborts ≥2 times in the same parent session,
// the orchestrator gets a structured warning instead of a silent failure.
const abortCounts = new Map<string, number>()

function abortKey(sessionID: string, subagentType: string): string {
  return `${sessionID}::${subagentType}`
}

/**
 * Existence check for task_id validation. Returns true iff the id is a known
 * live or recently-completed subagent, or a sync delegation claim.
 */
export function hasKnownTaskId(id: string): boolean {
  return BackgroundTaskSlots.hasKnownTaskId(id)
}

export function normalizeSpawnPromptInput(spawn: any) {
  return spawn
}

export const TaskTool = Tool.define("task", async (ctx) => {
  const agents = await AgentCatalog.list().then((x) => x.filter((a) => a.mode !== "primary"))

  // Filter agents by permissions and delegation tier.
  const caller = ctx?.agent
  const accessibleAgents = caller
    ? agents.filter((a) => {
        if (Permission.evaluate("task", a.name, caller.permission).action === "deny") return false
        if (caller.tier === "0") return a.tier === "1" || a.name === "adviser"
        if (caller.tier === "1") return a.tier === "2"
        if (caller.tier === "2") return false
        return true
      })
    : agents
  const list = accessibleAgents.toSorted((a, b) => a.name.localeCompare(b.name))

  const agentList = list
    .map((a) => `- ${a.name}: ${a.description ?? "This subagent should only be called manually by the user."}`)
    .join("\n")
  const description = [
    "Delegate bounded work to subagents. Pass a clear plain-language prompt.",
    "Use bash for filesystem/process work; use task only for fan-out/fan-in. Subagents are read-only by default; set mode=implement with can_edit=true and explicit allowed_paths for edit ownership.",
    ...(agentList ? ["", "Available subagents:", agentList] : []),
  ].join("\n")
  return {
    description,
    parameters,
    formatValidationError: formatTaskToolValidationError,
    async execute(params: any, ctx) {
      const effectiveOp = params.op ?? "spawn"
      if (effectiveOp === "result") {
        return executeTaskResultOp(params)
      }
      // Lifecycle ops (kill/pause/resume/resurrect/model) — Stage 9 task-as-comms-surface.
      // task_id (ses_*/bg_ses_*) is canonical; pid is legacy alias with WARN.
      if (
        effectiveOp === "kill" ||
        effectiveOp === "pause" ||
        effectiveOp === "resume" ||
        effectiveOp === "resurrect" ||
        effectiveOp === "model"
      ) {
        return executeLifecycleOp(params, ctx)
      }
      let spawn = effectiveOp === "spawn" ? ({ ...params, op: undefined } as any) : params
      spawn = normalizeSpawnPromptInput(spawn)
      if (spawn.run_in_background !== undefined && spawn.background === undefined)
        spawn.background = spawn.run_in_background

      const agent = accessibleAgents.find((candidate) => candidate.name === spawn.subagent_type)
      if (!agent) {
        const available =
          accessibleAgents
            .map((candidate) => candidate.name)
            .sort()
            .join(", ") || "none"
        throw new Error(
          `Unknown or inaccessible subagent_type "${spawn.subagent_type}". Available subagents: ${available}`,
        )
      }

      try {
        const config = await Config.get()

        // Validate model override before any downstream lifecycle operations.
        const requestedModel = spawn.model ? parseTaskModelOverride(spawn.model, config) : undefined
        const requestedModels = Array.isArray(spawn.models)
          ? spawn.models.map((m: string) => parseTaskModelOverride(m, config))
          : undefined

        // Tier-2 agents cannot spawn; suppress the task tool from their session entirely.
        // Tier-0 and tier-1 agents can spawn — keep task enabled unless explicitly denied by permission.
        const agentTier = agent.tier ? parseInt(agent.tier, 10) : 99
        const hasTaskPermission = agentTier < 2 && Permission.evaluate("task", "*", agent.permission).action !== "deny"

        // Concurrency cap: at most SUBAGENT_CONCURRENCY_LIMIT live children per parent session.
        // When at cap, wait with exponential backoff (1s→2s→4s→…, max 30s) before retrying.
        {
          let waitMs = 1_000
          const MAX_WAIT_MS = 30_000
          while ((activeSubagentCounts.get(ctx.sessionID) ?? 0) >= SUBAGENT_CONCURRENCY_LIMIT) {
            if (ctx.abort.aborted) throw new DOMException("Aborted", "AbortError")
            log.info("task.execute.concurrency-cap-wait", {
              sessionID: ctx.sessionID,
              active: activeSubagentCounts.get(ctx.sessionID),
              waitMs,
            })
            await Sleep.until(waitMs, ctx.abort, { throwOnAbort: true })
            waitMs = Math.min(waitMs * 2, MAX_WAIT_MS)
          }
          activeSubagentCounts.set(ctx.sessionID, (activeSubagentCounts.get(ctx.sessionID) ?? 0) + 1)
        }

        const session = await iife(async () => {
          if (params.task_id) {
            const found = await ToolSessionPort.sessionGet(SessionID.make(params.task_id)).catch(() => {})
            if (found) return found
          }

          return await ToolSessionPort.sessionCreate({
            parentID: ctx.sessionID,
            title: params.description + ` (@${agent.name} subagent)`,
            permission: [
              ...(hasTaskPermission
                ? []
                : [
                    {
                      permission: "task" as const,
                      pattern: "*" as const,
                      action: "deny" as const,
                    },
                  ]),
              ...(config.experimental?.primary_tools?.map((t) => ({
                pattern: "*",
                action: "allow" as const,
                permission: t,
              })) ?? []),
            ],
          })
        })

        // Lifecycle hook — fires when the task tool spawns (or resumes) a
        // subagent child session. Plugins use this for parent-child session
        // tracking, external dashboard integrations, etc.
        await ProviderPluginHooks.notify("subagent.start", {
          parentSessionID: ctx.sessionID,
          sessionID: session.id,
          agent: agent.name,
          description: params.description,
        })

        const resumedModel = params.task_id ? await lastAssistantModel(session.id).catch(() => undefined) : undefined

        const effectiveAgentModels = agent.models?.length ? agent.models : undefined
        const effectiveAgentModel = agent.model ?? effectiveAgentModels?.[0]

        const {
          model,
          models: modelCandidates,
          source: modelSource,
        } = await resolveTaskModel({
          requestedModel,
          requestedModels,
          agentModel: effectiveAgentModel,
          agentModels: effectiveAgentModels,
          resumedModel,
          parentSessionID: ctx.sessionID,
          parentMessageID: ctx.messageID,
          config,
          subagentType: spawn.subagent_type,
        })

        log.info("task.execute.model-selection", {
          subagentType: params.subagent_type,
          source: modelSource,
          model,
          candidates: modelCandidates,
          resumed: Boolean(params.task_id),
        })

        await ctx.metadata({
          title: params.description,
          metadata: {
            sessionId: session.id,
            model,
            model_candidates: modelCandidates,
            model_source: modelSource,
            agent: agent.name,
            subagent_type: params.subagent_type,
            description: params.description,
          },
        })

        const messageID = MessageID.ascending()

        const composed = params.prompt
        const promptParts = [
          ...(await ToolSessionPort.resolvePromptParts(composed)),
          {
            type: "text" as const,
            text: ToolSessionPort.AUTONOMOUS_MARKER,
            synthetic: true,
            ignored: true,
          },
        ]

        // Core subagent execution — extracted so it can run in background or foreground.
        // Model fallback is handled by the processor layer (via modelFallbacks passed
        // through prompt.ts → processor.ts). We invoke with the primary model only.
        const runSubagent = async (abort: AbortSignal): Promise<BackgroundTaskResult> => {
          try {
            const result = await ToolSessionPort.prompt({
              messageID,
              sessionID: session.id,
              model: { modelID: model.modelID, providerID: model.providerID },
              agent: agent.name,
              system: typeof ctx.extra?.webRichOutputSystem === "string" ? ctx.extra.webRichOutputSystem : undefined,
              tools: {
                ...(hasTaskPermission ? {} : { task: false }),
                ...Object.fromEntries((config.experimental?.primary_tools ?? []).map((t) => [t, false])),
              },
              parts: promptParts,
            })

            const text = result.parts.findLast((x: any) => x.type === "text")?.text ?? ""
            const parsedResult = parseSubagentResult(text)
            const textBlock = parsedResult.empty ? formatEmptyResultWarning(params.subagent_type, session.id) : text
            return {
              output: [
                `task_id: ${session.id} (for resuming this subagent if needed)`,
                "",
                "<task_result>",
                textBlock,
                "</task_result>",
                "",
                "<task_result_parsed>",
                JSON.stringify(parsedResult.result),
                "</task_result_parsed>",
              ].join("\n"),
              sessionId: session.id,
              parsed: parsedResult,
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            const modelStr = `${model.providerID}/${model.modelID}`
            const rlKind = classifyRateLimit(msg)
            return {
              output: `task_id: ${session.id}\n\nSubagent failed on model "${modelStr}".\n\nOriginal error: ${msg}`,
              sessionId: session.id,
              error: msg,
              error_kind: rlKind ? "rate_limit" : "subagent_error",
              model: modelStr,
            }
          } finally {
            activeSubagentCounts.set(ctx.sessionID, Math.max(0, (activeSubagentCounts.get(ctx.sessionID) ?? 1) - 1))
          }
        }

        if (spawn.background === true) {
          const bgID = `bg_${session.id}`
          const bgPromise = safeBackgroundTask(bgID, runSubagent(ctx.abort))
          BackgroundTaskSlots.setTask(bgID, bgPromise, {
            sessionId: session.id,
            startedAt: Date.now(),
            label: params.description,
            agent: agent.name,
            model: `${model.providerID}/${model.modelID}`,
          })
          BackgroundTaskSlots.setTaskIdForSession(session.id, bgID)
          bgPromise
            .then((result) => storeCompletedTask(bgID, result))
            .catch((error) => {
              log.warn("failed to store completed background task", {
                background_task_id: bgID,
                error: error instanceof Error ? error.message : String(error),
              })
            })
          return {
            title: `task started: ${params.description}`,
            output: [`background_task_id: ${bgID}`, `task_id: ${session.id}`, `status: running`].join("\n"),
            metadata: {
              status: "running",
              background_task_id: bgID,
              task_id: session.id,
              sessionId: session.id,
            } as Record<string, unknown>,
          }
        }

        const result = await runSubagent(ctx.abort)
        return {
          title: `task complete: ${params.description}`,
          output: result.output,
          metadata: {
            status: result.error ? "error" : "done",
            task_id: session.id,
            sessionId: session.id,
            error: result.error,
            error_kind: result.error_kind,
            model: result.model,
            parsed: result.parsed,
          } as Record<string, unknown>,
        }
      } catch (err) {
        throw err
      }
    },
  }
})
