import type { IConfigLoader } from "../../config/ports.js"
import { configLoader as defaultConfigLoader } from "../../config/config.js"

export function readReasoningConfig(workspaceRoot: string, loader: IConfigLoader = defaultConfigLoader) {
  const cfg = loader.readConfig(workspaceRoot)
  return {
    enabled: cfg.llmReasoning?.enabled ?? false,
    baseURL: cfg.llmReasoning?.baseURL ?? "https://qpilot-api.qualcomm.com/v1",
    model: cfg.llmReasoning?.model ?? "qpilot/anthropic::claude-4-6-sonnet",
    fallbackModels: cfg.llmReasoning?.fallbackModels ?? ["qpilot/anthropic::claude-4-6-sonnet"],
    apiKeyEnv: cfg.llmReasoning?.apiKeyEnv ?? "QPILOT_API_KEY",
    maxCallsPerQuery: cfg.llmReasoning?.maxCallsPerQuery ?? 8,
    maxAttemptsPerModel: cfg.llmReasoning?.maxAttemptsPerModel ?? 2,
    backoffBaseMs: cfg.llmReasoning?.backoffBaseMs ?? 500,
    backoffMaxMs: cfg.llmReasoning?.backoffMaxMs ?? 4000,
    ruleFile: cfg.llmReasoning?.ruleFile ?? "doc/atomic/skill/indirect-caller-reasoning-rules.md",
  }
}
