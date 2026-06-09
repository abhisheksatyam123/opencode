/**
 * Agent L4 — Port contract
 *
 * Exposes:
 *   - AgentPortSchema                        — Zod schema documenting port shape
 *   - AgentInfoSchema                        — Zod schema for Agent.Info
 *   - AgentPort interface                    — get/list/defaultAgent/generate surface
 *   - Agent.Service Effect.Tag               — DI tag for Effect Layer
 *   - SessionPrompt.Service Effect.Tag       — secondary DIP seam (9 deps fanout)
 *
 * Depends only on Foundation L0 + zod + effect. No peer L4 imports.
 * NO imports from workflow, surface, init.
 *
 * session/prompt.ts is the SECONDARY DIP seam (9 deps fanout per Phase A DA3).
 * Declared as Effect.Tag interface here so callers can depend on the port
 * without importing the concrete session/prompt.ts implementation.
 */

import z from "zod"
import { ServiceMap } from "effect"

// ── Port schema ───────────────────────────────────────────────────────────────

export const AgentPortSchema = z.object({
  version: z.literal("1.0.0"),
})
export type AgentPortSchema = z.infer<typeof AgentPortSchema>

// ── Agent info schema (minimal, for port contract) ────────────────────────────

export const AgentInfoSchema = z.object({
  name: z.string().min(1),
  tier: z.enum(["0", "1", "2"]),
  mode: z.enum(["subagent", "primary", "all"]),
  hidden: z.boolean().optional(),
  native: z.boolean().optional(),
  description: z.string().optional(),
})
export type AgentInfo = z.infer<typeof AgentInfoSchema>

// ── Port interface ────────────────────────────────────────────────────────────

export interface AgentPort {
   
  readonly get: (agent: string) => any
   
  readonly list: () => any
   
  readonly defaultAgent: () => any
   
  readonly generate: (input: any) => any
}

// ── Effect.Tag (DI service) ───────────────────────────────────────────────────

export namespace Agent {
  /**
   * Effect.Tag for the Agent service.
   * Tag key "@opencode/Agent" MUST match agent/agent.ts to avoid
   * duplicate service registrations at the composition root.
   */
  export class Service extends ServiceMap.Service<Service, AgentPort>()("@opencode/Agent") {}
}

// ── SessionPrompt secondary DIP seam ─────────────────────────────────────────

export const SessionPromptPortSchema = z.object({
  version: z.literal("1.0.0"),
})
export type SessionPromptPortSchema = z.infer<typeof SessionPromptPortSchema>

export interface SessionPromptPort {
   
  readonly assertNotBusy: (sessionID: any) => any
   
  readonly cancel: (sessionID: any) => any
   
  readonly prompt: (input: any) => any
   
  readonly loop: (input: any) => any
   
  readonly shell: (input: any) => any
   
  readonly command: (input: any) => any
   
  readonly resolvePromptParts: (template: string) => any
}

export namespace SessionPrompt {
  /**
   * Effect.Tag for the SessionPrompt service (secondary DIP seam).
   * Tag key "@opencode/SessionPrompt" MUST match session/prompt.ts.
   */
  export class Service extends ServiceMap.Service<Service, SessionPromptPort>()("@opencode/SessionPrompt") {}
}
