export * from "./contract/port"
export { McpLayer } from "./wiring/layer"

import { McpLayer } from "./wiring/layer"

export namespace MCP {
  export type Status = "disabled"

  export async function status(): Promise<Status> {
    return McpLayer.status()
  }
}
