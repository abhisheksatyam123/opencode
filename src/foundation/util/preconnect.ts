// util/preconnect.ts
//
// Generalized TCP+TLS preconnect helper (parity gap-52).
//
// PROVENANCE: ported from
// `instructkr-claude-code/src/utils/apiPreconnect.ts` (71 LOC).
// The Claude reference is hardcoded to the Anthropic API endpoint.
// opencode is a multi-provider system (15+ providers across
// Anthropic / OpenAI / Vertex / Bedrock / Azure / Copilot / etc.),
// so the port generalizes the pattern: the CALLER passes whichever
// URL it wants to warm, the helper handles dedup + skip-reasons +
// fire-and-forget HEAD.
//
// THE PROBLEM
// ===========
// The TCP+TLS handshake to a model API is ~100-200ms that normally
// blocks inside the first API call. Without preconnect, every cold
// start pays this latency on the first request. For interactive
// users typing a prompt, that's ~150ms of wasted wall-clock time
// before the first token streams; for non-interactive `opencode run`
// invocations, it adds directly to the total runtime.
//
// THE FIX
// =======
// `Preconnect.warm(url)` fires a HEAD request at the URL during init
// (or anywhere with downtime to spare). The TCP+TLS handshake happens
// in parallel with action-handler / startup work. Bun's fetch shares
// a global keep-alive connection pool, so the real API request later
// reuses the warmed connection.
//
// `Preconnect.warmMany(urls)` warms multiple URLs in parallel —
// useful when opencode boots with several providers enabled and the
// caller wants to warm them all up front.
//
// `Preconnect.shouldSkip(env?)` returns a non-null skip reason
// (string) if preconnect would be wrong to do in the current
// environment — proxy / mTLS / unix-socket configurations route
// through a custom dispatcher that doesn't share the global pool, so
// warming the global pool would be wasted bytes (or worse, lock the
// wrong cert store before NODE_EXTRA_CA_CERTS is applied).
//
// USAGE
// =====
// ```ts
// import { Preconnect } from "./util/preconnect"
//
// // Single URL — most common
// Preconnect.warm("https://api.anthropic.com")
//
// // Multiple providers
// Preconnect.warmMany([
//   "https://api.anthropic.com",
//   "https://api.openai.com",
//   "https://generativelanguage.googleapis.com",
// ])
//
// // Check skip reason for diagnostics
// const skipReason = Preconnect.shouldSkip()
// if (skipReason) {
//   log.info("preconnect skipped", { reason: skipReason })
// }
// ```
//
// THIS IS NOT
// ===========
// Not a connection pool. Doesn't manage sockets, doesn't queue
// requests. Bun's fetch already does global keep-alive — this just
// warms the pool by firing a no-op HEAD that the real request can
// reuse the underlying TCP+TLS state from.
//
// Not provider-aware. Doesn't know about Anthropic vs OpenAI vs
// Vertex. The caller passes the URL. This is by design — opencode's
// provider configuration lives elsewhere and the preconnect helper
// stays a leaf utility.
//
// Errors are ignored — preconnect is fire-and-forget. A failed
// preconnect shouldn't crash startup; the real request will
// handshake fresh if needed.

import { Log } from "./log"

const log = Log.create({ service: "preconnect" })

export namespace Preconnect {
  /**
   * Module-level dedup set: each URL is preconnected at most once
   * per process. Repeated calls with the same URL are no-ops.
   */
  const fired = new Set<string>()

  /**
   * Default request timeout for the preconnect HEAD. The fetch is
   * fire-and-forget so this only bounds how long we wait before
   * giving up — the real API request will handshake fresh if
   * preconnect didn't land in time.
   */
  export const DEFAULT_TIMEOUT_MS = 10_000

  /**
   * Inspect what URLs have been warmed in this process. Returns
   * a snapshot — mutating the result does not affect the internal
   * set. Used for tests + the future `opencode debug preconnect`
   * inspector.
   */
  export function state(): { warmedUrls: readonly string[]; count: number } {
    const warmed = Array.from(fired)
    return { warmedUrls: warmed, count: warmed.length }
  }

