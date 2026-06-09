import type { NamedError } from "@opencode-ai/util/error"
import { Cause, Clock, Duration, Effect, Schedule } from "effect"
import { MessageV2 } from "@/process/session/message-v2"
import { iife } from "@/foundation/util/iife"
import { ProviderPluginHooks } from "@/provider/plugin-hooks"

export namespace SessionRetry {
  export type Err = ReturnType<NamedError["toObject"]>

  // FAST_RETRY is read per-call (not at import time) so tests can toggle
  // the env var without reloading the module. Contract:
  //   project/software/opencode/specification/contract/session-retry-policy
  const isFastRetry = () => process.env["OPENCODE_FAST_RETRY"] === "true"
  export const RETRY_INITIAL_DELAY_SLOW = 2000
  export const RETRY_INITIAL_DELAY_FAST = 20
  export const RETRY_BACKOFF_FACTOR = 2
  export const RETRY_MAX_DELAY_NO_HEADERS_SLOW = 30_000
  export const RETRY_MAX_DELAY_NO_HEADERS_FAST = 100
  export const RETRY_MAX_DELAY = 2_147_483_647 // max 32-bit signed integer for setTimeout
  // Universal cap applied to every returned delay, including header-driven ones,
  // so test stubs with retry-after-ms: 10000 still resolve quickly under FAST_RETRY.
  // Spec: project/software/opencode/specification/contract/session-retry-policy#Fast-retry cap
  export const RETRY_FAST_MAX_HEADER_MS = 100

  // Back-compat aliases — existing callers read these constants. They now resolve
  // at access time via getters so tests can flip OPENCODE_FAST_RETRY mid-suite.
  export const RETRY_INITIAL_DELAY = RETRY_INITIAL_DELAY_SLOW
  export const RETRY_MAX_DELAY_NO_HEADERS = RETRY_MAX_DELAY_NO_HEADERS_SLOW

  function initialDelay() {
    return isFastRetry() ? RETRY_INITIAL_DELAY_FAST : RETRY_INITIAL_DELAY_SLOW
  }
  function maxDelayNoHeaders() {
    return isFastRetry() ? RETRY_MAX_DELAY_NO_HEADERS_FAST : RETRY_MAX_DELAY_NO_HEADERS_SLOW
  }
  function cap(ms: number) {
    const hard = Math.min(ms, RETRY_MAX_DELAY)
    return isFastRetry() ? Math.min(hard, RETRY_FAST_MAX_HEADER_MS) : hard
  }

  export function delay(attempt: number, error?: MessageV2.APIError) {
    if (error) {
      const headers = error.data.responseHeaders
      if (headers) {
        const retryAfterMs = headers["retry-after-ms"]
        if (retryAfterMs) {
          const parsedMs = Number.parseFloat(retryAfterMs)
          if (!Number.isNaN(parsedMs)) {
            return cap(parsedMs)
          }
        }

        const retryAfter = headers["retry-after"]
        if (retryAfter) {
          const parsedSeconds = Number.parseFloat(retryAfter)
          if (!Number.isNaN(parsedSeconds)) {
            // convert seconds to milliseconds
            return cap(Math.ceil(parsedSeconds * 1000))
          }
          // Try parsing as HTTP date format
          const parsed = Date.parse(retryAfter) - Date.now()
          if (!Number.isNaN(parsed) && parsed > 0) {
            return cap(Math.ceil(parsed))
          }
        }

        return cap(initialDelay() * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1))
      }
    }

