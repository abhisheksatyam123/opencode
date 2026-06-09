/**
 * Workflow L4 — Port contract
 *
 * Exposes:
 *   - WorkflowPortSchema / WorkflowSpecSchema / WorkflowPhaseSchema / WorkflowReasonSchema / ArchiveDecisionSchema
 *   - WorkflowPort interface
 *   - Workflow.Service Effect.Tag
 *
 * Depends only on Foundation L0 + zod + effect.
 * NO imports from tool, surface, init.
 */

import z from "zod"
import { ServiceMap, type Effect } from "effect"

export const WorkflowPortSchema = z.object({
  version: z.literal("1.0.0"),
})
export type WorkflowPortSchema = z.infer<typeof WorkflowPortSchema>

export const WorkflowSpecSchema = z.object({
  todoPath: z.string().min(1),
  agent: z.string().min(1),
  prompt: z.string().min(1),
  model: z.string().min(1).optional(),
  background: z.boolean().optional(),
  triggeredBy: z.string().min(1).optional(),
})
export type WorkflowSpec = z.infer<typeof WorkflowSpecSchema>

export const PlanItemSchema = z.object({
  id: z.string().min(1).optional(),
  type: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
})
export type PlanItem = z.infer<typeof PlanItemSchema>

export const WorkflowPhaseSchema = z.object({
  key: z.string().min(1),
  owner: z.string().min(1),
  items: z.array(PlanItemSchema).default([]),
})
export type WorkflowPhase = z.infer<typeof WorkflowPhaseSchema>

export const WorkflowTypeSchema = z.enum(["feature", "bugfix", "refactor", "explore", "chore", "learning"])
export type WorkflowType = z.infer<typeof WorkflowTypeSchema>

export const WorkflowReasonSchema = z.object({
  role: z.string().min(1),
  workflow: WorkflowTypeSchema,
  phases: z.array(z.string().min(1)),
})
export type WorkflowReason = z.infer<typeof WorkflowReasonSchema>

export const ArchiveDecisionSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("archive"),
    reason: z.string().min(1),
  }),
  z.object({
    decision: z.literal("block"),
    reason: z.string().min(1),
    missingCriteria: z.array(z.string().min(1)).min(1),
  }),
])
export type ArchiveDecision = z.infer<typeof ArchiveDecisionSchema>

export const WorkflowErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
})
export type WorkflowError = z.infer<typeof WorkflowErrorSchema>

export interface WorkflowPort {
  readonly dispatch: (spec: WorkflowSpec) => Effect.Effect<void, WorkflowError>
  readonly resolvePhase: (role: string) => Effect.Effect<WorkflowPhase, WorkflowError>
  readonly resolveReason: (role: string) => Effect.Effect<WorkflowReason, WorkflowError>
  readonly archiveGate: (todoPath: string) => Effect.Effect<ArchiveDecision, WorkflowError>
}

export namespace Workflow {
  export class Service extends ServiceMap.Service<Service, WorkflowPort>()("@opencode/Workflow") {}
}
