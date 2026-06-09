import { Config } from "@/config/config"
import { AgentCatalog, type AgentCatalogInfo } from "@/permission/policy/agent-catalog"
import { Log } from "@/foundation/util/log"

export namespace RuntimeRoles {
  const log = Log.create({ service: "runtime-roles" })

  export type Role = "compaction" | "user-proxy" | "halt-auditor" | "title" | "adviser"

  export const DEFAULT_BINDINGS: Record<Role, string> = {
    compaction: "compaction",
    "user-proxy": "user-proxy",
    "halt-auditor": "halt-auditor",
    title: "title",
    adviser: "adviser",
  }

  export interface RegistryBridge {
    readonly defaultAgent: (role: Role) => string | undefined
  }

  let registryBridge: RegistryBridge | undefined

  export function registerRegistryBridge(bridge: RegistryBridge): () => void {
    registryBridge = bridge
    return () => {
      if (registryBridge === bridge) registryBridge = undefined
    }
  }

  export async function resolve(role: Role): Promise<string> {
    const cfg = await Config.get()
    return resolveSync(role, cfg as { runtime_roles?: Record<string, string> })
  }

  export async function get(role: Role): Promise<AgentCatalogInfo | null> {
    const name = await resolve(role)
    const agent = await AgentCatalog.get(name).catch(() => undefined)
    if (!agent) {
      log.warn("role.unbound", {
        role,
        resolved: name,
        reason:
          name === DEFAULT_BINDINGS[role]
            ? `default agent "${name}" not in local prompts`
            : `cfg.runtime_roles.${role} = "${name}" not in local prompts`,
        action: `add src/agent/prompts/${name}.md or change cfg.runtime_roles.${role}`,
      })
      return null
    }
    return agent
  }

  export function resolveSync(role: Role, cfg: { runtime_roles?: Record<string, string> }): string {
    const override = cfg.runtime_roles?.[role]
    if (typeof override === "string" && override.length > 0) return override
    return registryBridge?.defaultAgent(role) ?? DEFAULT_BINDINGS[role]
  }
}
