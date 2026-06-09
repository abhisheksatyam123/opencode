import { Log } from "@/foundation/util/log"
import { describeRoute, generateSpecs, validator, resolver, openAPIRouteHandler } from "hono-openapi"
import { Hono } from "hono"
import { compress } from "hono/compress"
import { cors } from "hono/cors"
import type { UpgradeWebSocket } from "hono/ws"
import z from "zod"
import { Auth } from "@/init/auth"
import { Flag } from "@/foundation/flag/flag"
import { ProviderID } from "@/provider/schema"
import { createAdaptorServer, type ServerType } from "@hono/node-server"
import { createNodeWebSocket } from "@hono/node-ws"
import { WorkspaceRouterMiddleware } from "@/surface/server/router"
import { errors } from "@/surface/server/error"
import { GlobalRoutes } from "@/surface/server/routes/global"
import { MDNS } from "@/surface/server/mdns"
import { lazy } from "@/foundation/util/lazy"
import { errorHandler } from "@/surface/server/middleware"
import { InstanceRoutes } from "@/surface/server/instance"
import { initProjectors } from "@/surface/server/projectors"
import { type PermissionMode } from "@/config/types"
import { readFile } from "node:fs/promises"
import { intelGraphLogPath } from "@/intelgraph/backend/log"

// Suppress AI SDK warning logs to stdout; see https://github.com/vercel/ai/blob/2dc67e0ef538307f21368db32d5a12345d98831b/packages/ai/src/logger/log-warnings.ts#L85
globalThis.AI_SDK_LOG_WARNINGS = false

initProjectors()

export namespace Server {
  export type Listener = {
    hostname: string
    port: number
    url: URL
    stop: (close?: boolean) => Promise<void>
  }

  export type AuthRole = "read" | "write"

  const log = Log.create({ service: "server" })
  const zipped = compress()
  const writeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"])
  const appLogBuffer: Array<{
    timestamp: string
    service: string
    level: "debug" | "info" | "error" | "warn"
    message: string
    extra?: Record<string, unknown>
  }> = []
  const MAX_APP_LOG_BUFFER = 1_000

  function rememberAppLog(entry: (typeof appLogBuffer)[number]) {
    appLogBuffer.push(entry)
    if (appLogBuffer.length > MAX_APP_LOG_BUFFER) appLogBuffer.splice(0, appLogBuffer.length - MAX_APP_LOG_BUFFER)
  }

  function logLimit(value: string | undefined) {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return 200
    return Math.max(1, Math.min(1_000, Math.trunc(parsed)))
  }

