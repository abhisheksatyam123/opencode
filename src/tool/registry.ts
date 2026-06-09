import { BashTool } from "@/tool/bash"
import { TaskTool } from "@/tool/task"
import type { AgentCatalogInfo } from "@/permission/policy/agent-catalog"
import { Tool } from "@/tool/tool"
import { Permission } from "@/permission"
import { ProviderID, type ModelID } from "@/provider/schema"
import { Log } from "@/foundation/util/log"
import { ProviderPluginHooks } from "@/provider/plugin-hooks"
import { Effect, Layer, ServiceMap } from "effect"
import { makeRuntime } from "@/foundation/effect/run-service"

export namespace ToolRegistry {
  const log = Log.create({ service: "tool.registry" })

  export const RUNTIME_TOOL_IDS = ["bash", "task"] as const
  export const AGENT_HOT_TOOL_IDS = RUNTIME_TOOL_IDS
  const RUNTIME_TOOLS = new Set<string>(RUNTIME_TOOL_IDS)

  function isAgentToolVisible(toolID: string, agent: AgentCatalogInfo) {
    if (toolID === "task" && agent.tier === "2") return false
    return RUNTIME_TOOLS.has(toolID)
  }

  export interface Interface {
    readonly ids: () => Effect.Effect<string[]>
    readonly named: {
      task: Tool.Info
    }
    readonly tools: (
      model: { providerID: ProviderID; modelID: ModelID },
      agent?: AgentCatalogInfo,
    ) => Effect.Effect<(Tool.Def & { id: string })[]>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/ToolRegistry") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const allTools: Tool.Info[] = [BashTool, TaskTool]

      const ids = Effect.fn("ToolRegistry.ids")(function* () {
        return allTools.map((t) => t.id)
      })

      const tools = Effect.fn("ToolRegistry.tools")(function* (
        model: { providerID: ProviderID; modelID: ModelID },
        agent?: AgentCatalogInfo,
      ) {
        const filtered = agent
          ? allTools.filter((t) => {
              if (!isAgentToolVisible(t.id, agent)) return false
              const canon = t.canonicalId ?? t.id
              return Permission.evaluate(canon, "*", agent.permission).action !== "deny"
            })
          : allTools

        return yield* Effect.forEach(
          filtered,
          Effect.fnUntraced(function* (tool: Tool.Info) {
            using _ = log.time(tool.id)
            const next = yield* Effect.promise(() => tool.init({ agent }))
            const output = {
              description: next.description,
              parameters: next.parameters,
            }
            yield* ProviderPluginHooks.triggerEffect("tool.definition", { toolID: tool.id }, output)
            return {
              id: tool.id,
              description: output.description,
              parameters: output.parameters,
              execute: next.execute,
              formatValidationError: next.formatValidationError,
            }
          }),
          { concurrency: "unbounded" },
        )
      })

      return Service.of({ ids, named: { task: TaskTool }, tools })
    }),
  )

  export const defaultLayer = layer

  const { runPromise } = makeRuntime(Service, defaultLayer)

  export async function ids() {
    return runPromise((svc) => svc.ids())
  }

  export async function tools(
    model: {
      providerID: ProviderID
      modelID: ModelID
    },
    agent?: AgentCatalogInfo,
  ): Promise<(Tool.Def & { id: string })[]> {
    return runPromise((svc) => svc.tools(model, agent))
  }
}
