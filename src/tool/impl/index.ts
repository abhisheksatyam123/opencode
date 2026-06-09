/**
 * Tool L3 — concrete adapter implementation
 *
 * Private implementation side of the contract/impl/wiring shape. It wraps the
 * existing ToolRegistry implementation behind the ToolPort contract.
 */

import { Effect, Layer } from "effect"
import { ToolRegistry } from "@/tool/registry"
import { type ToolPort, Tool } from "@/tool/contract/port"

export const ToolAdapterLayer: Layer.Layer<Tool.Service, never, ToolRegistry.Service> = Layer.effect(
  Tool.Service,
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const port: ToolPort = {
      ids: () => registry.ids(),
      tools: (model, agent) => registry.tools(model, agent),
      named: registry.named,
    }
    return port
  }),
)
