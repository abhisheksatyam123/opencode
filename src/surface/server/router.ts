import type { MiddlewareHandler } from "hono"
import type { UpgradeWebSocket } from "hono/ws"
import { getAdaptor } from "@/bus/control-plane/adaptors"
import { WorkspaceID } from "@/bus/control-plane/schema"
import { Workspace } from "@/bus/control-plane/workspace"
import { lazy } from "@/foundation/util/lazy"
import { Filesystem } from "@/foundation/util/filesystem"
import { Instance } from "@/config/project/instance"
import { InstanceBootstrap } from "@/config/project/bootstrap"
import { InstanceRoutes } from "@/surface/server/instance"
import { Log } from "@/foundation/util/log"
import { Project } from "@/config/project/project"
import { Global } from "@/filesystem/global"

type Rule = { method?: string; path: string; exact?: boolean; action: "local" | "forward" }

const RULES: Array<Rule> = [
  { path: "/session/status", action: "forward" },
  { method: "GET", path: "/session", action: "local" },
]
const log = Log.create({ service: "workspace-router" })

function local(method: string, path: string) {
  for (const rule of RULES) {
    if (rule.method && rule.method !== method) continue
    const match = rule.exact ? path === rule.path : path === rule.path || path.startsWith(rule.path + "/")
    if (match) return rule.action === "local"
  }
  return false
}

function isKnownProjectDirectory(directory: string) {
  try {
    return Project.list().some((project) => {
      if (Filesystem.contains(project.worktree, directory)) return true
      return project.sandboxes.some((sandbox) => Filesystem.contains(sandbox, directory))
    })
  } catch {
    return false
  }
}

function within(root: string, directory: string) {
  if (!root || root === "/") return false
  return directory === root || directory.startsWith(root + "/") || directory.startsWith(root + "\\")
}

function workspaceRoots() {
  const roots = [process.cwd(), Global.Path.home, process.env.OPENCODE_WORKSPACE_ROOT]
    .filter((root): root is string => !!root)
    .map((root) => Filesystem.resolve(root))
  return Array.from(new Set(roots))
}

export function WorkspaceRouterMiddleware(upgrade: UpgradeWebSocket): MiddlewareHandler {
  const routes = lazy(() => InstanceRoutes(upgrade))

  return async (c) => {
    const raw = c.req.query("directory") || c.req.header("x-opencode-directory") || process.cwd()
    const directory = Filesystem.resolve(
      (() => {
        try {
          return decodeURIComponent(raw)
        } catch {
          return raw
        }
      })(),
    )
    const url = new URL(c.req.url)
    const workspaceParam = url.searchParams.get("workspace")
    const traceProjectOpen =
      (c.req.method === "GET" && url.pathname === "/project") ||
      (c.req.method === "GET" && url.pathname === "/session") ||
      (c.req.method === "GET" && url.pathname.startsWith("/session/")) ||
      (c.req.method === "GET" && url.pathname === "/path")

    if (traceProjectOpen) {
      log.info("resolve.start", {
        method: c.req.method,
        path: url.pathname,
        directoryRaw: raw,
        directory,
        workspace: workspaceParam ?? undefined,
      })
    }

    // Workspace allowlist check: reject traversal and out-of-allowlist paths.
    // Allow startup cwd plus workspace home (parent of notes root by default) so
    // single-binary WebUI can open sibling project roots even when launched from
    // the opencode repo directory.
    const roots = workspaceRoots()
    const isAllowed = roots.some((root) => within(root, directory)) || isKnownProjectDirectory(directory)
    if (!isAllowed && !c.req.query("workspace") && !c.req.header("x-opencode-workspace")) {
      log.warn("resolve.workspace_forbidden", {
        method: c.req.method,
        path: url.pathname,
        directoryRaw: raw,
        directory,
        roots,
      })
      return c.json(
        {
          error: {
            code: "workspace_forbidden",
            message: "Directory is outside the allowed workspace",
            details: { directory },
          },
        },
        403,
      )
    }

    // Backlog: when session is being routed, force project/workspace lookup

    // If no workspace is provided we use the "project" workspace
    if (!workspaceParam) {
      // If there is already an active Instance context (e.g. in tests), reuse it
      // directly rather than creating a new one from process.cwd().
      let hasContext = false
      try {
        Instance.current
        hasContext = true
      } catch {}
      if (hasContext) {
        if (traceProjectOpen) {
          log.info("resolve.local_reuse_instance", {
            method: c.req.method,
            path: url.pathname,
            directory,
          })
        }
        return routes().fetch(c.req.raw, c.env)
      }
      if (traceProjectOpen) {
        log.info("resolve.local_new_instance", {
          method: c.req.method,
          path: url.pathname,
          directory,
        })
      }
      return Instance.provide({
        directory,
        init: InstanceBootstrap,
        async fn() {
          return routes().fetch(c.req.raw, c.env)
        },
      })
    }

    const workspaceID = WorkspaceID.make(workspaceParam)
    const workspace = await Workspace.get(workspaceID)
    if (!workspace) {
      log.warn("resolve.workspace_not_found", {
        method: c.req.method,
        path: url.pathname,
        workspaceID,
        directory,
      })
      return new Response(`Workspace not found: ${workspaceID}`, {
        status: 500,
        headers: {
          "content-type": "text/plain; charset=utf-8",
        },
      })
    }

    // Handle local workspaces directly so we can pass env to `fetch`,
    // necessary for websocket upgrades
    if (workspace.type === "worktree") {
      if (traceProjectOpen) {
        log.info("resolve.worktree_instance", {
          method: c.req.method,
          path: url.pathname,
          workspaceID,
          directory: workspace.directory,
        })
      }
      return Instance.provide({
        directory: workspace.directory!,
        init: InstanceBootstrap,
        async fn() {
          return routes().fetch(c.req.raw, c.env)
        },
      })
    }

    // Remote workspaces

    if (local(c.req.method, url.pathname)) {
      if (traceProjectOpen) {
        log.info("resolve.remote_local_rule", {
          method: c.req.method,
          path: url.pathname,
          workspaceID,
          workspaceType: workspace.type,
        })
      }
      // No instance provided because we are serving cached data; there
      // is no instance to work with
      return routes().fetch(c.req.raw, c.env)
    }

    if (traceProjectOpen) {
      log.info("resolve.remote_forward", {
        method: c.req.method,
        path: url.pathname,
        workspaceID,
        workspaceType: workspace.type,
      })
    }
    const adaptor = await getAdaptor(workspace.type)
    const headers = new Headers(c.req.raw.headers)
    headers.delete("x-opencode-workspace")

    return adaptor.fetch(workspace, `${url.pathname}${url.search}`, {
      method: c.req.method,
      body: c.req.method === "GET" || c.req.method === "HEAD" ? undefined : await c.req.raw.arrayBuffer(),
      signal: c.req.raw.signal,
      headers,
    })
  }
}