    return cap(Math.min(initialDelay() * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1), maxDelayNoHeaders()))
  }

  export function isAuth401(error: Err): boolean {
    if (!MessageV2.APIError.isInstance(error)) return false
    if (error.data.statusCode === 401) return true
    if (error.data.responseBody?.includes("authentication_error")) return true
    return false
  }

  export function retryable(error: Err) {
    const d = error.data && typeof error.data === "object" ? (error.data as Record<string, unknown>) : undefined
    const message = typeof d?.message === "string" ? d.message : undefined
    const responseBody = typeof d?.responseBody === "string" ? d.responseBody : undefined
    const isRetryable = typeof d?.isRetryable === "boolean" ? d.isRetryable : undefined
    const causeName =
      typeof (error as { cause?: { name?: unknown } } | undefined)?.cause?.name === "string"
        ? (error as { cause?: { name?: string } }).cause?.name
        : undefined
    // context overflow errors should not be retried
    if (MessageV2.ContextOverflowError.isInstance(error)) return undefined
    // stream timeout — retryable transient failure
    if (message?.includes("TimeoutError") || causeName === "TimeoutError") {
      return "Stream timed out"
    }
    // 401 authentication errors are retryable via token refresh
    if (isAuth401(error)) return "Refreshing authentication token"
    if (MessageV2.APIError.isInstance(error)) {
      const apiData = error.data
      if (!apiData.isRetryable) return undefined
      if (apiData.responseBody?.includes("FreeUsageLimitError"))
        return `Free usage exceeded, subscribe to Go https://opencode.ai/go`
      const apiMessage = apiData.message ?? ""
      return apiMessage.includes("Overloaded") ? "Provider is overloaded" : apiMessage || undefined
    }

    const json = iife(() => {
      try {
        if (!message) return undefined
        return JSON.parse(message)
      } catch {
        return undefined
      }
    })
    if (!json || typeof json !== "object") return undefined
    const code = typeof json.code === "string" ? json.code : ""

    if (json.type === "error" && json.error?.type === "too_many_requests") {
      return "Too Many Requests"
    }
    if (code.includes("exhausted") || code.includes("unavailable")) {
      return "Provider is overloaded"
    }
    if (json.type === "error" && typeof json.error?.code === "string" && json.error.code.includes("rate_limit")) {
      return "Rate Limited"
    }
    return undefined
  }

  export type ErrorClass = "halt" | "retry" | "fallback-immediately"

  export function isRateLimited(err: unknown): boolean {
    const error = err as Err
    if (MessageV2.APIError.isInstance(error)) {
      if (error.data.statusCode === 429) return true
      const body = (error.data.responseBody ?? "").toLowerCase()
      const message = (error.data.message ?? "").toLowerCase()
      if (body.includes("too_many_requests")) return true
      if (body.includes("rate_limit")) return true
      if (message.includes("rate limit")) return true
      if (message.includes("too many requests")) return true
    }
    const r = retryable(error)?.toLowerCase() ?? ""
    return r.includes("rate limited") || r.includes("too many requests")
  }

  /**
   * Classify an error for the model-fallback strategy.
   *
   * - `"halt"` — stop entirely; do not retry, do not fall through to next model
   *   (auth failures, invalid prompt, abort, context overflow)
   * - `"fallback-immediately"` — skip retries, advance to next model now
   *   (model not found, quota exhausted)
   * - `"retry"` — apply the retry schedule; fall to next model once cap is hit
   *   (rate limit, overload, 5xx, network issues)
   */
  export function classify(err: unknown): ErrorClass {
    if (err instanceof DOMException && err.name === "AbortError") return "halt"
    if (err instanceof Error && err.name === "TimeoutError") return "retry"

    const error = err as Err
    if (MessageV2.ContextOverflowError.isInstance(error)) return "halt"
    if (isAuth401(error)) return "halt"

    if (err instanceof Error && err.name === "ModelNotFoundError") return "fallback-immediately"

    if (MessageV2.APIError.isInstance(error)) {
      const body = error.data.responseBody ?? ""
      if (body.includes("insufficient_quota") || error.data.message?.includes("insufficient_quota")) {
        return "fallback-immediately"
      }
      if (body.includes("usage_not_included") || body.includes("invalid_prompt")) return "halt"
      if (!error.data.isRetryable) return "halt"
      return "retry"
    }

    if (retryable(error)) return "retry"
    return "halt"
  }

  export function policy(opts: {
    parse: (error: unknown) => Err
    set: (input: { attempt: number; message: string; next: number }) => Effect.Effect<void>
  }) {
    return Schedule.fromStepWithMetadata(
      Effect.succeed((meta: Schedule.InputMetadata<unknown>) => {
        const error = opts.parse(meta.input)
        const message = retryable(error)
        if (!message) return Cause.done(meta.attempt)

        // 401 auth errors: force-refresh the token, but only retry once
        if (isAuth401(error)) {
          if (meta.attempt > 1) return Cause.done(meta.attempt)
          return Effect.gen(function* () {
            const current = yield* Effect.promise(() => ProviderPluginHooks.latestAnthropicToken())
            yield* Effect.promise(() => ProviderPluginHooks.latestAnthropicToken())
            const now = yield* Clock.currentTimeMillis
            yield* opts.set({ attempt: meta.attempt, message, next: now + 500 })
            return [meta.attempt, Duration.millis(500)] as [number, Duration.Duration]
          })
        }

        return Effect.gen(function* () {
          const wait = delay(meta.attempt, MessageV2.APIError.isInstance(error) ? error : undefined)
          const now = yield* Clock.currentTimeMillis
          yield* opts.set({ attempt: meta.attempt, message, next: now + wait })
          return [meta.attempt, Duration.millis(wait)] as [number, Duration.Duration]
        })
      }),
    )
  }
}
