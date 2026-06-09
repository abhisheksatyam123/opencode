import { Config } from "@/config/config"

export namespace AgentRoles {
  export const DEFAULT_PLAN_MODE_AGENTS: readonly string[] = ["planner"]

  type CfgShape = {
    plan_mode_agents?: string[]
  }

  export function getPlanModeNamesSync(cfg: CfgShape): ReadonlySet<string> {
    const override = cfg.plan_mode_agents
    if (
      Array.isArray(override) &&
      override.length > 0 &&
      override.every((s) => typeof s === "string" && s.length > 0)
    ) {
      return new Set(override)
    }
    return new Set(DEFAULT_PLAN_MODE_AGENTS)
  }

  export async function getPlanModeNames(): Promise<ReadonlySet<string>> {
    const cfg = (await Config.get()) as CfgShape
    return getPlanModeNamesSync(cfg)
  }

  export function isPlanModeSync(nameOrInfo: string | { name: string }, cfg: CfgShape): boolean {
    const name = typeof nameOrInfo === "string" ? nameOrInfo : nameOrInfo.name
    return getPlanModeNamesSync(cfg).has(name)
  }

  export async function isPlanMode(nameOrInfo: string | { name: string }): Promise<boolean> {
    const cfg = (await Config.get()) as CfgShape
    return isPlanModeSync(nameOrInfo, cfg)
  }

  export function isTier0(info: { tier: "0" | "1" | "2" | string }): boolean {
    return info.tier === "0"
  }
}
