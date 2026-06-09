import { BackgroundTaskSlots, type BackgroundTaskResult } from "@/process/background-slots"
import { Truncate } from "@/tool/truncate"
import type { TaskResultRuntimeParameters } from "@/tool/task/parameters"

const PENDING = Symbol("pending")
const FOLLOW_UP_HINT = "Review the result and continue, resume, or handle directly as needed."

const MINUTE_MS = 60_000
const RESULT_POLL_BACKOFF_SEQUENCE_MS = [5, 10, 20, 30, 40].map((minutes) => minutes * MINUTE_MS)
const RESULT_POLL_BACKOFF_MAX_MS = RESULT_POLL_BACKOFF_SEQUENCE_MS.at(-1)!

type ResultPollBackoffState = { attempt: number; nextMs: number }
const resultPollBackoffByTask = new Map<string, ResultPollBackoffState>()

export function backgroundTaskIDForSession(sessionID: string): string | undefined {
  return BackgroundTaskSlots.lookupTaskIdForSession(sessionID)
}

export function getBackgroundTask(id: string): Promise<BackgroundTaskResult> | undefined {
  return BackgroundTaskSlots.lookupTask(id)
}

export function getCompletedTask(id: string): BackgroundTaskResult | undefined {
  return BackgroundTaskSlots.lookupCompletedTask(id)
}

function withFollowUpHint(output: string): string {
  return [output.trimEnd(), "", `Next: ${FOLLOW_UP_HINT}`].join("\n")
}

function backoffForAttempt(attempt: number): number {
  const index = Math.min(attempt - 1, RESULT_POLL_BACKOFF_SEQUENCE_MS.length - 1)
  return RESULT_POLL_BACKOFF_SEQUENCE_MS[index] ?? RESULT_POLL_BACKOFF_MAX_MS
}

function ensureResultPollBackoff(bgId: string): ResultPollBackoffState {
  const prev = resultPollBackoffByTask.get(bgId)
  if (prev) return prev
  const state = { attempt: 1, nextMs: backoffForAttempt(1) }
  resultPollBackoffByTask.set(bgId, state)
  return state
}

function nextResultPollBackoff(bgId: string, observedWaitMs: number): ResultPollBackoffState {
  const prev = resultPollBackoffByTask.get(bgId)
  const attempt = prev ? prev.attempt + 1 : observedWaitMs >= backoffForAttempt(1) ? 2 : 1
  const state = { attempt, nextMs: backoffForAttempt(attempt) }
  resultPollBackoffByTask.set(bgId, state)
  return state
}

function formatPollDelay(ms: number): string {
  if (ms % MINUTE_MS === 0) return `${ms / MINUTE_MS}m`
  if (ms % 1000 === 0) return `${ms / 1000}s`
  return `${ms}ms`
}

function resetResultPollBackoff(bgId: string): void {
  resultPollBackoffByTask.delete(bgId)
}

function classifyAbort(error: string | undefined): { aborted: true; reason: "parent_stopped" | "hard_cancel" } | null {
  if (!error) return null
  const lower = error.toLowerCase()
  if (lower.includes("parent session stopped") || lower.includes("tool execution aborted")) {
    return { aborted: true, reason: "parent_stopped" }
  }
  if (lower.includes("abort") || lower.includes("aborterror")) {
    return { aborted: true, reason: "hard_cancel" }
  }
  return null
}

function makeAbortedResult(bgId: string, sessionId: string, reason: "parent_stopped" | "hard_cancel", message: string) {
  return {
    title: "task: result aborted",
    output: [
      `status: aborted`,
      `reason: ${reason}`,
      `resumable_task_id: ${sessionId}`,
      "",
      `Subagent was aborted (${reason}). Resume with task_id="${sessionId}" or handle the work directly.`,
      `Original error: ${message}`,
      `Next: ${FOLLOW_UP_HINT}`,
    ].join("\n"),
    metadata: {
      status: "aborted",
      reason,
      sessionId,
      sessionID: sessionId,
      resumable_task_id: sessionId,
      background_task_id: bgId,
      message,
    } as Record<string, unknown>,
  }
}

export function classifyRateLimit(error: string | undefined): { rateLimit: true } | null {
  if (!error) return null
  const lower = error.toLowerCase()
  if (
    lower.includes("429") ||
    lower.includes("rate limit") ||
    lower.includes("rate_limit") ||
    lower.includes("ratelimit") ||
    lower.includes("quota") ||
    lower.includes("resource exhausted") ||
    lower.includes("resource_exhausted") ||
    lower.includes("too many requests") ||
    lower.includes("capacity") ||
    lower.includes("throttl") ||
    lower.includes("overloaded") ||
    lower.includes("billing") ||
    lower.includes("credits")
  ) {
    return { rateLimit: true }
  }
  return null
}

