import { Hono } from "hono"
import { Instance } from "@/config/project/instance"
import { lazy } from "@/foundation/util/lazy"
import {
  intelGraphCapabilities,
  normalizeIntelGraphRelationRequest,
  type IntelGraphApi,
  type IntelGraphRelationKind,
  type IntelGraphRelationRequest,
} from "@/intelgraph/contract"
import { getDefaultIntelGraphRuntime, type IntelGraphRuntimeStatus } from "@/intelgraph/backend/runtime"
import { appendIntelGraphLog, intelGraphLogPath } from "@/intelgraph/backend/log"

const INTELGRAPH_BASE_PATH = "/intelgraph"

type IntelGraphRouteDependencies = {
  v1Api: IntelGraphApi
  workspaceRoot: () => string
}

type ResolvedIntelGraphRouteDependencies = Omit<IntelGraphRouteDependencies, "v1Api"> & {
  v1Api?: () => IntelGraphApi
}

export function createIntelGraphRoutes(input?: Partial<IntelGraphRouteDependencies>) {
  const injectedV1Api = input?.v1Api
  const dependencies: ResolvedIntelGraphRouteDependencies = {
    v1Api: injectedV1Api ? () => injectedV1Api : undefined,
    workspaceRoot: input?.workspaceRoot ?? defaultWorkspaceRoot,
  }
  return new Hono()
    .all("/", async (c) => dispatch(c.req.raw, c.req.path, dependencies))
    .all("/*", async (c) => dispatch(c.req.raw, c.req.path, dependencies))
}

export const IntelGraphRoutes = lazy(() => createIntelGraphRoutes())

async function dispatch(
  req: Request,
  fullPath: string,
  dependencies: ResolvedIntelGraphRouteDependencies,
): Promise<Response> {
  const url = new URL(req.url)
  const path = normalizeRoutePath(fullPath)

  if (req.method === "GET" && (path === "/" || path === "/index.html"))
    return json(
      {
        ok: false,
        error: "standalone IntelGraph UI was removed; use the in-session OpenCode relation pane",
      },
      404,
    )
  if (req.method === "GET" && path === "/api/capabilities") return json(intelGraphCapabilities())
  if (req.method === "GET" && path === "/api/status") return json(runtimeStatusFor(dependencies))
  if (req.method === "GET" && path === "/api/search-symbol")
    return withLoggedIntelGraphError("api.searchSymbol", req, dependencies, () => apiSearchSymbol(url, dependencies))
  if (req.method === "GET" && path === "/api/resolve-relations")
    return withLoggedIntelGraphError("api.resolveRelations", req, dependencies, () =>
      apiResolveRelations(relationRequestFromUrl(url), dependencies),
    )
  if (req.method === "POST" && path === "/api/resolve-relations")
    return withLoggedIntelGraphError("api.resolveRelations", req, dependencies, () =>
      apiResolveRelationsPost(req, dependencies),
    )
  if (req.method === "POST" && path === "/api/log") return apiClientLog(req, dependencies)

  return json({ ok: false, error: "not found" }, 404)
}

function normalizeRoutePath(path: string) {
  if (!path) return "/"
  if (path === INTELGRAPH_BASE_PATH || path === `${INTELGRAPH_BASE_PATH}/`) return "/"
  if (path.startsWith(`${INTELGRAPH_BASE_PATH}/`)) return path.slice(INTELGRAPH_BASE_PATH.length)
  return path
}

function defaultWorkspaceRoot() {
  return Instance.directory || Instance.worktree || process.env.OPENCODE_WORKSPACE_ROOT || process.cwd()
}

