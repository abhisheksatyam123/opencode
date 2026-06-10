// provider/upstream.ts
//
// Upstream detection for proxy providers (qpilot, qgenie) and their
// associated per-upstream caching strategy.
//
// THE PROBLEM
// ===========
// qpilot and qgenie are PROXY endpoints that present a single OpenAI-
// compatible wire surface but route to multiple backend providers based on
// the model ID prefix:
//
//   <proxy>/<upstream>::<model> → upstream-specific provider family
// Each upstream has a fundamentally different caching mechanism:
//   - Azure / OpenAI:  prompt_cache_key (string, fire-and-forget)
//   - Anthropic:       cache_control markers on content blocks
//   - Vertex Gemini:   cachedContents/{name} (named server resource that
//                      requires a separate REST call to create)
//   - Vertex Anthropic: same as Anthropic
//   - Bedrock:         cachePoint markers (per-block)
//
// The OpenAI-compatible wire format CANNOT carry cache_control markers,
// cachePoint blocks, or cachedContents references — only prompt_cache_key
// and metadata fields. So opencode can only emit cache hints that:
//   (a) the upstream natively reads via the OpenAI-compatible wire shape, OR
//   (b) the qpilot/qgenie proxy explicitly translates into upstream-specific
//       caching on its server-side dispatch layer.
//
// This module is the TRUTH SOURCE for which upstream a model targets and
// which cache strategy is achievable from the client side. It does NOT make
// the proxy translate hints — that requires server-side cooperation. It
// DOES ensure opencode never emits meaningless hints to upstreams that
// don't honor them, and it DOES emit best-effort metadata + headers that
// a cooperating proxy can use.
//
// See notes/project/software/opencode/decision/proxy-cache-contract.md for
// the full client↔proxy contract this module implements on the client side.

export type Upstream =
  | "azure-openai" // Azure/OpenAI-compatible cache key works directly
  | "openai" // direct OpenAI provider — same as azure-openai
  | "anthropic" // Anthropic-family models need cache_control markers
  | "vertex-gemini" // Vertex Gemini-family models use cachedContents resources
  | "vertex-anthropic" // Vertex Anthropic-family models use Anthropic markers
  | "bedrock-anthropic" // bedrock::anthropic.* — cachePoint markers
  | "bedrock-nova" // bedrock::amazon.nova-* — cachePoint markers
  | "unknown" // unrecognized — fall back to generic key

/**
 * Detect the upstream provider family from a (possibly proxy-prefixed)
 * model ID. Pure function, no IO.
 *
 * Convention: proxy providers (qpilot, qgenie) use composite IDs of the
 * form `<upstream>::<model_name>`. Native
 * providers use unprefixed IDs that we match heuristically by family
 * keywords (claude/gemini/gpt/nova).
 *
 * Returns "unknown" for IDs that don't match any pattern. Callers should
 * fall back to a conservative default (universal cache key) for unknown.
 */
export function detectUpstream(modelID: string): Upstream {
  if (!modelID) return "unknown"
  const id = modelID.toLowerCase()

  // 1) Composite-prefix detection for proxy-routed models. The order
  //    matters — vertex::claude-* must match BEFORE the bare "claude"
  //    fallback so we route it to vertex-anthropic.
  if (id.startsWith("azure::") || id.startsWith("azure/")) return "azure-openai"
  if (id.startsWith("openai::") || id.startsWith("openai/")) return "openai"

  if (id.startsWith("vertex::") || id.startsWith("vertexai::")) {
    if (id.includes("gemini")) return "vertex-gemini"
    if (id.includes("claude")) return "vertex-anthropic"
    // Unknown vertex model — fall through
  }
  if (id.startsWith("google::")) {
    if (id.includes("gemini")) return "vertex-gemini"
  }

  if (id.startsWith("bedrock::")) {
    if (id.includes("anthropic") || id.includes("claude")) return "bedrock-anthropic"
    if (id.includes("nova") || id.includes("amazon")) return "bedrock-nova"
  }

  if (id.startsWith("anthropic::")) return "anthropic"

  // 2) Heuristic fallback for unprefixed model IDs (native providers).
  //    These match the family keywords used by models.dev / opencode.json.
  if (id.includes("claude") || id.includes("anthropic")) return "anthropic"
  if (id.includes("gemini")) return "vertex-gemini"
  if (id.includes("nova-pro") || id.includes("nova-lite") || id.includes("amazon.nova")) return "bedrock-nova"
  if (id.includes("gpt-") || id.includes("o1") || id.includes("o3") || id.includes("codex")) return "azure-openai"

  return "unknown"
}