  /**
   * Test escape hatch: clear the dedup set so a test can re-run
   * preconnect from scratch. Tests should call this in `beforeEach`.
   */
  export function _resetState(): void {
    fired.clear()
  }

  /**
   * Check whether preconnect should be skipped given the current
   * environment. Returns a non-null skip reason string when a
   * non-default transport is configured — preconnect would warm
   * the wrong pool in those cases.
   *
   * Skip reasons (in priority order):
   *   - "proxy_https" — HTTPS_PROXY / https_proxy set
   *   - "proxy_http"  — HTTP_PROXY / http_proxy set
   *   - "unix_socket" — *_UNIX_SOCKET env var set (any provider)
   *   - "mtls"        — *_CLIENT_CERT / *_CLIENT_KEY env vars set
   *
   * Returns null if no skip condition fires (preconnect is OK).
   */
  export function shouldSkip(env: NodeJS.ProcessEnv = process.env): string | null {
    if (env.HTTPS_PROXY || env.https_proxy) return "proxy_https"
    if (env.HTTP_PROXY || env.http_proxy) return "proxy_http"
    // Match any *_UNIX_SOCKET env var so opencode's per-provider
    // unix-socket configs all trigger the skip.
    for (const key of Object.keys(env)) {
      if (key.endsWith("_UNIX_SOCKET") && env[key]) return "unix_socket"
      if (key.endsWith("_CLIENT_CERT") && env[key]) return "mtls"
      if (key.endsWith("_CLIENT_KEY") && env[key]) return "mtls"
    }
    return null
  }

  /**
   * Fire a HEAD request at the URL to warm the TCP+TLS handshake.
   * The connection enters Bun's keep-alive pool so a subsequent
   * full request to the same host reuses it.
   *
   * Fire-and-forget: the function returns immediately, the actual
   * fetch runs in the background. Errors (DNS failure, connection
   * refused, timeout) are caught and logged but never thrown — a
   * failed preconnect should never crash startup.
   *
   * Deduped: each URL is warmed at most once per process. Repeated
   * calls with the same URL are silent no-ops.
   *
   * Skipped if `shouldSkip()` returns a reason — proxy / mTLS /
   * unix-socket configurations route through custom dispatchers
   * that don't share the global pool.
   *
   * @param url The full URL to warm (origin is sufficient)
   * @param opts.timeoutMs Optional override for the default timeout
   * @returns The skip reason (string) if skipped, "deduped" if
   *          already warmed, or "fired" if the HEAD was dispatched
   */
  export function warm(url: string, opts: { timeoutMs?: number } = {}): "fired" | "deduped" | string {
    if (!url) return "no_url"

    // Dedup against the resolved origin so passing https://api.x.com
    // and https://api.x.com/v1/messages don't both fire.
    let originKey: string
    try {
      originKey = new URL(url).origin
    } catch {
      return "invalid_url"
    }

    if (fired.has(originKey)) return "deduped"

    const skipReason = shouldSkip()
    if (skipReason) {
      log.info("preconnect skipped", { url: originKey, reason: skipReason })
      return skipReason
    }

    fired.add(originKey)

    const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

    // Fire and forget. HEAD means no response body — the connection
    // is eligible for keep-alive pool reuse immediately after headers
    // arrive. Errors are caught and logged but never thrown.
    void (async () => {
      try {
        await fetch(originKey, {
          method: "HEAD",
          signal: AbortSignal.timeout(timeout),
        })
        log.info("preconnect fired", { url: originKey })
      } catch (e) {
        // Don't crash on preconnect failure — the real request
        // will handshake fresh if needed.
        log.info("preconnect failed", { url: originKey, error: (e as Error).message })
      }
    })()

    return "fired"
  }

  /**
   * Warm multiple URLs in parallel. Each URL is processed
   * independently via `warm()` with the same dedup + skip semantics.
   * Returns a map of url → result for diagnostics.
   *
   * Useful when opencode boots with several providers enabled and
   * the caller wants to warm them all up front in one call.
   */
  export function warmMany(urls: readonly string[], opts: { timeoutMs?: number } = {}): Record<string, string> {
    const results: Record<string, string> = {}
    for (const url of urls) {
      results[url] = warm(url, opts)
    }
    return results
  }
}
