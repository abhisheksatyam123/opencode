import type { ModelMessage } from "ai"
import { mergeDeep, unique } from "remeda"
import type { Provider } from "@/provider/provider"
import { CacheFlags } from "@/provider/cache-flags"
import { SessionCacheState } from "@/provider/session-cache-state"
import { qualcommRoute } from "./request-shaping-helpers"

export function supportsCacheMarkers(model: Provider.Model): boolean {
  const npm = model.api.npm
  if (npm === "@ai-sdk/gateway") return false
  if (npm === "@ai-sdk/anthropic") return true
  if (npm === "@ai-sdk/google-vertex/anthropic") return true
  if (npm === "@openrouter/ai-sdk-provider") return true
  if (npm === "@ai-sdk/amazon-bedrock") return true
  if (npm === "@ai-sdk/github-copilot") return true
  // Fall back to id-based heuristics for providerIDs that don't normalize
  // their npm tag. Anthropic-on-litellm/anthropic-on-custom-gateway flow
  // through here.
  if (model.providerID === "anthropic") return true
  if (model.providerID === "google-vertex-anthropic") return true
  if ((model.providerID === "qpilot" || model.providerID === "qgenie") && qualcommRoute(model) === "anthropic")
    return true
  if (model.providerID.includes("bedrock")) return true
  if (model.providerID.includes("copilot")) return true
  if (model.api.id.includes("anthropic") || model.api.id.includes("claude")) return true
  if (model.id.includes("anthropic") || model.id.includes("claude")) return true
  return false
}

export function applyCaching(msgs: ModelMessage[], model: Provider.Model, sessionID?: string): ModelMessage[] {
  // CacheFlags gate: check opt-out env vars. Decision is latched per-session
  // via SessionCacheState so a mid-session env-var change doesn't flip the
  // cache TTL and bust the server-side prompt cache.
  const markersEnabled = SessionCacheState.get(sessionID ?? "", "markersEnabled", () => !CacheFlags.isDisabled(model))
  if (!markersEnabled) return msgs

  // Phase 1f — rolling user|tool cache marker strategy.
  //
  // Cache markers are placed on:
  // 1. First 2 system messages (agent prompt half stays stable across turns,
  //    highest hit rate of any breakpoint).
  // 2. Last 2 user|tool messages (rolling window of the most recent
  //    non-system turns). This captures the latest user request and any
  //    tool results, enabling cache reuse across follow-up turns without
  //    paying write cost on ephemeral assistant chunks that won't be read
  //    again.
  const system = msgs.filter((msg) => msg.role === "system").slice(0, 2)
  const rollingTargets = msgs.filter((msg) => msg.role === "user" || msg.role === "tool").slice(-2)

  const providerOptions = {
    anthropic: {
      cacheControl: { type: "ephemeral" },
    },
    openrouter: {
      cacheControl: { type: "ephemeral" },
    },
    bedrock: {
      cachePoint: { type: "default" },
    },
    openaiCompatible: {
      cache_control: { type: "ephemeral" },
    },
    copilot: {
      copilot_cache_control: { type: "ephemeral" },
    },
  }

  for (const msg of unique([...system, ...rollingTargets])) {
    const useMessageLevelOptions =
      model.providerID === "anthropic" ||
      model.providerID.includes("bedrock") ||
      model.api.npm === "@ai-sdk/amazon-bedrock"
    const shouldUseContentOptions = !useMessageLevelOptions && Array.isArray(msg.content) && msg.content.length > 0

    if (shouldUseContentOptions) {
      const lastContent = msg.content[msg.content.length - 1]
      if (
        lastContent &&
        typeof lastContent === "object" &&
        (lastContent as { type?: string }).type !== "tool-approval-request" &&
        (lastContent as { type?: string }).type !== "tool-approval-response"
      ) {
        const contentWithOptions = lastContent as { providerOptions?: Record<string, any> }
        contentWithOptions.providerOptions = mergeDeep(contentWithOptions.providerOptions ?? {}, providerOptions)
        continue
      }
    }

    msg.providerOptions = mergeDeep(msg.providerOptions ?? {}, providerOptions)
  }

  return msgs
}