/**
 * Per-upstream cache strategy. Tells the client which cache hints to emit
 * for a request based on what the upstream actually honors via the OpenAI-
 * compatible wire shape (and what a cooperating proxy could translate).
 *
 *   promptCacheKey: emit `prompt_cache_key` body field (snake_case for
 *     openai-compatible pass-through, plus camelCase under the openai
 *     namespace for the @ai-sdk/openai schema). Universal — every upstream
 *     that has any concept of session-cohort caching honors this directly
 *     OR can be made to via proxy translation.
 *
 *   metadataHint: emit `metadata.cache_session_key` and
 *     `metadata.cache_upstream` body fields. The OpenAI-compatible
 *     metadata field is passed through to the upstream by most proxies.
 *     A cooperating proxy can use these to apply upstream-specific
 *     caching (e.g. translate to cache_control markers for Anthropic,
 *     manage cachedContents lifecycle for Gemini).
 *
 *   customHeader: emit X-Opencode-Cache-* headers. Universal opt-in for
 *     proxies that read headers as routing hints. Header-based hints are
 *     the most resilient — strict body-validating proxies that 400 on
 *     unknown body fields still tolerate unknown headers.
 *
 *   includeEncryptedReasoning: emit `include: ["reasoning.encrypted_content"]`
 *     so the upstream returns encrypted reasoning blocks that opencode can
 *     forward back on the next turn. Required for reasoning models on the
 *     Responses API (codex, gpt-5, o1, o3) to maintain chain-of-thought
 *     across cached turns instead of re-deriving from scratch each turn.
 */
export type CacheStrategy = {
  promptCacheKey: boolean
  metadataHint: boolean
  customHeader: boolean
  includeEncryptedReasoning: boolean
}

export function cacheStrategyForUpstream(upstream: Upstream): CacheStrategy {
  switch (upstream) {
    case "azure-openai":
    case "openai":
      // Native cache_key support. Reasoning models also benefit from
      // forwarding encrypted reasoning blocks across turns.
      return {
        promptCacheKey: true,
        metadataHint: false, // not needed — server natively reads cache_key
        customHeader: false, // not needed — direct path
        includeEncryptedReasoning: true,
      }

    case "anthropic":
    case "vertex-anthropic":
      // Anthropic backends use cache_control markers, which the OpenAI-
      // compatible wire format can't carry. Send the cache_key as a
      // hint for the proxy to translate. Add metadata + custom headers
      // so the proxy has multiple ways to detect cache intent.
      // No reasoning encrypted_content — Anthropic uses thinking blocks
      // which are a different mechanism (and opencode handles those
      // separately via thought-signature.ts).
      return {
        promptCacheKey: true,
        metadataHint: true,
        customHeader: true,
        includeEncryptedReasoning: false,
      }

    case "bedrock-anthropic":
    case "bedrock-nova":
      // Bedrock uses cachePoint markers — same situation as Anthropic
      // direct: client can't emit them via OpenAI-compatible wire.
      // Best effort: cache_key hint + metadata + custom headers for
      // proxy to translate.
      return {
        promptCacheKey: true,
        metadataHint: true,
        customHeader: true,
        includeEncryptedReasoning: false,
      }

    case "vertex-gemini":
      // Gemini caching requires server-side cachedContents lifecycle
      // (separate REST call to create, then reference by name). The
      // client cannot initiate this through the OpenAI-compatible wire
      // format. Emit metadata + headers so a cooperating proxy can
      // create a cachedContents resource on first request and reference
      // it on subsequent requests. DO NOT emit prompt_cache_key — Gemini
      // doesn't read it and emitting it would only confuse the proxy.
      return {
        promptCacheKey: false,
        metadataHint: true,
        customHeader: true,
        includeEncryptedReasoning: false,
      }

    case "unknown":
      // Conservative default: just send the cache_key. Most providers
      // either honor it (cache hit) or ignore it (no harm). Don't add
      // headers/metadata that an unknown server might choke on.
      return {
        promptCacheKey: true,
        metadataHint: false,
        customHeader: false,
        includeEncryptedReasoning: false,
      }
  }
}

/**
 * Build the X-Opencode-Cache-* header set for a model. Returns an empty
 * object when the upstream's strategy doesn't use custom headers (so the
 * caller can spread it unconditionally).
 *
 * The headers are defensive — they ride alongside body fields so a proxy
 * with strict body validation still receives the hints via headers.
 */
export function buildCacheHeaders(input: {
  model: { api: { id: string }; providerID: string }
  sessionID: string
}): Record<string, string> {
  const upstream = detectUpstream(input.model.api.id)
  const strategy = cacheStrategyForUpstream(upstream)
  if (!strategy.customHeader) return {}
  return {
    "X-Opencode-Cache-Key": input.sessionID,
    "X-Opencode-Cache-Strategy": upstream,
    "X-Opencode-Cache-Stable-Prefix": "1",
  }
}