function optionalNumber(value: string | null) {
  if (!value) return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function optionalBoolean(value: string | null) {
  if (value === null || value.trim() === "") return undefined
  if (value === "true" || value === "1") return true
  if (value === "false" || value === "0") return false
  return undefined
}

function splitCsv(value: string | null): string[] {
  if (!value) return []
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

async function apiSearchSymbol(url: URL, dependencies: ResolvedIntelGraphRouteDependencies) {
  const symbol = (url.searchParams.get("symbol") ?? url.searchParams.get("q") ?? "").trim()
  if (!symbol) return jsonError("missing_symbol", "Missing symbol", 400)
  return json(
    await v1ApiFor(dependencies).searchSymbol({
      symbol,
      file: (url.searchParams.get("file") ?? "").trim() || undefined,
      line: optionalNumber(url.searchParams.get("line")),
      character: optionalNumber(url.searchParams.get("character")),
      language: "c",
      limit: optionalNumber(url.searchParams.get("limit")),
    }),
  )
}

function relationRequestFromUrl(url: URL): IntelGraphRelationRequest {
  return {
    symbol: (url.searchParams.get("symbol") ?? "").trim(),
    file: (url.searchParams.get("file") ?? "").trim() || undefined,
    line: optionalNumber(url.searchParams.get("line")),
    character: optionalNumber(url.searchParams.get("character")),
    kinds: relationKindsFrom(splitCsv(url.searchParams.get("kinds"))),
    language: "c",
    limits: {
      maxResultsPerKind: optionalNumber(url.searchParams.get("maxResultsPerKind")),
      timeoutMs: optionalNumber(url.searchParams.get("timeoutMs")),
    },
  }
}

async function apiResolveRelationsPost(req: Request, dependencies: ResolvedIntelGraphRouteDependencies) {
  let body: IntelGraphRelationRequest
  try {
    const parsed = await req.json()
    body =
      parsed && typeof parsed === "object"
        ? (parsed as IntelGraphRelationRequest)
        : ({ symbol: "" } as IntelGraphRelationRequest)
  } catch {
    return jsonError("invalid_json", "Request body must be JSON", 400)
  }
  return apiResolveRelations(body, dependencies)
}

async function apiResolveRelations(
  request: IntelGraphRelationRequest,
  dependencies: ResolvedIntelGraphRouteDependencies,
) {
  if (!request.symbol.trim() && (!request.file || !request.line))
    return jsonError("missing_symbol_or_location", "Missing symbol or file+line", 400)
  return json(await v1ApiFor(dependencies).resolveRelations(normalizeIntelGraphRelationRequest(request)))
}

function relationKindsFrom(values: string[]): IntelGraphRelationKind[] | undefined {
  const allowed = new Set<IntelGraphRelationKind>(["api_callers", "api_registrations", "indirect_registered_callers"])
  const kinds = values.filter((value): value is IntelGraphRelationKind => allowed.has(value as IntelGraphRelationKind))
  return kinds.length ? kinds : undefined
}

function v1ApiFor(dependencies: ResolvedIntelGraphRouteDependencies): IntelGraphApi {
  const injected = dependencies.v1Api?.()
  if (injected) return injected
  return getDefaultIntelGraphRuntime(dependencies.workspaceRoot()).api
}

function runtimeStatusFor(dependencies: ResolvedIntelGraphRouteDependencies): IntelGraphRuntimeStatus {
  const injected = dependencies.v1Api?.()
  if (injected) {
    return {
      workspaceRoot: dependencies.workspaceRoot(),
      state: "ready",
      index: {
        isReady: true,
        percentage: 100,
        message: "Injected IntelGraph API",
        updatedAt: new Date().toISOString(),
      },
      languages: [],
    }
  }
  return getDefaultIntelGraphRuntime(dependencies.workspaceRoot()).status()
}

async function apiClientLog(req: Request, dependencies: ResolvedIntelGraphRouteDependencies) {
  const workspaceRoot = dependencies.workspaceRoot()
  const body = await req.json().catch(() => undefined)
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {}
  const message = typeof record.message === "string" && record.message.trim() ? record.message : "frontend error"
  const component = typeof record.component === "string" ? record.component : "frontend"
  const context =
    typeof record.context === "object" && record.context !== null ? (record.context as Record<string, unknown>) : {}
  await appendIntelGraphLog(workspaceRoot, {
    source: "frontend",
    component,
    message,
    error: record.error,
    context: { path: new URL(req.url).pathname, ...context },
  })
  return json({ ok: true, log: intelGraphLogPath(workspaceRoot) })
}

async function withLoggedIntelGraphError(
  operation: string,
  req: Request,
  dependencies: ResolvedIntelGraphRouteDependencies,
  fn: () => Promise<Response>,
): Promise<Response> {
  try {
    return await fn()
  } catch (err) {
    await logIntelGraphError(dependencies, operation, err, req)
    const message = err instanceof Error ? err.message : String(err)
    return jsonError("intelgraph_error", message, 500, {
      operation,
      log: intelGraphLogPath(dependencies.workspaceRoot()),
    })
  }
}

async function logIntelGraphError(
  dependencies: ResolvedIntelGraphRouteDependencies,
  operation: string,
  err: unknown,
  req: Request,
  context: Record<string, unknown> = {},
): Promise<void> {
  const workspaceRoot = dependencies.workspaceRoot()
  const url = new URL(req.url)
  await appendIntelGraphLog(workspaceRoot, {
    source: "backend",
    component: `opencode.${operation}`,
    message: err instanceof Error ? err.message : String(err),
    error: err,
    context: { method: req.method, path: url.pathname, query: url.search, ...context },
  })
}

function jsonError(code: string, message: string, status = 400, details: Record<string, unknown> = {}) {
  return json({ error: { code, message, details } }, status)
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  })
}
