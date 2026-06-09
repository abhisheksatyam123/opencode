import type { Permission } from "@/permission"
import type { ModelID, ProviderID } from "@/provider/schema"

export interface AgentCatalogModel {
  readonly providerID: ProviderID
  readonly modelID: ModelID
}

export interface AgentCatalogInfo {
  readonly name: string
  readonly mode: "subagent" | "primary" | "all"
  readonly tier: "0" | "1" | "2"
  readonly permission: Permission.Ruleset
  readonly options: Record<string, unknown>
  readonly description?: string
  readonly native?: boolean
  readonly hidden?: boolean
  readonly modelTier?: "tier0" | "tier1" | "tier2"
  readonly topP?: number
  readonly temperature?: number
  readonly color?: string
  readonly variant?: string
  readonly prompt?: string
  readonly steps?: number
  readonly tools?: Record<string, boolean>
  readonly model?: AgentCatalogModel
  readonly models?: AgentCatalogModel[]
  readonly [key: string]: unknown
}

export interface AgentCatalogBridge {
  readonly get: (name: string) => Promise<AgentCatalogInfo | undefined>
  readonly list: () => Promise<AgentCatalogInfo[]>
}

let bridge: AgentCatalogBridge | undefined

export function registerAgentCatalogBridge(next: AgentCatalogBridge): () => void {
  bridge = next
  return () => {
    if (bridge === next) bridge = undefined
  }
}

export const AgentCatalog = {
  get(name: string) {
    return bridge?.get(name) ?? Promise.resolve(undefined)
  },
  list() {
    return bridge?.list() ?? Promise.resolve([])
  },
}
