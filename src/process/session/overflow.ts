import type { Config } from "@/config/config"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { MessageV2 } from "@/process/session/message-v2"
import { Policy } from "@/permission/policy"

export const COMPACTION_BUFFER = 20_000

// Default token count at which auto-compaction fires regardless of model
// context size. Keeps sessions predictable across all providers and agents.
export const DEFAULT_TRIGGER_TOKENS = 400_000

export function getCompactionTriggerTokens(cfg: Config.Info): number {
  return cfg.compaction?.trigger_tokens ?? Policy.get("compaction")?.values.token_threshold ?? DEFAULT_TRIGGER_TOKENS
}

export function getCompactionReservedTokens(cfg: Config.Info, model: Provider.Model): number {
  return cfg.compaction?.reserved ?? Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(model))
}

export function getCompactionUsableTokens(cfg: Config.Info, model: Provider.Model): number {
  const context = model.limit.context
  const reserved = getCompactionReservedTokens(cfg, model)
  const maxOutput = ProviderTransform.maxOutputTokens(model)
  return model.limit.input ? model.limit.input - reserved : context - maxOutput
}

export function isOverflow(input: { cfg: Config.Info; tokens: MessageV2.Assistant["tokens"]; model: Provider.Model }) {
  if (input.cfg.compaction?.auto === false) return false
  const context = input.model.limit.context
  if (context === 0) return false

  const count =
    input.tokens.total || input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write

  // If trigger_tokens is set (or defaulted), use it as the hard cap.
  const triggerTokens = getCompactionTriggerTokens(input.cfg)
  if (triggerTokens > 0 && count >= triggerTokens) return true

  const usable = getCompactionUsableTokens(input.cfg, input.model)
  return count >= usable
}
