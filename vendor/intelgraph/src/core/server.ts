/**
 * server.ts — HTTP JSON API server.
 *
 * Exposes the intelligence graph and LSP tools over a plain HTTP JSON API.
 *
 * Routes:
 *   POST /api/query     → intelligence query (transport-agnostic)
 *   GET  /api/health    → { ok, pid, uptime }
 *   GET  /api/graph     → GraphJson (latest snapshot)
 *   GET  /api/graph/diff → GraphDiff (?from=N&to=M)
 *   GET  /api/file?path= → file content (workspace-confined, read-only)
 */

import { createServer, type IncomingMessage, type ServerResponse } from "http"
import { readFile, stat, realpath } from "fs/promises"
import { resolve, normalize, relative } from "path"
import { setUnifiedBackend } from "../tools/index.js"
import { loggerPort } from "../logging/logger.js"
import type { BackendDeps } from "./types.js"

const log = loggerPort.child("server")

// ── File API constants ────────────────────────────────────────────────────────
const FILE_API_MAX_BYTES = 2 * 1024 * 1024 // 2 MB

// ── JSON API helper: response ─────────────────────────────────────────────────

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-cache",
  })
  res.end(payload)
}

// ── JSON API helper: parse JSON request body ──────────────────────────────────

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = ""
    req.on("data", (chunk) => { data += chunk })
    req.on("end", () => {
      try { resolve(JSON.parse(data)) }
      catch (e) { reject(new Error("Invalid JSON body")) }
    })
    req.on("error", reject)
  })
}


// ── JSON API route: /api/health ─────────────────────────────────────────────────

function handleHealth(res: ServerResponse): void {
  jsonResponse(res, 200, {
    ok: true,
    pid: process.pid,
    uptime: process.uptime(),
  })
}

// ── JSON API route: /api/query ──────────────────────────────────────────────────

async function handleQuery(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: import("../services/app-context.js").AppContext,
): Promise<void> {
  try {
    const body = await readJsonBody(req)
    const { executeQuery } = await import("../services/query-service.js")
    const result = await executeQuery(body, ctx)
    if ("ok" in result && result.ok === false) {
      jsonResponse(res, 400, result)
    } else {
      jsonResponse(res, 200, result)
    }
  } catch (err: any) {
    jsonResponse(res, 500, { ok: false, errors: [err?.message ?? String(err)] })
  }
}

// ── JSON API route: /api/graph ──────────────────────────────────────────────────

async function handleGraph(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  workspaceRoot: string,
): Promise<void> {
  // Lazy import to avoid circular deps at module load time
  const { getIntelligenceDeps } = await import("../tools/dispatch.js")
  const { getDbFoundation } = await import("../intelligence/public-api.js")

  const deps = getIntelligenceDeps()
  if (!deps) {
    jsonResponse(res, 503, { error: "no_backend", message: "Intelligence backend not initialized" })
    return
  }

  const lookup = deps.persistence.dbLookup
  if (typeof lookup.loadGraphJson !== "function") {
    jsonResponse(res, 503, { error: "no_graph_support", message: "Backend does not support graph reads" })
    return
  }

  // Resolve latest snapshot
  const dbFoundation = getDbFoundation()
  let snapshotId: number | undefined
  if (dbFoundation) {
    try {
      const latest = await dbFoundation.getLatestReadySnapshot(workspaceRoot)
      if (latest?.snapshotId) snapshotId = latest.snapshotId
    } catch {
      // non-fatal — fall through to caller-supplied snapshotId
    }
  }

  // Allow explicit override via query param
  const qSnapshotId = url.searchParams.get("snapshotId")
  if (qSnapshotId) {
    const parsed = parseInt(qSnapshotId, 10)
    if (!isNaN(parsed)) snapshotId = parsed
  }

  if (!snapshotId) {
    jsonResponse(res, 404, { error: "no_snapshot", message: "No ready snapshot found for workspace" })
    return
  }

  // Build filters from query params
  const filters: Record<string, unknown> = {}

  const edgeKinds = url.searchParams.get("edgeKinds")
  if (edgeKinds) filters.edgeKinds = new Set(edgeKinds.split(",").map((s) => s.trim()))

  const symbolKinds = url.searchParams.get("symbolKinds")
  if (symbolKinds) filters.symbolKinds = new Set(symbolKinds.split(",").map((s) => s.trim()))

  const centerOf = url.searchParams.get("centerOf")
  if (centerOf) filters.centerOf = centerOf

  const centerHops = url.searchParams.get("centerHops")
  if (centerHops) {
    const n = parseInt(centerHops, 10)
    if (!isNaN(n)) filters.centerHops = n
  }

  const centerDirection = url.searchParams.get("centerDirection")
  if (centerDirection === "in" || centerDirection === "out" || centerDirection === "both") {
    filters.centerDirection = centerDirection
  }

  const maxNodes = url.searchParams.get("maxNodes")
  if (maxNodes) {
    const n = parseInt(maxNodes, 10)
    if (!isNaN(n)) filters.maxNodes = n
  }

  try {
    const graph = lookup.loadGraphJson(snapshotId, workspaceRoot, filters)
    jsonResponse(res, 200, graph)
  } catch (err: any) {
    log.error("handleGraph error", err)
    jsonResponse(res, 500, { error: "graph_error", message: String(err?.message ?? err) })
  }
}

