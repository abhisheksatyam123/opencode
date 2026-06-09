import { diagnosticError, emitDiagnosticLog } from "@/utils/diagnostic-log"
import type { ServerConnection } from "@/context/server"
import { authTokenFromCredentials } from "@/utils/server"
import type {
  SurfaceBridge,
  SurfaceIntelGraphV1Capabilities,
  SurfaceIntelGraphV1RelationResult,
  SurfaceIntelGraphV1SymbolSearchResult,
  SurfaceNoteFile,
  SurfaceNoteFileResponse,
  SurfaceNoteSearchResult,
  SurfaceNotesGraph,
  SurfaceSessionTokenStats,
  SurfaceTodoSnapshot,
} from "./ports"
import { normalizeTodoSnapshot } from "./normalize"

const TODO_TTL_MS = 1_000
const STATS_TTL_MS = 2_000
const NOTES_TTL_MS = 15 * 60_000
const INTELGRAPH_TTL_MS = 15_000
const INTELGRAPH_LOG_TIMEOUT_MS = 1_000

type CacheEntry<T> = { at: number; value: T }
type EventSourceLike = { listen: (handler: (event: { details: unknown }) => void) => () => void }

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

function errorMessage(body: unknown, fallback: string) {
  const root = object(body)
  const error = root.error
  if (typeof error === "string") return error
  const errorObject = object(error)
  const code = typeof errorObject.code === "string" ? errorObject.code : ""
  const message = typeof errorObject.message === "string" ? errorObject.message : ""
  if (code && message) return `${code}: ${message}`
  if (message) return message
  if (code) return code
  return fallback
}

type HttpInput = {
  baseUrl: string
  directory?: string
  server?: ServerConnection.HttpBase
  fetch?: typeof fetch
  event?: EventSourceLike
}

function makeHeaders(server?: ServerConnection.HttpBase) {
  const headers: Record<string, string> = { Accept: "application/json" }
  if (server?.password) {
    headers.Authorization = `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`
  }
  return headers
}

function makeUrl(baseUrl: string, path: string, directory?: string, query?: Record<string, string | undefined>) {
  const url = new URL(path, baseUrl)
  if (directory) url.searchParams.set("directory", directory)
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value)
  }
  return url
}

function createCache() {
  const store = new Map<string, CacheEntry<unknown>>()
  return {
    get<T>(key: string, ttl: number, force?: boolean): T | undefined {
      if (force) return undefined
      const hit = store.get(key)
      if (!hit || Date.now() - hit.at > ttl) return undefined
      return hit.value as T
    },
    set<T>(key: string, value: T) {
      store.set(key, { at: Date.now(), value })
      return value
    },
    delete(prefix: string) {
      for (const key of store.keys()) if (key.startsWith(prefix)) store.delete(key)
    },
  }
}

