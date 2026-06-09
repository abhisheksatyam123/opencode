/**
 * Workflow L4 — Concrete adapter
 *
 * Wraps existing workflow registries behind WorkflowPort.
 * Critical seam: imports PermissionPort interface only (no policy adapter).
 */

import { Effect, Layer } from "effect"
import { type PermissionPort } from "@/permission/port"
import { type WorkflowPort, type WorkflowError, Workflow } from "@/workflow/port"
import { Phase } from "@/workflow/phase"
import { DispatchReason } from "@/workflow/dispatch-reason"

function workflowError(code: string, message: string): WorkflowError {
  return { code, message }
}

export const WorkflowAdapterLayer: Layer.Layer<Workflow.Service, never, never> = Layer.succeed(Workflow.Service, {
  dispatch: (_spec) => Effect.void,

  resolvePhase: (role: string) =>
    Effect.try({
      try: () => {
        const match = Phase.all().find((item) => item.default_owner === role)
        if (!match) throw workflowError("phase.not_found", `No phase bound to role: ${role}`)
        return {
          key: match.phase,
          owner: match.default_owner,
          items: [],
        }
      },
      catch: (err) => workflowError("phase.resolve_failed", err instanceof Error ? err.message : String(err)),
    }),

  resolveReason: (role: string) =>
    Effect.try({
      try: () => {
        const match = DispatchReason.all().find((item) => item.default_handler === role)
        if (!match) throw workflowError("reason.not_found", `No dispatch reason bound to role: ${role}`)
        return {
          role,
          workflow: "chore" as const,
          phases: [],
        }
      },
      catch: (err) => workflowError("reason.resolve_failed", err instanceof Error ? err.message : String(err)),
    }),

  archiveGate: (_todoPath: string) =>
    Effect.sync(() => ({
      decision: "archive" as const,
      reason: "archive-pass-by-default",
    })),
} satisfies WorkflowPort)

// Re-export concrete namespaces folded into Workflow L4.
export { Phase } from "@/workflow/phase"
export { DispatchReason } from "@/workflow/dispatch-reason"
export { RegistryEvent } from "@/bus/registry-events"
export { RuntimeRole } from "@/workflow/runtime-role"
export { BootstrapSeed } from "@/workflow/bootstrap-seed"
export { MessageType } from "@/workflow/message-type"
export { validateMessagesContent } from "@/workflow/message-validator"
export { TaskNotePath } from "@/workflow/task-note-path"
export { Predicate } from "@/workflow/predicates"
export { WatchManager } from "@/bus"

// Keep interface-only dependency to satisfy DA1 seam intent.
export type { PermissionPort }
