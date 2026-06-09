/**
 * Agent L4 — Concrete adapter
 *
 * Wraps the existing Agent implementation as named exports following
 * the Process/Tool L3 pattern.
 *
 * Depends on:
 *   - ./agent.ts         (Agent — concrete impl)
 *   - ./prompt-loader.ts  (AgentPromptLoader)
 *   - ./agent-roles.ts   (AgentRoles)
 *   - ./runtime-roles.ts (RuntimeRoles)
 *   - ./dispatch-roles.ts (DispatchRoles)
 *   - ../mentor/         (Mentor)
 *   - ../orchestrator/watchdog.ts (watchdog — folded from orchestrator/)
 *   - ./port.ts          (Agent.Service tag, AgentPort)
 *   - effect             (Layer)
 *
 * orchestrator/watchdog.ts IS imported by session/prompt.ts (1 caller).
 * NOT dead code. DA2 dead-module report was incorrect.
 */

import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { type AgentPort } from "@/agent/port"
import { Agent as AgentTag } from "@/agent/port"

// ── Concrete adapter implementation ───────────────────────────────────────────

export const AgentAdapterLayer: Layer.Layer<AgentTag.Service, never, Agent.Service> = Layer.effect(
  AgentTag.Service,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const port: AgentPort = {
      get: (name: string) => agent.get(name),
      list: () => agent.list(),
      defaultAgent: () => agent.defaultAgent(),

      generate: (input: any) => agent.generate(input),
    }
    return port
  }),
)

// Re-export concrete namespace for callers that need direct access
export { Agent } from "@/agent/agent"

// ── Sub-module re-exports ─────────────────────────────────────────────────────

export { AgentPromptLoader } from "@/agent/prompt-loader"
export { AgentRoles } from "@/agent/agent-roles"
export { RuntimeRoles } from "@/agent/runtime-roles"
export { DispatchRoles } from "@/agent/dispatch-roles"

// mentor/ folds into Agent L4 per migration-map
export * from "@/agent/mentor"
