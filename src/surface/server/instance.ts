import { describeRoute, resolver, validator } from "hono-openapi"
import { Hono } from "hono"
import type { UpgradeWebSocket } from "hono/ws"
import z from "zod"
import { createHash } from "node:crypto"
import { existsSync, readdirSync, statSync } from "node:fs"
import { Buffer } from "node:buffer"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Log } from "@/foundation/util/log"
import { Format } from "@/foundation/format"
import { TuiRoutes } from "@/surface/server/routes/tui"
import { Instance } from "@/config/project/instance"
import { Vcs } from "@/config/project/vcs"
import { Agent } from "@/agent/agent"
import { Global } from "@/filesystem/global"
import { Command } from "@/surface/command"
import { Flag } from "@/foundation/flag/flag"
import { PermissionRoutes } from "@/surface/server/routes/permission"
import { Snapshot } from "@/storage/snapshot"
import { ProjectRoutes } from "@/surface/server/routes/project"
import { SessionRoutes } from "@/surface/server/routes/session"
import { PtyRoutes } from "@/surface/server/routes/pty"
import { FileRoutes } from "@/surface/server/routes/file"
import { ConfigRoutes } from "@/surface/server/routes/config"
import { ExperimentalRoutes } from "@/surface/server/routes/experimental"
import { ProviderRoutes } from "@/surface/server/routes/provider"
import { EventRoutes } from "@/surface/server/routes/event"
import { ThemeRoutes } from "@/surface/server/routes/theme"
import { NotesRoutes } from "@/surface/server/routes/notes"
import { IntelGraphRoutes } from "@/surface/server/routes/intelgraph"
import { errorHandler } from "@/surface/server/middleware"
import embeddedWebUIAssetMap from "./opencode-web-ui.gen"

const log = Log.create({ service: "server" })
const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url))
type EmbeddedAsset = string | { type: string; data: string }

function localWebUIAssetMap() {
  const base = path.resolve(SERVER_DIR, "../../../dist/web-ui")
  const indexHTML = path.join(base, "index.html")
  if (!existsSync(indexHTML)) return null
  const out: Record<string, EmbeddedAsset> = {}
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const full = path.join(current, entry)
      const info = statSync(full)
      if (info.isDirectory()) {
        walk(full)
        continue
      }
      if (!info.isFile()) continue
      out[path.relative(base, full).replaceAll("\\", "/")] = full
    }
  }
  walk(base)
  return out
}

const bundledWebUIAssetMap = embeddedWebUIAssetMap as Record<string, EmbeddedAsset>
const embeddedUIPromise = Promise.resolve(
  Flag.OPENCODE_DISABLE_EMBEDDED_WEB_UI
    ? localWebUIAssetMap()
    : Object.keys(bundledWebUIAssetMap).length > 0
      ? bundledWebUIAssetMap
      : localWebUIAssetMap(),
)

const csp = (hash = "") =>
  `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'${hash ? ` 'sha256-${hash}'` : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; media-src 'self' data:; connect-src 'self' ws: wss: data:`

