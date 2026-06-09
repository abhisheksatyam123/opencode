import { Effect, Layer } from "effect"
import { type AuthToken, type BootOpts, Init, type InitError, type InitPort, type InstallSpec } from "@/init/port"

function initError(code: string, message: string): InitError {
  return { code, message }
}

export const InitAdapterLayer: Layer.Layer<Init.Service, never, never> = Layer.succeed(Init.Service, {
  boot: (_opts: BootOpts) => Effect.void,

  install: (_spec: InstallSpec) =>
    Effect.fail(
      initError(
        "init.install.not_implemented",
        "Install wiring stays in legacy entrypoints; deferred after B6 composition",
      ),
    ),

  authenticate: (provider: string) =>
    Effect.sync(
      (): AuthToken => ({
        provider,
        token: "bootstrap-token",
      }),
    ),
} satisfies InitPort)

export * as Installation from "@/init/installation"
export * as Auth from "@/init/auth"
export * as Account from "@/init/account"
export * as Npm from "@/init/npm"
export * as NVersion from "@/init/nversion"
export * as Plugin from "@/init/plugin"