// ── JSON API route: /api/graph/diff ─────────────────────────────────────────────

async function handleGraphDiff(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  workspaceRoot: string,
): Promise<void> {
  const { getIntelligenceDeps } = await import("../tools/dispatch.js")
  const { diffGraphJson } = await import("../intelligence/public-api.js")

  const deps = getIntelligenceDeps()
  if (!deps) {
    jsonResponse(res, 503, { error: "no_backend", message: "Intelligence backend not initialized" })
    return
  }

  const lookup = deps.persistence.dbLookup
  if (typeof lookup.loadGraphJson !== "function") {
    jsonResponse(res, 503, { error: "no_graph_support", message: "Backend does not support graph reads" })
    return
  }

  const fromParam = url.searchParams.get("from")
  const toParam = url.searchParams.get("to")
  if (!fromParam || !toParam) {
    jsonResponse(res, 400, { error: "missing_params", message: "Required: ?from=<snapshotId>&to=<snapshotId>" })
    return
  }

  const fromId = parseInt(fromParam, 10)
  const toId = parseInt(toParam, 10)
  if (isNaN(fromId) || isNaN(toId)) {
    jsonResponse(res, 400, { error: "invalid_params", message: "from and to must be integers" })
    return
  }

  try {
    const graphA = lookup.loadGraphJson(fromId, workspaceRoot, {})
    const graphB = lookup.loadGraphJson(toId, workspaceRoot, {})
    const diff = diffGraphJson(graphA, graphB)
    jsonResponse(res, 200, diff)
  } catch (err: any) {
    log.error("handleGraphDiff error", err)
    jsonResponse(res, 500, { error: "diff_error", message: String(err?.message ?? err) })
  }
}

// ── JSON API route: /api/file ───────────────────────────────────────────────────

async function handleFile(
  res: ServerResponse,
  url: URL,
  workspaceRoot: string,
): Promise<void> {
  const pathParam = url.searchParams.get("path")
  if (!pathParam || pathParam.trim() === "") {
    jsonResponse(res, 400, { error: "missing_path" })
    return
  }

  // Resolve: if relative, resolve against workspaceRoot; if absolute, use as-is
  const rawPath = pathParam.trim()
  const resolved = rawPath.startsWith("/")
    ? normalize(rawPath)
    : resolve(workspaceRoot, rawPath)

  // Workspace confinement check (before realpath — catches obvious traversal)
  const wsNorm = normalize(workspaceRoot)
  if (!resolved.startsWith(wsNorm + "/") && resolved !== wsNorm) {
    jsonResponse(res, 400, { error: "path_traversal" })
    return
  }

  // Stat + realpath (catches symlink escapes)
  let realResolved: string
  try {
    realResolved = await realpath(resolved)
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      jsonResponse(res, 404, { error: "not_found" })
    } else {
      jsonResponse(res, 500, { error: "read_error", message: String(err?.message ?? err) })
    }
    return
  }

  // Re-check confinement after realpath (symlink escape guard)
  if (!realResolved.startsWith(wsNorm + "/") && realResolved !== wsNorm) {
    jsonResponse(res, 400, { error: "path_traversal" })
    return
  }

  // Stat to check directory + size
  let fileStat: Awaited<ReturnType<typeof stat>>
  try {
    fileStat = await stat(realResolved)
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      jsonResponse(res, 404, { error: "not_found" })
    } else {
      jsonResponse(res, 500, { error: "read_error", message: String(err?.message ?? err) })
    }
    return
  }

  if (fileStat.isDirectory()) {
    jsonResponse(res, 403, { error: "is_directory" })
    return
  }

  if (fileStat.size > FILE_API_MAX_BYTES) {
    jsonResponse(res, 413, { error: "file_too_large" })
    return
  }

  // Read file
  let content: string
  try {
    content = await readFile(realResolved, "utf-8")
  } catch (err: any) {
    jsonResponse(res, 500, { error: "read_error", message: String(err?.message ?? err) })
    return
  }

  const workspaceRelative = relative(wsNorm, realResolved)
  const lineCount = content.split("\n").length

  jsonResponse(res, 200, {
    path: realResolved,
    workspace_relative: workspaceRelative,
    content,
    line_count: lineCount,
    size_bytes: fileStat.size,
  })
}

