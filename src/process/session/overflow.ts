import type { Config } from "@/config/config"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { MessageV2 } from "@/process/session/message-v2"
import { Policy } from "@/permission/policy"

const COMPACTION_BUFFER = 20_000

// Default token count at which auto-compaction fires regardless of model
// context size. Keeps sessions predictable across all providers and agents.
//
// Overflow trigger precedence (policy registry primary):
//   1. cfg.compaction.trigger_tokens                    user override (highest)
//   2. Policy.get("compaction").values.token_threshold  vault-loaded card
//   3. DEFAULT_TRIGGER_TOKENS                            in-code last-resort
//
// Step 2 folds in `DEFAULT_POLICY_VALUES.compaction.token_threshold = 400_000`
// for empty-vault degraded boot, so steps 2 and 3 collapse to the same
// answer when the registry has no vault content. Migration-safe: vault
// empty ⇒ behavior byte-identical to pre-I2.2.
export const DEFAULT_TRIGGER_TOKENS = 400_000

export function isOverflow(input: { cfg: Config.Info; tokens: MessageV2.Assistant["tokens"]; model: Provider.Model }) {
  if (input.cfg.compaction?.auto === false) return false
  const context = input.model.limit.context
  if (context === 0) return false

  const count =
    input.tokens.total || input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write

  // If trigger_tokens is set (or defaulted), use it as the hard cap.
  // This makes compaction fire at a predictable token count for all agents
  // regardless of model context window size.
  const triggerTokens =
    input.cfg.compaction?.trigger_tokens ?? Policy.get("compaction")?.values.token_threshold ?? DEFAULT_TRIGGER_TOKENS
  if (triggerTokens > 0 && count >= triggerTokens) return true

  const reserved =
    input.cfg.compaction?.reserved ?? Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model))
  const usable = input.model.limit.input
    ? input.model.limit.input - reserved
    : context - ProviderTransform.maxOutputTokens(input.model)
  return count >= usable
}
