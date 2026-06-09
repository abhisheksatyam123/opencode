import { Effect, Layer } from "effect"
import { Server } from "@/surface/server/server"
import { Command } from "@/surface/command"
import { Ide } from "@/surface/ide"
import { ShareNext } from "@/surface/share/share-next"
import { SyncEvent } from "@/surface/sync/wiring/layer"
import {
  type IdeHandle,
  type IdeOpts,
  Surface,
  type SurfaceError,
  type SurfacePort,
  type ServerHandle,
  type ServerOpts,
} from "@/surface/port"

function surfaceError(code: string, message: string): SurfaceError {
  return { code, message }
}

export const SurfaceAdapterLayer: Layer.Layer<Surface.Service, never, never> = Layer.succeed(Surface.Service, {
  startCli: (_argv: string[]) =>
    Effect.fail(
      surfaceError(
        "surface.cli.not_wired",
        "CLI composition remains at src/index.ts; Surface CLI wiring is deferred to B6.2 composition-root",
      ),
    ),

  startServer: (opts: ServerOpts) =>
    Effect.tryPromise({
      try: async () => {
        const listener = await Server.listen({
          port: opts.port ?? 0,
          hostname: opts.host ?? "127.0.0.1",
          cors: opts.cors ? ["*"] : undefined,
        })

        const handle: ServerHandle = {
          port: listener.port,
          close: () => Effect.promise(() => listener.stop(true)),
        }

        return handle
      },
      catch: (err) => surfaceError("surface.server.listen_failed", err instanceof Error ? err.message : String(err)),
    }),

  startIde: (opts: IdeOpts) =>
    Effect.sync(() => {
      const handle: IdeHandle = {
        extensionId: opts.extensionId,
        dispose: () => Effect.void,
      }
      return handle
    }),
} satisfies SurfacePort)

// Surface L5 sub-area re-exports (migration-map rows)
export { Server } from "@/surface/server/server"
export { Command } from "@/surface/command"
export { Ide } from "@/surface/ide"
export { ShareNext } from "@/surface/share/share-next"
export { SyncEvent } from "@/surface/sync/wiring/layer"

// ACP currently split across files (no stable barrel yet)
export * as ACPAgent from "@/surface/acp/impl/agent"
export * as ACPSession from "@/surface/acp/impl/session"

// CLI shape preservation: explicit exports, no entrypoint mutation
export * as CliBootstrap from "@/surface/cli/bootstrap"
export * as CliNetwork from "@/surface/cli/network"
export * as CliUI from "@/surface/cli/ui"
export * as CliUpgrade from "@/surface/cli/upgrade"
