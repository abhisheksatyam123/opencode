import type { Argv, InferredOptionTypes } from "yargs"
import { Config } from "@/config/config"
import { CliArgs } from "@/foundation/util/cli-args"
import { Flag } from "@/foundation/flag/flag"
import { randomBytes } from "node:crypto"

const options = {
  port: {
    type: "number" as const,
    describe: "port to listen on",
    default: 0,
  },
  hostname: {
    type: "string" as const,
    describe: "hostname to listen on",
    default: "127.0.0.1",
  },
  mdns: {
    type: "boolean" as const,
    describe: "enable mDNS service discovery (defaults hostname to 0.0.0.0)",
    default: false,
  },
  "mdns-domain": {
    type: "string" as const,
    describe: "custom domain name for mDNS service (default: opencode.local)",
    default: "opencode.local",
  },
  cors: {
    type: "string" as const,
    array: true,
    describe: "additional domains to allow for CORS",
    default: [] as string[],
  },
  web: {
    type: "boolean" as const,
    describe: "enable parallel web server alongside TUI (Mode A)",
    default: false,
  },
  "no-auth": {
    type: "boolean" as const,
    describe: "disable HTTP Basic Auth (no password required)",
    default: false,
  },
  "permission-mode": {
    type: "string" as const,
    choices: ["default", "plan", "bypass"] as const,
    default: "default",
    describe:
      "permission mode: 'default' asks the user, 'plan' auto-rejects writes, 'bypass' auto-approves all (dangerous)",
  },
}

export type NetworkOptions = InferredOptionTypes<typeof options>

export function withNetworkOptions<T>(yargs: Argv<T>) {
  return yargs.options(options)
}

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1"
}

export async function resolveNetworkOptions(args: NetworkOptions) {
  const config = await Config.getGlobal()
  const portExplicitlySet = CliArgs.hasCliFlag("--port")
  const hostnameExplicitlySet = CliArgs.hasCliFlag("--hostname")
  const mdnsExplicitlySet = CliArgs.hasCliFlag("--mdns")
  const mdnsDomainExplicitlySet = CliArgs.hasCliFlag("--mdns-domain")
  const corsExplicitlySet = CliArgs.hasCliFlag("--cors")
  const webExplicitlySet = CliArgs.hasCliFlag("--web")
  const noAuthExplicitlySet = CliArgs.hasCliFlag("--no-auth")
  const permissionModeExplicitlySet = CliArgs.hasCliFlag("--permission-mode")

  const mdns = mdnsExplicitlySet ? args.mdns : (config?.server?.mdns ?? args.mdns)
  const mdnsDomain = mdnsDomainExplicitlySet ? args["mdns-domain"] : (config?.server?.mdnsDomain ?? args["mdns-domain"])
  const port = portExplicitlySet ? args.port : (config?.server?.port ?? args.port)
  const hostname = hostnameExplicitlySet
    ? args.hostname
    : mdns && !config?.server?.hostname
      ? "0.0.0.0"
      : (config?.server?.hostname ?? args.hostname)
  const configCors = config?.server?.cors ?? []
  const argsCors = Array.isArray(args.cors) ? args.cors : args.cors ? [args.cors] : []
  const cors = [...configCors, ...argsCors]

  // web: CLI flag > OPENCODE_WEB env > config.server.web > default false
  const web = webExplicitlySet ? args.web : Flag.OPENCODE_WEB || (config?.server?.web ?? false)

  // no-auth: CLI flag > config.server.noAuth > default false
  const noAuth = noAuthExplicitlySet ? args["no-auth"] : (config?.server?.noAuth ?? false)

  // permission-mode: CLI flag > config.server.permissionMode > default "default"
  const permissionMode = permissionModeExplicitlySet
    ? (args["permission-mode"] ?? "default")
    : (config?.server?.permissionMode ?? "default")

  // Auto-token: non-loopback + no explicit password → generate 256-bit process-lifetime token pair.
  const explicitPassword = Flag.OPENCODE_SERVER_PASSWORD
  const explicitReadPassword = Flag.OPENCODE_SERVER_READ_PASSWORD
  const shouldAutoToken = !noAuth && !explicitPassword && !isLoopback(hostname)
  const password = noAuth
    ? undefined
    : (explicitPassword ?? (shouldAutoToken ? randomBytes(32).toString("hex") : undefined))
  const readPassword = noAuth
    ? undefined
    : (explicitReadPassword ?? (shouldAutoToken ? randomBytes(32).toString("hex") : undefined))
  const username = Flag.OPENCODE_SERVER_USERNAME ?? "opencode"

  return { hostname, port, mdns, mdnsDomain, cors, web, password, readPassword, username, noAuth, permissionMode }
}