function makeRateLimitResult(
  bgId: string,
  sessionId: string,
  model: string,
  message: string,
): ReturnType<typeof makeAbortedResult> {
  return {
    title: "task: result rate-limited",
    output: [
      `status: error`,
      `error_kind: rate_limit`,
      `model: ${model}`,
      `resumable_task_id: ${sessionId}`,
      ``,
      `Warning: Subagent model "${model}" hit a rate-limit / quota error.`,
      `Do NOT retry with the same model. Choose a different model/provider and re-spawn,`,
      `or resume with task_id="${sessionId}" once quota is restored.`,
      `Original error: ${message}`,
      `Next: ${FOLLOW_UP_HINT}`,
    ].join("\n"),
    metadata: {
      status: "error",
      error_kind: "rate_limit",
      model,
      sessionId,
      sessionID: sessionId,
      resumable_task_id: sessionId,
      background_task_id: bgId,
      message,
    } as Record<string, unknown>,
  }
}

function makeSubagentErrorResult(bgId: string, sessionId: string, model: string, message: string) {
  return {
    title: "task: result subagent error",
    output: [
      `status: error`,
      `error_kind: subagent_error`,
      `model: ${model}`,
      `resumable_task_id: ${sessionId}`,
      "",
      `Subagent failed on model "${model}". Re-run with a different model/provider or a better-suited specialist if needed.`,
      `Original error: ${message}`,
      `Next: ${FOLLOW_UP_HINT}`,
    ].join("\n"),
    metadata: {
      status: "error",
      error_kind: "subagent_error",
      model,
      sessionId,
      sessionID: sessionId,
      resumable_task_id: sessionId,
      background_task_id: bgId,
      message,
    } as Record<string, unknown>,
  }
}

function sessionIdFromBackgroundTaskId(bgId: string): string {
  return bgId.startsWith("bg_") ? bgId.slice(3) : bgId
}

function rejectedBackgroundTaskResult(bgId: string, err: unknown): BackgroundTaskResult {
  const message = err instanceof Error ? err.message : String(err)
  const sessionId = sessionIdFromBackgroundTaskId(bgId)
  const errorKind = classifyRateLimit(message) ? "rate_limit" : "subagent_error"
  return {
    output: [
      `task_id: ${sessionId} (for resuming to continue this task if needed)`,
      "",
      "<task_result>",
      errorKind === "rate_limit"
        ? `Subagent hit a rate-limit / quota error. Do not retry with the same model. Original error: ${message}`
        : `Subagent failed before producing a result. Original error: ${message}`,
      "</task_result>",
      "",
      "<task_result_parsed>",
      JSON.stringify({}),
      "</task_result_parsed>",
    ].join("\n"),
    sessionId,
    error: message,
    error_kind: errorKind,
    model: "unknown",
  }
}

export function safeBackgroundTask(
  bgId: string,
  promise: Promise<BackgroundTaskResult>,
): Promise<BackgroundTaskResult> {
  return promise.catch((err) => rejectedBackgroundTaskResult(bgId, err))
}

async function makeTaskDoneResult(
  title: string,
  bgId: string,
  result: BackgroundTaskResult,
  extra: Record<string, unknown> = {},
) {
  const compact = await Truncate.output(result.output)
  return {
    title,
    output: withFollowUpHint(compact.content),
    metadata: {
      status: "done",
      background_task_id: bgId,
      sessionId: result.sessionId,
      error: result.error,
      error_kind: result.error_kind,
      empty_result: result.parsed?.empty,
      structured_result: result.parsed?.structured,
      truncated: compact.truncated,
      ...(compact.truncated && { outputPath: compact.outputPath }),
      ...extra,
    } as Record<string, unknown>,
  }
}