// ── HTTP JSON API server ──────────────────────────────────────────────────────

// How long the HTTP server stays alive with no requests before auto-exiting.
const HTTP_IDLE_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

export async function startHttp(
  deps: BackendDeps,
  port: number,
): Promise<void> {
  log.info("Starting HTTP API server", { port, pid: process.pid })
  setUnifiedBackend(deps.backend)

  // Workspace root for file/API routes (fallback to cwd)
  const workspaceRoot = deps.workspaceRoot ?? process.cwd()

  // ── AppContext for transport-agnostic service handlers ──────────────────
  const appCtx: import("../services/app-context.js").AppContext = {
    getClient: deps.getClient,
    tracker: deps.tracker,
    backend: deps.backend,
    workspaceRoot,
    onShutdown: deps.onGracefulShutdown,
    intelligenceDeps: null, // populated lazily via getIntelligenceDeps()
    dbFoundation: null,     // populated lazily via getDbFoundation()
  }

  // ── Idle auto-exit ──────────────────────────────────────────────────────
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let activeRequests = 0

  // Graceful shutdown: run injected teardown before exiting.
  const gracefulExit = async (reason: string): Promise<void> => {
    log.info(`HTTP server ${reason} — running graceful shutdown hook`, {
      port, pid: process.pid,
    })
    if (deps.onGracefulShutdown) {
      try {
        await deps.onGracefulShutdown()
      } catch (err) {
        log.warn("Error running graceful shutdown hook", {
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }
    process.exit(0)
  }

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer)
    if (activeRequests === 0) {
      idleTimer = setTimeout(() => {
        gracefulExit("idle timeout — no active requests")
      }, HTTP_IDLE_TIMEOUT_MS)
    } else {
      idleTimer = null
    }
  }
  // Start the idle timer immediately — if no client ever connects, exit after timeout
  resetIdleTimer()

  // Graceful shutdown on termination signals
  process.once("SIGTERM", () => gracefulExit("SIGTERM received"))
  process.once("SIGINT", () => gracefulExit("SIGINT received"))

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    activeRequests++
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }

    res.on("finish", () => {
      activeRequests--
      resetIdleTimer()
    })

    const url = new URL(req.url ?? "/", `http://localhost:${port}`)

    // ── POST /api/query — transport-agnostic intelligence query ─────────────
    if (url.pathname === "/api/query" && req.method === "POST") {
      // Refresh lazily-populated deps on each request
      const { getIntelligenceDeps } = await import("../tools/dispatch.js")
      const { getDbFoundation } = await import("../intelligence/public-api.js")
      appCtx.intelligenceDeps = getIntelligenceDeps()
      appCtx.dbFoundation = getDbFoundation()
      await handleQuery(req, res, appCtx)
      return
    }

    // ── Remaining JSON API routes (GET only) ─────────────────────────────────
    if (req.method !== "GET") {
      res.writeHead(405).end("Method not allowed")
      return
    }

    try {
      if (url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/app.js") {
        jsonResponse(res, 404, {
          error: "web_ui_removed",
          message: "IntelGraph standalone web UI was removed; use JSON API endpoints or the OpenCode IntelGraph pane.",
        })
        return
      }

      if (url.pathname === "/api/health") {
        handleHealth(res)
        return
      }

      if (url.pathname === "/api/graph/diff") {
        await handleGraphDiff(req, res, url, workspaceRoot)
        return
      }

      if (url.pathname === "/api/graph") {
        await handleGraph(req, res, url, workspaceRoot)
        return
      }

      if (url.pathname === "/api/file") {
        await handleFile(res, url, workspaceRoot)
        return
      }

      res.writeHead(404).end("Not found")
    } catch (err: any) {
      log.error("Unhandled API route error", err)
      jsonResponse(res, 500, { error: "internal_error", message: String(err?.message ?? err) })
    }
  })

  await new Promise<void>((resolve) => httpServer.listen(port, resolve))
  log.info("HTTP API server listening", { url: `http://localhost:${port}/`, port, pid: process.pid })
  process.stderr.write(`[intelgraph] HTTP API server listening on http://localhost:${port}/\n`)
}