export const InstanceRoutes = (upgrade: UpgradeWebSocket, app: Hono = new Hono()) =>
  app
    .onError(errorHandler(log))
    .route("/project", ProjectRoutes())
    .route("/pty", PtyRoutes(upgrade))
    .route("/config", ConfigRoutes())
    .route("/experimental", ExperimentalRoutes())
    .route("/session", SessionRoutes())
    .route("/permission", PermissionRoutes())
    .route("/provider", ProviderRoutes())
    .route("/theme", ThemeRoutes())
    .route("/notes", NotesRoutes())
    .route("/intelgraph", IntelGraphRoutes())
    .route("/", FileRoutes())
    .route("/", EventRoutes())
    .route("/tui", TuiRoutes())
    .post(
      "/instance/dispose",
      describeRoute({
        summary: "Dispose instance",
        description: "Clean up and dispose the current OpenCode instance, releasing all resources.",
        operationId: "instance.dispose",
        responses: {
          200: {
            description: "Instance disposed",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      async (c) => {
        await Instance.dispose()
        return c.json(true)
      },
    )
    .get(
      "/path",
      describeRoute({
        summary: "Get paths",
        description: "Retrieve the current working directory and related path information for the OpenCode instance.",
        operationId: "path.get",
        responses: {
          200: {
            description: "Path",
            content: {
              "application/json": {
                schema: resolver(
                  z
                    .object({
                      home: z.string(),
                      state: z.string(),
                      config: z.string(),
                      worktree: z.string(),
                      directory: z.string(),
                    })
                    .meta({
                      ref: "Path",
                    }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json({
          home: Global.Path.home,
          state: Global.Path.state,
          config: Global.Path.config,
          worktree: Instance.worktree,
          directory: Instance.directory,
        })
      },
    )
    .get(
      "/vcs",
      describeRoute({
        summary: "Get VCS info",
        description: "Retrieve version control system (VCS) information for the current project, such as git branch.",
        operationId: "vcs.get",
        responses: {
          200: {
            description: "VCS info",
            content: {
              "application/json": {
                schema: resolver(Vcs.Info),
              },
            },
          },
        },
      }),
      async (c) => {
        const [branch, default_branch] = await Promise.all([Vcs.branch(), Vcs.defaultBranch()])
        return c.json({
          branch,
          default_branch,
        })
      },
    )
    .get(
      "/vcs/diff",
      describeRoute({
        summary: "Get VCS diff",
        description: "Retrieve the current git diff for the working tree or against the default branch.",
        operationId: "vcs.diff",
        responses: {
          200: {
            description: "VCS diff",
            content: {
              "application/json": {
                schema: resolver(Snapshot.FileDiff.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          mode: Vcs.Mode,
        }),
      ),
      async (c) => {
        return c.json(await Vcs.diff(c.req.valid("query").mode))
      },
    )
    .get(
      "/command",
      describeRoute({
        summary: "List commands",
        description: "Get a list of all available commands in the OpenCode system.",
        operationId: "command.list",
        responses: {
          200: {
            description: "List of commands",
            content: {
              "application/json": {
                schema: resolver(Command.Info.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        const commands = await Command.list()
        return c.json(commands)
      },
    )
    .get(
      "/agent",
      describeRoute({
        summary: "List agents",
        description: "Get a list of all available AI agents in the OpenCode system.",
        operationId: "app.agents",
        responses: {
          200: {
            description: "List of agents",
            content: {
              "application/json": {
                schema: resolver(Agent.Info.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        const modes = await Agent.list()
        return c.json(modes)
      },
    )
    .get(
      "/skill",
      describeRoute({
        summary: "List skills (deprecated)",
        description: "Deprecated route. Todo+notes-centric mode no longer exposes runtime skills.",
        operationId: "app.skills",
        responses: {
          200: {
            description: "Always empty list in todo+notes-centric mode",
            content: {
              "application/json": {
                schema: resolver(
                  z
                    .object({
                      name: z.string(),
                      description: z.string(),
                      location: z.string(),
                      content: z.string(),
                    })
                    .array(),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json([])
      },
    )
    .get(
      "/formatter",
      describeRoute({
        summary: "Get formatter status",
        description: "Get formatter status",
        operationId: "formatter.status",
        responses: {
          200: {
            description: "Formatter status",
            content: {
              "application/json": {
                schema: resolver(Format.Status.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await Format.status())
      },
    )
    .all("/*", async (c) => {
      // Only GET/HEAD should ever resolve to embedded web assets.
      // For unknown API methods/paths, return a 404 JSON error so
      // clients don't accidentally parse `index.html` as a successful API response.
      if (c.req.method !== "GET" && c.req.method !== "HEAD") {
        return c.json({ error: "Not Found" }, 404)
      }

      const embeddedWebUI = await embeddedUIPromise
      const path = c.req.path

      if (!embeddedWebUI || Object.keys(embeddedWebUI).length === 0) {
        return c.json(
          {
            error:
              "Unified web UI assets are unavailable. Build src/surface/web/official/packages/app and regenerate opencode-web-ui.gen.ts.",
          },
          503,
        )
      }

      const requestPath = path.replace(/^\//, "")
      const looksLikeAsset = /\.[a-z0-9]+$/i.test(requestPath)
      const match = embeddedWebUI[requestPath] ?? (looksLikeAsset ? null : (embeddedWebUI["index.html"] ?? null))
      if (!match) return c.json({ error: "Not Found" }, 404)
      const asset = typeof match === "string" ? Bun.file(match) : null
      if (asset && !(await asset.exists())) return c.json({ error: "Not Found" }, 404)
      const contentType = typeof match === "string" ? asset!.type : match.type
      c.header("Content-Type", contentType)
      c.header("Vary", "Authorization")
      if (requestPath === "site.webmanifest" || contentType.startsWith("text/html")) {
        c.header("Cache-Control", "no-store")
      }
      if (contentType.startsWith("text/html")) {
        const text =
          typeof match === "string" ? await asset!.text() : Buffer.from(match.data, "base64").toString("utf8")
        const matchScript = text.match(
          /<script\b(?![^>]*\bsrc\s*=)[^>]*\bid=(["'])oc-theme-preload-script\1[^>]*>([\s\S]*?)<\/script>/i,
        )
        const hash = matchScript ? createHash("sha256").update(matchScript[2]).digest("base64") : ""
        c.header("Content-Security-Policy", csp(hash))
        return c.text(text, 200, { "Content-Type": contentType })
      }
      return c.body(typeof match === "string" ? await asset!.arrayBuffer() : Buffer.from(match.data, "base64"))
    })
