// session/context-management.ts
//
// Provider-agnostic context-management dispatch (Phase 1a of the
// token-efficiency overhaul).
//
// "Context management" here means provider-side mechanisms that prune or
// rewrite the conversation history at request time, BEFORE the model sees
// it — eliminating the cost of opencode's reactive overflow→catch→compact→
// retry loop. Today only Anthropic ships such a feature
// (`clear_tool_uses_20250919`), but the abstraction here is intentionally
// generic so other providers (Vertex, Bedrock, OpenAI Responses, Gemini)
// can drop in their own strategies as they ship them.
//
// Architecture:
//   1. STRATEGIES is a registry of named provider strategies. Each entry
//      knows how to detect its provider, build a strategy-specific config
//      object, and where to inject that object into the AI SDK
//      providerOptions map.
//   2. `build({model, cfg})` walks the registry, picks the first strategy
//      that claims the model, and returns a generic { sdkKey, options }
//      pair the call site merges blindly. No call site sees provider names.
//   3. When NO strategy claims the model, build() returns undefined and
//      the request flows through opencode's existing client-side
//      compaction path (Phase 1b/1c/1d/1g) — which IS provider-agnostic.
//
// Reference for the Anthropic strategy shape:
//   instructkr-claude-code/src/services/compact/apiMicrocompact.ts
//   node_modules/@ai-sdk/anthropic/src/anthropic-messages-language-model.ts:434

import type { Provider } from "@/provider/provider"
import type { Config } from "@/config/config"

export namespace ContextManagement {
  // ── Defaults shared across providers ─────────────────────────────────────
  // Trigger threshold and target are tuned for the Anthropic beta but used
  // as sensible defaults for any future provider with similar semantics.
  export const DEFAULT_TRIGGER_TOKENS = 400_000
  export const DEFAULT_TARGET_TOKENS = 40_000

  // Tools whose tool_use blocks must NEVER be cleared by any provider's
  // server-side context manager. Two reasons a tool ends up here:
  //   1. Durable-state path (todo/task/write) — clearing
  //      these would erase the multi-agent coordination surface.
  //   2. The tool's inputs ARE the durable record of what changed
  //      (edit/write/multiedit/apply_patch). Clearing them would leave
  //      the model with "I edited file X" and no memory of the change.
  // Provider strategies should respect this list when their API supports
  // a per-tool exclusion list.
  export const PROTECTED_TOOLS = [
    // durable state
    "todo",
    "task",
    // edit history
    "edit",
    "write",
    "multiedit",
    "apply_patch",
    "notebook_edit",
  ]

  // ── Strategy result shape ────────────────────────────────────────────────
  // build() returns a `name` (informational, surfaces in logs and tests so
  // we can see which strategy fired) and an `options` map that the call
  // site merges into the per-request params.options bag at TOP LEVEL.
  // ProviderTransform.providerOptions() then wraps params.options under the
  // model's SDK key automatically — so the strategy doesn't need to know
  // or care which provider it's targeting at the merge layer.
  //
  // The strategy.matches() check guarantees options shape and target SDK
  // are compatible by the time build() runs.
  export type BuildResult = {
    name: string
    options: Record<string, any>
  }

  // ── Strategy registry ────────────────────────────────────────────────────
  // Each strategy is independent. To add a new provider, append a new
  // strategy and verify there is no overlap with existing ones (the first
  // matching strategy wins).
  type Strategy = {
    name: string
    matches(model: Provider.Model): boolean
    build(input: { model: Provider.Model; cfg: Config.Info }): BuildResult | undefined
  }

  // Anthropic clear_tool_uses_20250919 strategy. The AI SDK accepts the
  // config under providerOptions.anthropic.contextManagement and forwards
  // it to the API after adding the beta header.
  const anthropicStrategy: Strategy = {
    name: "anthropic.clear_tool_uses_20250919",
    matches(model) {
      if (model.api.npm === "@ai-sdk/gateway") return false
      if (model.api.npm === "@ai-sdk/anthropic") return true
      if (model.api.npm === "@ai-sdk/google-vertex/anthropic") return true
      if (model.providerID === "anthropic") return true
      if (model.providerID === "google-vertex-anthropic") return true
      // Anthropic-on-litellm and similar pass through here.
      if (model.api.id.includes("anthropic") || model.api.id.includes("claude")) return true
      if (model.id.includes("anthropic") || model.id.includes("claude")) return true
      return false
    },
    build({ cfg }) {
      // Default-on for Anthropic-family models. The strategy is a pure win
      // (server-side tool-use clearing eliminates the overflow→catch→retry
      // loop) and the AI SDK already supports the beta header. Users can
      // opt OUT by setting `compaction.api_clear_tool_uses.enabled: false`
      // in opencode.json — useful when running against a custom Anthropic
      // gateway that doesn't pass the beta header through.
      const apiCfg = cfg.compaction?.api_clear_tool_uses
      if (apiCfg?.enabled === false) return undefined

      const trigger = apiCfg?.trigger_tokens ?? DEFAULT_TRIGGER_TOKENS
      const target = apiCfg?.target_tokens ?? DEFAULT_TARGET_TOKENS
      const exclude = apiCfg?.exclude_tools ?? PROTECTED_TOOLS
      // clear_at_least must be smaller than trigger for the API to do useful
      // work — guard against a misconfigured target that would invert the gap.
      const clearAtLeast = Math.max(1, trigger - target)

      return {
        name: anthropicStrategy.name,
        options: {
          contextManagement: {
            edits: [
              {
                type: "clear_tool_uses_20250919",
                trigger: { type: "input_tokens", value: trigger },
                clearAtLeast: { type: "input_tokens", value: clearAtLeast },
                // The AI SDK exposes clearToolInputs as a boolean only
                // (per-tool array isn't in its zod schema). We set it to
                // true and use excludeTools as the inverse selector.
                clearToolInputs: true,
                excludeTools: exclude,
              },
            ],
          },
        },
      }
    },
  }

  // Registry. Order matters — first matching strategy wins.
  // To add a new provider strategy: append to this array.
  const STRATEGIES: Strategy[] = [anthropicStrategy]

  /**
   * Build a context-management config for the current model + cfg.
   *
   * Returns undefined when:
   *   - no registered strategy claims this model, OR
   *   - the matching strategy is disabled in cfg
   *
   * Call sites should merge the result into the per-request options under
   * `result.sdkKey` and pass through unchanged. They MUST NOT inspect
   * `result.options` — its shape is strategy-specific.
   */
  export function build(input: { model: Provider.Model; cfg: Config.Info }): BuildResult | undefined {
    for (const strategy of STRATEGIES) {
      if (!strategy.matches(input.model)) continue
      return strategy.build(input)
    }
    return undefined
  }

  /**
   * Test-only: list registered strategy names. Used by unit tests to verify
   * the registry is wired correctly without exposing the strategy objects.
   */
  export function strategies(): string[] {
    return STRATEGIES.map((s) => s.name)
  }
}
