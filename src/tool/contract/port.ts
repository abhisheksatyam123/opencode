/**
 * Tool L3 — Port contract
 *
 * Public contract for listing and resolving agent tools. Concrete registry
 * wiring lives under ../impl and ../wiring; legacy root files re-export this
 * contract while callers migrate to the three-tier module shape.
 */

import z from "zod"
import { ServiceMap } from "effect"
import { ToolContractVersion } from "@/tool/contract/version"
import { ToolID as GeneratedToolID } from "@/tool/schema"

export * from "@/tool/contract/version"
export * from "@/tool/contract/identity"
export * from "@/tool/contract/error"
export * from "@/tool/contract/event"
export * from "@/tool/contract/conformance"

export const ToolPortSchema = z.object({
  version: z.literal(ToolContractVersion),
})
export type ToolPortSchema = z.infer<typeof ToolPortSchema>

export const ToolRuntimeIDSchema = GeneratedToolID.zod.describe("Generated runtime tool identifier (tool_...)")
export type ToolRuntimeID = z.infer<typeof ToolRuntimeIDSchema>

export const ToolNameSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/)
  .describe("Registry tool name exposed to models (e.g. 'bash', 'task')")
export type ToolName = z.infer<typeof ToolNameSchema>

export const ToolInfoSchema = z.object({
  id: ToolNameSchema,
  canonicalId: ToolNameSchema.optional(),
})
export type ToolInfo = z.infer<typeof ToolInfoSchema>

export interface ToolPort {
  readonly ids: () => any
  readonly tools: (model: any, agent?: any) => any
  readonly named: { task: any }
}

export namespace Tool {
  export class Service extends ServiceMap.Service<Service, ToolPort>()("@opencode/Tool") {}
}
