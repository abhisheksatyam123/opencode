import z from "zod"
import { ServiceMap } from "effect"
export * from "@/surface/cli/cmd/tui/contract/version"
export * from "@/surface/cli/cmd/tui/contract/identity"
export * from "@/surface/cli/cmd/tui/contract/error"
export * from "@/surface/cli/cmd/tui/contract/event"
export * from "@/surface/cli/cmd/tui/contract/conformance"
import { TuiContractVersion } from "@/surface/cli/cmd/tui/contract/version"

import { TuiEvent } from "@/surface/cli/cmd/tui/event"

export const TuiPortSchema = z.object({
  version: z.literal(TuiContractVersion),
})
export type TuiPortSchema = z.infer<typeof TuiPortSchema>

export interface TuiPort {
  readonly events: typeof TuiEvent
}

export namespace Tui {
  export class Service extends ServiceMap.Service<Service, TuiPort>()("@opencode/Tui") {}
}

export { TuiEvent }
