import z from "zod"
import { ServiceMap, type Effect } from "effect"
export * from "@/surface/contract/version"
export * from "@/surface/contract/identity"
export * from "@/surface/contract/error"
export * from "@/surface/contract/event"
export * from "@/surface/contract/conformance"
import { SurfaceContractVersion } from "@/surface/contract/version"

export const SurfacePortSchema = z.object({
  version: z.literal(SurfaceContractVersion),
})
export type SurfacePortSchema = z.infer<typeof SurfacePortSchema>

export const ServerOptsSchema = z.object({
  port: z.number().int().min(0).max(65_535).optional(),
  host: z.string().min(1).optional(),
  cors: z.boolean().optional(),
})
export type ServerOpts = z.infer<typeof ServerOptsSchema>

export const ServerHandleSchema = z.object({
  port: z.number().int().min(0).max(65_535),
})
export type ServerHandle = {
  port: z.infer<typeof ServerHandleSchema>["port"]
  close: () => Effect.Effect<void>
}

export const IdeOptsSchema = z.object({
  extensionId: z.string().min(1),
  workspacePath: z.string().min(1),
})
export type IdeOpts = z.infer<typeof IdeOptsSchema>

export const IdeHandleSchema = z.object({
  extensionId: z.string().min(1),
})
export type IdeHandle = {
  extensionId: z.infer<typeof IdeHandleSchema>["extensionId"]
  dispose: () => Effect.Effect<void>
}

export const SurfaceErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
})
export type SurfaceError = z.infer<typeof SurfaceErrorSchema>

export interface SurfacePort {
  readonly startCli: (argv: string[]) => Effect.Effect<void, SurfaceError>
  readonly startServer: (opts: ServerOpts) => Effect.Effect<ServerHandle, SurfaceError>
  readonly startIde: (opts: IdeOpts) => Effect.Effect<IdeHandle, SurfaceError>
}

export namespace Surface {
  export class Service extends ServiceMap.Service<Service, SurfacePort>()("@opencode/Surface") {}
}