  async function readIntelGraphLogTail(workspaceRoot: string | undefined, limit: number) {
    const file = intelGraphLogPath(workspaceRoot || process.cwd())
    const text = await readFile(file, "utf8").catch(() => "")
    if (!text.trim()) return { file, entries: [] as unknown[] }
    const entries = text
      .trimEnd()
      .split(/\r?\n/)
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line) as unknown
        } catch {
          return { raw: line }
        }
      })
    return { file, entries }
  }

  async function readServerLogTail(limit: number) {
    const file = Log.file()
    const text = file ? await readFile(file, "utf8").catch(() => "") : ""
    const lines = text.trimEnd() ? text.trimEnd().split(/\r?\n/).slice(-limit) : []
    return { file, lines }
  }

  function renderLogText(input: {
    app: typeof appLogBuffer
    serverFile: string
    server: string[]
    intelgraphFile: string
    intelgraph: unknown[]
  }) {
    const lines: string[] = []
    lines.push(`# /log ${new Date().toISOString()}`)
    lines.push(`# frontend_app_logs=${input.app.length}`)
    for (const entry of input.app) lines.push(JSON.stringify({ source: "frontend", ...entry }))
    lines.push(`# server_log_file=${input.serverFile}`)
    lines.push(`# server_logs=${input.server.length}`)
    for (const line of input.server) lines.push(line)
    lines.push(`# intelgraph_log_file=${input.intelgraphFile}`)
    lines.push(`# intelgraph_logs=${input.intelgraph.length}`)
    for (const entry of input.intelgraph) lines.push(JSON.stringify(entry))
    return `${lines.join("\n")}\n`
  }

  const skipCompress = (path: string, method: string) => {
    if (path === "/event" || path === "/global/event" || path === "/global/sync-event") return true
    if (method === "POST" && /\/session\/[^/]+\/(message|prompt_async)$/.test(path)) return true
    return false
  }

  const resolveCorsOrigin = (input: string | undefined, requestHost?: string, additionalOrigins?: string[]) => {
    if (!input) return
    if (input.startsWith("http://localhost:")) return input
    if (input.startsWith("http://127.0.0.1:")) return input
    if (input.startsWith("http://[::1]:")) return input
    if (requestHost) {
      try {
        if (new URL(input).hostname === requestHost) return input
      } catch {
        // Ignore malformed origin and continue to explicit allowlist checks.
      }
    }
    if (input === "tauri://localhost" || input === "http://tauri.localhost" || input === "https://tauri.localhost")
      return input
    if (/^https:\/\/([a-z0-9-]+\.)*opencode\.ai$/.test(input)) return input
    if (additionalOrigins?.includes(input)) return input
  }

  export const Default = lazy(() => create({}).app)

  export function ControlPlaneRoutes(
    upgrade: UpgradeWebSocket,
    app = new Hono(),
    opts?: {
      cors?: string[]
      username?: string
      password?: string
      readPassword?: string
      noAuth?: boolean
      allowedHosts?: string[]
      permissionMode?: PermissionMode
    },
  ): Hono {
    return (
      app
        .onError(errorHandler(log))
        .use(async (c, next) => {
          // Allow CORS preflight requests to succeed without auth.
          // Browser clients sending Authorization headers will preflight with OPTIONS.
          if (c.req.method === "OPTIONS") return next()
          const authDisabled = opts?.noAuth === true
          const writePassword = authDisabled ? undefined : (opts?.password ?? Flag.OPENCODE_SERVER_PASSWORD)
          const readPassword = authDisabled ? undefined : (opts?.readPassword ?? Flag.OPENCODE_SERVER_READ_PASSWORD)
          const markRole = (role: AuthRole) => {
            ;(c as any).set("authRole", role)
            c.header("X-Auth-Role", role)
          }
          if (!writePassword && !readPassword) {
            markRole("write")
            await next()
            c.header("X-Auth-Role", "write")
            return
          }
          // 401/403 split:
          //   no Authorization header  → 401 auth_required  (Basic challenge; browser may prompt)
          //   wrong credentials        → 401 auth_forbidden (Basic challenge; browser can re-prompt)
          //   correct credentials      → next()
          const authHeader = c.req.header("authorization")
          if (!authHeader) {
            c.header("WWW-Authenticate", `Basic realm="opencode"`)
            return c.json({ error: { code: "auth_required", message: "Authentication required", details: {} } }, 401)
          }
          // Decode Basic credentials manually to avoid Hono basicAuth returning 401 for wrong creds.
          let authRole: AuthRole | undefined
          if (authHeader.startsWith("Basic ")) {
            try {
              const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8")
              const colon = decoded.indexOf(":")
              if (colon !== -1) {
                const reqPass = decoded.slice(colon + 1)
                if (writePassword && reqPass === writePassword) authRole = "write"
                else if (readPassword && reqPass === readPassword) authRole = "read"
              }
            } catch {
              // malformed base64 → authRole stays undefined
            }
          }
          if (!authRole) {
            c.header("WWW-Authenticate", `Basic realm="opencode"`)
            return c.json({ error: { code: "auth_forbidden", message: "Invalid credentials", details: {} } }, 401)
          }
          markRole(authRole)
          await next()
          c.header("X-Auth-Role", authRole)
          return
        })
        .use(async (c, next) => {
          // Host/Origin guard for LAN/team Web UI safety (DNS rebinding + CSRF mitigation)
          const allowedHosts = opts?.allowedHosts
          if (!allowedHosts || allowedHosts.length === 0) {
            await next()
            return
          }

          const host = c.req.header("host")?.split(":")[0] ?? ""
          const origin = c.req.header("origin")

          // Always allow loopback
          const loopback = ["localhost", "127.0.0.1", "::1"]
          const hostOk = loopback.includes(host) || allowedHosts.some((h) => h === host || h === `${host}`)
          if (!hostOk) {
            return c.json(
              { error: { code: "host_forbidden", message: "Host header not in allowed list", details: {} } },
              403,
            )
          }

          if (origin && c.req.method !== "OPTIONS") {
            const originHost = (() => {
              try {
                return new URL(origin).hostname
              } catch {
                return ""
              }
            })()
            const originOk =
              loopback.includes(originHost) ||
              (originHost !== "" && originHost === host) ||
              allowedHosts.some((h) => h === originHost) ||
              (opts?.cors ?? []).includes(origin)
            if (!originOk) {
              return c.json(
                { error: { code: "origin_forbidden", message: "Origin not in allowed list", details: {} } },
                403,
              )
            }
          }

          await next()
        })
        .use(async (c, next) => {
          const role = (c as any).get("authRole") as AuthRole | undefined
          if (role === "read" && (writeMethods.has(c.req.method) || c.req.path.startsWith("/pty"))) {
            return c.json(
              {
                error: {
                  code: "write_required",
                  message: "Write access is required for this operation",
                  details: { role },
                },
              },
              403,
            )
          }
          return next()
        })
        .use(async (c, next) => {
          const skip = c.req.path === "/log"

          if (!skip) {
            log.info("request", {
              method: c.req.method,
              path: c.req.path,
            })
          }
          const timer = log.time("request", {
            method: c.req.method,
            path: c.req.path,
          })
          await next()
          if (!skip) timer.stop()
        })
        .use(
          cors({
            maxAge: 86_400,
            origin(input, c) {
              const requestHost = c.req.header("host")?.split(":")[0]
              return resolveCorsOrigin(input, requestHost, opts?.cors)
            },
          }),
        )
        // Hono's CORS middleware writes ACAO headers before `next()`.
        // Some handlers in this app replace `c.res` (e.g. SSE streams,
        // delegated router responses), which can drop previously written
        // headers. Re-apply allowed-origin headers after downstream
        // handlers so browser fetch/EventSource calls are consistently
        // CORS-safe.
        .use(async (c, next) => {
          await next()
          if (c.req.method === "OPTIONS") return
          const requestHost = c.req.header("host")?.split(":")[0]
          const allowedOrigin = resolveCorsOrigin(c.req.header("origin"), requestHost, opts?.cors)
          if (!allowedOrigin) return
          c.header("Access-Control-Allow-Origin", allowedOrigin)
          c.header("Access-Control-Expose-Headers", "X-Auth-Role")
        })
        .use((c, next) => {
          if (skipCompress(c.req.path, c.req.method)) return next()
          return zipped(c, next)
        })
        .route("/global", GlobalRoutes())
        .put(
          "/auth/:providerID",
          describeRoute({
            summary: "Set auth credentials",
            description: "Set authentication credentials",
            operationId: "auth.set",
            responses: {
              200: {
                description: "Successfully set authentication credentials",
                content: {
                  "application/json": {
                    schema: resolver(z.boolean()),
                  },
                },
              },
              ...errors(400),
            },
          }),
          validator(
            "param",
            z.object({
              providerID: ProviderID.zod,
            }),
          ),
          validator("json", Auth.Info.zod),
          async (c) => {
            const providerID = c.req.valid("param").providerID
            const info = c.req.valid("json")
            await Auth.set(providerID, info)
            return c.json(true)
          },
        )
        .delete(
          "/auth/:providerID",
          describeRoute({
            summary: "Remove auth credentials",
            description: "Remove authentication credentials",
            operationId: "auth.remove",
            responses: {
              200: {
                description: "Successfully removed authentication credentials",
                content: {
                  "application/json": {
                    schema: resolver(z.boolean()),
                  },
                },
              },
              ...errors(400),
            },
          }),
          validator(
            "param",
            z.object({
              providerID: ProviderID.zod,
            }),
          ),
          async (c) => {
            const providerID = c.req.valid("param").providerID
            await Auth.remove(providerID)
            return c.json(true)
          },
        )
        .get(
          "/doc",
          openAPIRouteHandler(app, {
            documentation: {
              info: {
                title: "opencode",
                version: "0.0.3",
                description: "opencode api",
              },
              openapi: "3.1.1",
            },
          }),
        )
        .get("/log", async (c) => {
          const limit = logLimit(c.req.query("limit"))
          const directory = c.req.query("directory") || c.req.query("workspace") || undefined
          const appEntries = appLogBuffer.slice(-limit)
          const server = await readServerLogTail(limit)
          const intelgraph = await readIntelGraphLogTail(directory, limit)
          const payload = {
            ok: true,
            timestamp: new Date().toISOString(),
            app: appEntries,
            server,
            intelgraph: {
              file: intelgraph.file,
              entries: intelgraph.entries,
            },
          }
          const format = c.req.query("format")
          const accept = c.req.header("accept") ?? ""
          if (format === "json" || accept.includes("application/json")) return c.json(payload)
          return c.text(
            renderLogText({
              app: appEntries,
              serverFile: server.file,
              server: server.lines,
              intelgraphFile: intelgraph.file,
              intelgraph: intelgraph.entries,
            }),
          )
        })
        .use(
          validator(
            "query",
            z.object({
              directory: z.string().optional(),
              workspace: z.string().optional(),
            }),
          ),
        )
        .post(
          "/log",
          describeRoute({
            summary: "Write log",
            description: "Write a log entry to the server logs with specified level and metadata.",
            operationId: "app.log",
            responses: {
              200: {
                description: "Log entry written successfully",
                content: {
                  "application/json": {
                    schema: resolver(z.boolean()),
                  },
                },
              },
              ...errors(400),
            },
          }),
          validator(
            "json",
            z.object({
              service: z.string().meta({ description: "Service name for the log entry" }),
              level: z.enum(["debug", "info", "error", "warn"]).meta({ description: "Log level" }),
              message: z.string().meta({ description: "Log message" }),
              extra: z
                .record(z.string(), z.any())
                .optional()
                .meta({ description: "Additional metadata for the log entry" }),
            }),
          ),
          async (c) => {
            const { service, level, message, extra } = c.req.valid("json")
            rememberAppLog({ timestamp: new Date().toISOString(), service, level, message, extra })
            const logger = Log.create({ service })

            switch (level) {
              case "debug":
                logger.debug(message, extra)
                break
              case "info":
                logger.info(message, extra)
                break
              case "error":
                logger.error(message, extra)
                break
              case "warn":
                logger.warn(message, extra)
                break
            }

            return c.json(true)
          },
        )
        .use(WorkspaceRouterMiddleware(upgrade))
    )
  }

  function create(opts: {
    cors?: string[]
    username?: string
    password?: string
    readPassword?: string
    noAuth?: boolean
    allowedHosts?: string[]
    permissionMode?: PermissionMode
  }) {
    const app = new Hono()
    const ws = createNodeWebSocket({ app })
    return {
      app: ControlPlaneRoutes(ws.upgradeWebSocket, app, opts),
      ws,
    }
  }

  export function createApp(opts: {
    cors?: string[]
    username?: string
    password?: string
    readPassword?: string
    noAuth?: boolean
    allowedHosts?: string[]
    permissionMode?: PermissionMode
  }) {
    return create(opts).app
  }

  export async function openapi() {
    // Build a fresh app with all routes registered directly so
    // hono-openapi can see describeRoute metadata (`.route()` wraps
    // handlers when the sub-app has a custom errorHandler, which
    // strips the metadata symbol).
    const { app, ws } = create({})
    InstanceRoutes(ws.upgradeWebSocket, app)
    const result = await generateSpecs(app, {
      documentation: {
        info: {
          title: "opencode",
          version: "1.0.0",
          description: "opencode api",
        },
        openapi: "3.1.1",
      },
    })
    return result
  }

  export let url: URL

  export async function listen(opts: {
    port: number
    hostname: string
    mdns?: boolean
    mdnsDomain?: string
    cors?: string[]
    username?: string
    password?: string
    readPassword?: string
    noAuth?: boolean
    allowedHosts?: string[]
    permissionMode?: PermissionMode
  }): Promise<Listener> {
    const built = create(opts)
    const start = (port: number) =>
      new Promise<ServerType>((resolve, reject) => {
        const server = createAdaptorServer({ fetch: built.app.fetch })
        built.ws.injectWebSocket(server)
        const fail = (err: Error) => {
          cleanup()
          reject(err)
        }
        const ready = () => {
          cleanup()
          resolve(server)
        }
        const cleanup = () => {
          server.off("error", fail)
          server.off("listening", ready)
        }
        server.once("error", fail)
        server.once("listening", ready)
        server.listen(port, opts.hostname)
      })

    const server = opts.port === 0 ? await start(4096).catch(() => start(0)) : await start(opts.port)
    const addr = server.address()
    if (!addr || typeof addr === "string") {
      throw new Error(`Failed to resolve server address for port ${opts.port}`)
    }

    const next = new URL("http://localhost")
    next.hostname = opts.hostname
    next.port = String(addr.port)
    url = next

    const mdns =
      opts.mdns &&
      addr.port &&
      opts.hostname !== "127.0.0.1" &&
      opts.hostname !== "localhost" &&
      opts.hostname !== "::1"
    if (mdns) {
      MDNS.publish(addr.port, opts.mdnsDomain)
    } else if (opts.mdns) {
      log.warn("mDNS enabled but hostname is loopback; skipping mDNS publish")
    }

    let closing: Promise<void> | undefined
    return {
      hostname: opts.hostname,
      port: addr.port,
      url: next,
      stop(close?: boolean) {
        closing ??= new Promise((resolve, reject) => {
          if (mdns) MDNS.unpublish()
          server.close((err) => {
            if (err) {
              reject(err)
              return
            }
            resolve()
          })
          if (close) {
            if ("closeAllConnections" in server && typeof server.closeAllConnections === "function") {
              server.closeAllConnections()
            }
            if ("closeIdleConnections" in server && typeof server.closeIdleConnections === "function") {
              server.closeIdleConnections()
            }
          }
        })
        return closing
      },
    }
  }
}
