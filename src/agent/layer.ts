/**
 * Agent L4 — Effect Layer
 *
 * AgentLayer is the single entry point for wiring the Agent module.
 * Import this at the composition root.
 *
 * Provides: Agent.Service (via AgentAdapterLayer)
 * Requires: Agent.Service from agent.ts (which in turn requires Config,
 *           Auth, Provider services)
 *
 * Mirrors the Process/Tool L3 pattern from process/layer.ts etc.
 *
 * Sub-modules folded into Agent L4:
 *   - agent/agent.ts         — Agent service
 *   - agent/prompt-loader.ts  — AgentPromptLoader
 *   - agent/agent-roles.ts   — AgentRoles
 *   - agent/runtime-roles.ts — RuntimeRoles
 *   - agent/dispatch-roles.ts — DispatchRoles
 *   - mentor/                — Mentor overlay
 *   - orchestrator/watchdog.ts — Watchdog decision logic
 */

export { AgentAdapterLayer as AgentLayer } from "@/agent/adapter"
export { Agent } from "@/agent/port"
export { Agent as AgentImpl } from "@/agent/agent"
export { AgentPromptLoader } from "@/agent/prompt-loader"
export { AgentRoles } from "@/agent/agent-roles"
export { RuntimeRoles } from "@/agent/runtime-roles"
export { DispatchRoles } from "@/agent/dispatch-roles"
