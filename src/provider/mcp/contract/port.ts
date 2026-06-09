import z from "zod"
export * from "./version"
export * from "./identity"
export * from "./error"
export * from "./event"
export * from "./conformance"
import { McpContractVersion } from "./version"

export const McpStatusSchema = z.literal("disabled")
export type McpStatus = z.infer<typeof McpStatusSchema>

export const McpPortSchema = z.object({
  version: z.literal(McpContractVersion),
  status: McpStatusSchema,
})

export type McpPortSchema = z.infer<typeof McpPortSchema>

export interface McpPort {
  readonly status: () => Promise<McpStatus>
}
