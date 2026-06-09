import z from "zod"
import { ServiceMap } from "effect"
export * from "@/tool/bash/contract/version"
export * from "@/tool/bash/contract/identity"
export * from "@/tool/bash/contract/error"
export * from "@/tool/bash/contract/event"
export * from "@/tool/bash/contract/conformance"
import { BashContractVersion } from "@/tool/bash/contract/version"

import { backgroundRegistry, type BackgroundEntry } from "@/tool/bash/background-registry"

export const BashPortSchema = z.object({
  version: z.literal(BashContractVersion),
})
export type BashPortSchema = z.infer<typeof BashPortSchema>

export interface BashPort {
  readonly backgroundRegistry: typeof backgroundRegistry
}

export namespace Bash {
  export class Service extends ServiceMap.Service<Service, BashPort>()("@opencode/ToolBash") {}
}

export { backgroundRegistry }
export type { BackgroundEntry }
