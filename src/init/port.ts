import z from "zod"
import { ServiceMap, type Effect } from "effect"
export * from "@/init/contract/version"
export * from "@/init/contract/identity"
export * from "@/init/contract/error"
export * from "@/init/contract/event"
export * from "@/init/contract/conformance"
import { InitContractVersion } from "@/init/contract/version"

export const InitPortSchema = z.object({
  version: z.literal(InitContractVersion),
})
export type InitPortSchema = z.infer<typeof InitPortSchema>

export const BootSurfaceSchema = z.enum(["cli", "server", "ide"])

export const ServerOptsSchema = z.object({
  port: z.number().int().min(0).max(65_535).optional(),
  host: z.string().min(1).optional(),
  cors: z.boolean().optional(),
})

export const IdeOptsSchema = z.object({
  extensionId: z.string().min(1),
  workspacePath: z.string().min(1),
})

export const BootOptsSchema = z.object({
  surface: BootSurfaceSchema,
  argv: z.array(z.string()).optional(),
  serverOpts: ServerOptsSchema.optional(),
  ideOpts: IdeOptsSchema.optional(),
  skipPermissions: z.boolean().optional(),
})
export type BootOpts = z.infer<typeof BootOptsSchema>

// Per-install-type opts: open-shaped extension point gated by .passthrough()
// so each install type may carry typed extras while the schema rejects null/wrong-typed values.
export const InstallOptsSchema = z
  .object({
    registry: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
    env: z.record(z.string().min(1), z.string()).optional(),
  })
  .passthrough()
export type InstallOpts = z.infer<typeof InstallOptsSchema>

export const InstallTypeSchema = z.enum(["npm", "nversion", "plugin", "account"])
export const InstallSpecSchema = z.object({
  type: InstallTypeSchema,
  name: z.string().min(1),
  version: z.string().min(1).optional(),
  opts: InstallOptsSchema.optional(),
})
export type InstallSpec = z.infer<typeof InstallSpecSchema>

export const AuthTokenSchema = z.object({
  provider: z.string().min(1),
  token: z.string().min(1),
  expiresAt: z.number().optional(),
  scopes: z.array(z.string()).optional(),
})
export type AuthToken = z.infer<typeof AuthTokenSchema>

export const InitErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
})
export type InitError = z.infer<typeof InitErrorSchema>

export interface InitPort {
  readonly boot: (opts: BootOpts) => Effect.Effect<void, InitError>
  readonly install: (spec: InstallSpec) => Effect.Effect<void, InitError>
  readonly authenticate: (provider: string) => Effect.Effect<AuthToken, InitError>
}

export namespace Init {
  export class Service extends ServiceMap.Service<Service, InitPort>()("@opencode/Init") {}
}