export async function executeTaskResultOp(params: TaskResultRuntimeParameters) {
  const bgId = params.background_task_id
  const timeoutMs = params.timeout_ms ?? 0
  const cached = getCompletedTask(bgId)
  if (cached) {
    resetResultPollBackoff(bgId)
    const abortC = classifyAbort(cached.error)
    if (abortC) return makeAbortedResult(bgId, cached.sessionId, abortC.reason, cached.error!)
    if (cached.error_kind === "rate_limit" || classifyRateLimit(cached.error))
      return makeRateLimitResult(bgId, cached.sessionId, cached.model ?? "unknown", cached.error!)
    if (cached.error_kind === "subagent_error" || cached.error)
      return makeSubagentErrorResult(bgId, cached.sessionId, cached.model ?? "unknown", cached.error!)
    return makeTaskDoneResult("task: result done (cached)", bgId, cached, { from_cache: true })
  }

  const rawPromise = getBackgroundTask(bgId)
  if (!rawPromise) {
    resetResultPollBackoff(bgId)
    return {
      title: "task: result not found",
      output: `No background task found with id "${bgId}". It may have already been collected or never started.`,
      metadata: { status: "not_found", background_task_id: bgId } as Record<string, unknown>,
    }
  }

  const requiredWait = resultPollBackoffByTask.get(bgId)?.nextMs ?? backoffForAttempt(1)
  if (timeoutMs > 0 && timeoutMs < requiredWait) {
    const backoff = ensureResultPollBackoff(bgId)
    return {
      title: "task: result wait too short",
      output: [
        `Task result wait ${formatPollDelay(timeoutMs)} is too short for "${bgId}".`,
        `Next poll: wait about ${formatPollDelay(backoff.nextMs)}, then call task(op="result", background_task_id="${bgId}", timeout_ms=${backoff.nextMs}).`,
      ].join("\n"),
      metadata: {
        status: "wait_too_short",
        background_task_id: bgId,
        poll_attempt: backoff.attempt,
        poll_backoff_ms: backoff.nextMs,
        next_timeout_ms: backoff.nextMs,
        rejected_timeout_ms: timeoutMs,
      } as Record<string, unknown>,
    }
  }

  const result = await Promise.race([
    rawPromise,
    timeoutMs === 0
      ? Promise.resolve(PENDING)
      : new Promise<typeof PENDING>((resolve) => setTimeout(() => resolve(PENDING), timeoutMs)),
  ]).catch((err) => rejectedBackgroundTaskResult(bgId, err))

  if (result === PENDING) {
    const backoff = nextResultPollBackoff(bgId, timeoutMs)
    const timedOut = timeoutMs > 0
    return {
      title: timedOut ? "task: result timeout" : "task: result pending",
      output: timedOut
        ? [
            `Task "${bgId}" did not complete within ${timeoutMs}ms.`,
            `Next poll: wait about ${formatPollDelay(backoff.nextMs)}, then call task(op="result", background_task_id="${bgId}", timeout_ms=${backoff.nextMs}).`,
          ].join("\n")
        : [
            `Task "${bgId}" is still running.`,
            `Next poll: wait about ${formatPollDelay(backoff.nextMs)}, then call task(op="result", background_task_id="${bgId}", timeout_ms=${backoff.nextMs}).`,
          ].join("\n"),
      metadata: {
        status: timedOut ? "timeout" : "pending",
        background_task_id: bgId,
        poll_attempt: backoff.attempt,
        poll_backoff_ms: backoff.nextMs,
        next_timeout_ms: backoff.nextMs,
      } as Record<string, unknown>,
    }
  }

  resetResultPollBackoff(bgId)
  deleteBackgroundTask(bgId)
  const abort = classifyAbort(result.error)
  if (abort) return makeAbortedResult(bgId, result.sessionId, abort.reason, result.error!)
  if (result.error_kind === "rate_limit" || classifyRateLimit(result.error))
    return makeRateLimitResult(bgId, result.sessionId, result.model ?? "unknown", result.error!)
  if (result.error_kind === "subagent_error" || result.error)
    return makeSubagentErrorResult(bgId, result.sessionId, result.model ?? "unknown", result.error!)
  return makeTaskDoneResult("task: result done", bgId, result)
}

export function storeCompletedTask(id: string, result: BackgroundTaskResult): void {
  BackgroundTaskSlots.storeCompletedTask(id, result)
}

export function getTaskLastDeliveredAt(): number {
  return BackgroundTaskSlots.getLastDeliveredAt()
}

export function taskCompletedSince(
  ts: number,
): Array<{ id: string; result: BackgroundTaskResult; completedAt: number }> {
  return BackgroundTaskSlots.completedSince(ts)
}

export function taskRunning() {
  return BackgroundTaskSlots.listRunning()
}

export function markTaskDelivered(ids: string[]): void {
  BackgroundTaskSlots.markDelivered(ids)
}

export function resetTaskCursor(): void {
  BackgroundTaskSlots.resetCursor()
}

export function deleteBackgroundTask(id: string): void {
  resetResultPollBackoff(id)
  BackgroundTaskSlots.deleteTask(id)
}
