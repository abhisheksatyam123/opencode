import { Config } from "@/config/config"
import { Log } from "@/foundation/util/log"

export namespace DispatchRoles {
  const log = Log.create({ service: "dispatch-roles" })

  export type Phase =
    | "Plan"
    | "Design"
    | "Root cause"
    | "Contract"
    | "Spec"
    | "Implement"
    | "Rethink & Redesign"
    | "Test Strategy"
    | "Verification"
    | "Research"
    | "Notes"

  export const PHASE_DEFAULTS: Record<Phase, string> = {
    Plan: "planner",
    Design: "planner",
    "Root cause": "searcher",
    Contract: "planner",
    Spec: "planner",
    Implement: "implementer",
    "Rethink & Redesign": "planner",
    "Test Strategy": "implementer",
    Verification: "implementer",
    Research: "searcher",
    Notes: "planner",
  }

  export type Reason =
    | "default-fallback"
    | "missing-discovery"
    | "pending-dispatch"
    | "failed-progress"
    | "open-questions"
    | "notes-empty"
    | "phase-gate-verify"

  export const REASON_DEFAULTS: Record<Reason, string> = {
    "default-fallback": "planner",
    "missing-discovery": "searcher",
    "pending-dispatch": "planner",
    "failed-progress": "planner",
    "open-questions": "planner",
    "notes-empty": "planner",
    "phase-gate-verify": "implementer",
  }

  type CfgShape = {
    dispatch_roles?: {
      phase?: Partial<Record<Phase, string>>
      reason?: Partial<Record<Reason, string>>
    }
  }

  export interface PhaseRegistryBridge {
    readonly defaultOwner: (phase: Phase) => string | undefined
  }

  export interface ReasonRegistryBridge {
    readonly defaultHandler: (reason: Reason) => string | undefined
  }

  let phaseBridge: PhaseRegistryBridge | undefined
  let reasonBridge: ReasonRegistryBridge | undefined

  export function registerPhaseRegistryBridge(bridge: PhaseRegistryBridge): () => void {
    phaseBridge = bridge
    return () => {
      if (phaseBridge === bridge) phaseBridge = undefined
    }
  }

  export function registerReasonRegistryBridge(bridge: ReasonRegistryBridge): () => void {
    reasonBridge = bridge
    return () => {
      if (reasonBridge === bridge) reasonBridge = undefined
    }
  }

  export function resolvePhaseSync(phase: Phase, cfg: CfgShape): string {
    const override = cfg.dispatch_roles?.phase?.[phase]
    if (typeof override === "string" && override.length > 0) return override
    return phaseBridge?.defaultOwner(phase) ?? PHASE_DEFAULTS[phase]
  }

  export async function resolvePhase(phase: Phase): Promise<string> {
    const cfg = (await Config.get()) as CfgShape
    return resolvePhaseSync(phase, cfg)
  }

  export function resolveReasonSync(reason: Reason, cfg: CfgShape): string {
    const override = cfg.dispatch_roles?.reason?.[reason]
    if (typeof override === "string" && override.length > 0) return override
    return reasonBridge?.defaultHandler(reason) ?? REASON_DEFAULTS[reason]
  }

  export async function resolveReason(reason: Reason): Promise<string> {
    const cfg = (await Config.get()) as CfgShape
    return resolveReasonSync(reason, cfg)
  }

  export function warnIfUnboundReason(reason: Reason, name: string, registryNames: ReadonlySet<string>): void {
    if (registryNames.has(name)) return
    log.warn("dispatch-role.unbound", {
      reason,
      resolved: name,
      hint: `cfg.dispatch_roles.reason.${reason} = "${name}" not in local agent registry`,
      action: `add src/agent/prompts/${name}.md or change cfg.dispatch_roles.reason.${reason}`,
    })
  }
}