export function createHttpSurfaceBridge(input: HttpInput): SurfaceBridge {
  const cache = createCache()
  const logIntelGraphClientEvent = (
    sourcePath: string,
    message: string,
    context?: Record<string, unknown>,
    error?: unknown,
  ): void => {
    if (sourcePath === "/log") return
    const runFetch = input.fetch ?? fetch
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), INTELGRAPH_LOG_TIMEOUT_MS)
    try {
      void runFetch(makeUrl(input.baseUrl, "/log", input.directory), {
        method: "POST",
        headers: {
          ...makeHeaders(input.server),
          "Content-Type": "application/json",
        },
        signal: controller.signal,
        body: JSON.stringify({
          service: "surface.http-adapter",
          level: "error",
          message,
          error:
            error instanceof Error
              ? { name: error.name, message: error.message, stack: error.stack }
              : error === undefined
                ? undefined
                : { message: String(error) },
          context: { sourcePath, ...context },
        }),
      })
        .catch(() => undefined)
        .finally(() => clearTimeout(timeout))
    } catch {
      clearTimeout(timeout)
    }
  }

  const logIntelGraphClientError = (sourcePath: string, error: unknown, context?: Record<string, unknown>): void => {
    logIntelGraphClientEvent(sourcePath, error instanceof Error ? error.message : String(error), context, error)
  }

  const request = async <T>(
    path: string,
    query?: Record<string, string | undefined>,
    init?: RequestInit,
  ): Promise<T> => {
    const runFetch = input.fetch ?? fetch
    const url = makeUrl(input.baseUrl, path, input.directory, query)
    try {
      const response = await runFetch(url, {
        ...init,
        headers: {
          ...makeHeaders(input.server),
          ...(init?.headers as Record<string, string> | undefined),
        },
      })
      const contentType = response.headers.get("content-type") ?? ""
      if (!response.ok) {
        const body = contentType.includes("json") ? await response.json().catch(() => undefined) : await response.text()
        throw new Error(errorMessage(body, response.statusText))
      }
      if (contentType.includes("json")) return response.json() as Promise<T>
      return response.text() as Promise<T>
    } catch (error) {
      const context = { method: init?.method ?? "GET", url: url.toString(), path }
      emitDiagnosticLog({
        service: "surface.http-adapter",
        level: "error",
        message: error instanceof Error ? error.message : String(error),
        extra: { ...context, error: diagnosticError(error) },
      })
      logIntelGraphClientError(path, error, context)
      throw error
    }
  }

  return {
    async getTodoSnapshot(sessionID, options) {
      const key = `todo:${sessionID}`
      const cached = cache.get<SurfaceTodoSnapshot>(key, TODO_TTL_MS, options?.force)
      if (cached) return cached
      return cache.set(key, normalizeTodoSnapshot(await request(`/session/${sessionID}/todo`)))
    },
    async createTodoFile(sessionID, input) {
      const key = `todo:${sessionID}`
      cache.delete(key)
      return cache.set(
        key,
        normalizeTodoSnapshot(
          await request(`/session/${sessionID}/todo-file`, undefined, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(input),
          }),
        ),
      )
    },
    async attachTodoFile(sessionID, path) {
      const key = `todo:${sessionID}`
      cache.delete(key)
      return cache.set(
        key,
        normalizeTodoSnapshot(
          await request(`/session/${sessionID}/todo-file/attach`, undefined, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path }),
          }),
        ),
      )
    },
    async patchTodoFile(sessionID, input) {
      const key = `todo:${sessionID}`
      cache.delete(key)
      const result = await request<{ snapshot: unknown; changed: boolean; applied: number; hash: string }>(
        `/session/${sessionID}/todo-file/patch`,
        undefined,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
      )
      return { ...result, snapshot: cache.set(key, normalizeTodoSnapshot(result.snapshot)) }
    },
    async listTodoAgents(sessionID) {
      return request(`/session/${sessionID}/todo-agent`)
    },
    async runTodoAgentTask(sessionID, input) {
      return request(`/session/${sessionID}/todo-agent/run`, undefined, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      })
    },
    async getSessionStatuses() {
      return request("/session/status")
    },
    async getSessionStats(sessionID, options) {
      const key = `stats:${sessionID}`
      const cached = cache.get<SurfaceSessionTokenStats>(key, STATS_TTL_MS, options?.force)
      if (cached) return cached
      return cache.set(key, await request<SurfaceSessionTokenStats>(`/session/${sessionID}/stats`))
    },
    async listNotes(options) {
      const key = "notes:tree"
      const cached = cache.get<{ root: string; files: SurfaceNoteFile[] }>(key, NOTES_TTL_MS, options?.force)
      if (cached) return cached
      const response = await request<{ root: string; files: SurfaceNoteFile[] }>("/notes/api/tree")
      return cache.set(key, { root: response.root, files: response.files ?? [] })
    },
    async getNoteFile(path, options) {
      const key = `notes:file:${path}`
      const cached = cache.get<SurfaceNoteFileResponse>(key, NOTES_TTL_MS, options?.force)
      if (cached) return cached
      return cache.set(key, await request<SurfaceNoteFileResponse>("/notes/api/file", { path }))
    },
    async saveNoteFile(path, content) {
      cache.delete(`notes:file:${path}`)
      cache.delete("notes:tree")
      return request<{ path: string; size: number; backup?: string | null }>(
        "/notes/api/file",
        { path },
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
        },
      )
    },
    async searchNotes(query, options) {
      const key = `notes:search:${query}`
      const cached = cache.get<SurfaceNoteSearchResult[]>(key, NOTES_TTL_MS, options?.force)
      if (cached) return cached
      const response = await request<{ results: SurfaceNoteSearchResult[] }>("/notes/api/search", { q: query })
      return cache.set(key, response.results ?? [])
    },
    async getNotesGraph(options) {
      const key = "notes:graph"
      const cached = cache.get<SurfaceNotesGraph>(key, NOTES_TTL_MS, options?.force)
      if (cached) return cached
      return cache.set(key, await request<SurfaceNotesGraph>("/notes/api/graph"))
    },
    async capabilities(options) {
      const key = "intelgraph:v1:capabilities"
      const cached = cache.get<SurfaceIntelGraphV1Capabilities>(key, INTELGRAPH_TTL_MS, options?.force)
      if (cached) return cached
      return cache.set(key, await request<SurfaceIntelGraphV1Capabilities>("/intelgraph/api/capabilities"))
    },
    async searchSymbol(symbolRequest, options) {
      const key = `intelgraph:v1:search-symbol:${JSON.stringify(symbolRequest)}`
      const cached = cache.get<SurfaceIntelGraphV1SymbolSearchResult>(
        key,
        INTELGRAPH_TTL_MS,
        options?.force || options?.refresh,
      )
      if (cached) return cached
      return cache.set(
        key,
        await request<SurfaceIntelGraphV1SymbolSearchResult>("/intelgraph/api/search-symbol", {
          symbol: symbolRequest.symbol,
          file: symbolRequest.file,
          line: symbolRequest.line === undefined ? undefined : String(symbolRequest.line),
          character: symbolRequest.character === undefined ? undefined : String(symbolRequest.character),
          language: symbolRequest.language,
          limit: symbolRequest.limit === undefined ? undefined : String(symbolRequest.limit),
          refresh: options?.refresh ? "true" : undefined,
        }),
      )
    },
    async resolveRelations(relationRequest, options) {
      const key = `intelgraph:v1:resolve-relations:${JSON.stringify(relationRequest)}`
      const cached = cache.get<SurfaceIntelGraphV1RelationResult>(
        key,
        INTELGRAPH_TTL_MS,
        options?.force || options?.refresh,
      )
      if (cached) return cached
      const query = { dynamic: "true", refresh: options?.refresh ? "true" : undefined }
      return cache.set(
        key,
        await request<SurfaceIntelGraphV1RelationResult>("/intelgraph/api/resolve-relations", query, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(relationRequest),
        }),
      )
    },
    getIntelGraphUrl() {
      return makeUrl(input.baseUrl, "/intelgraph/", input.directory).toString()
    },
    getMermaidScriptUrl() {
      return makeUrl(input.baseUrl, "/notes/api/mermaid.js").toString()
    },
    async renderPlantUML(source) {
      return request<string>("/notes/api/plantuml", undefined, {
        method: "POST",
        headers: { "Content-Type": "text/plain; charset=utf-8", Accept: "image/svg+xml" },
        body: source,
      })
    },
    onTodoSnapshot(handler) {
      const event = input.event
      if (!event) return () => {}
      return event.listen((evt) => {
        const details = object(evt.details)
        if (details.type !== "task.updated") return
        const properties = object(details.properties)
        const sessionID = typeof properties.sessionID === "string" ? properties.sessionID : ""
        if (!sessionID) return
        cache.delete(`todo:${sessionID}`)
        handler({ sessionID, snapshot: normalizeTodoSnapshot(properties) })
      })
    },
  }
}
