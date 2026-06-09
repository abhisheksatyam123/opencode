import path from "path"
import fs from "fs"
import { vaultPath } from "@/foundation/notes-root"
import { Log } from "@/foundation/util/log"
import { BufferedWriter } from "@/foundation/util/buffered-writer"
import { NdjsonSafe } from "@/foundation/util/ndjson-safe"
import z from "zod"
import { Redact } from "./redact"

// ─── Schema ──────────────────────────────────────────────────────────────────

export const HttpLogRequest = z.object({
  method: z.string(),
  url: z.string(),
  headers: z.record(z.string(), z.string()),
  body: z.unknown().nullable(),
  body_raw: z.string().nullable(),
  body_bytes_total: z.number().int().nonnegative(),
  truncated: z.boolean(),
})

export const HttpLogResponse = z.object({
  status: z.number().int().nullable(),
  headers: z.record(z.string(), z.string()),
  body: z.unknown().nullable(),
  body_raw: z.string().nullable(),
  body_bytes_total: z.number().int().nonnegative(),
  truncated: z.boolean(),
  streaming: z.boolean(),
  chunk_count: z.number().int().nonnegative().nullable(),
  first_chunk_ms: z.number().nonnegative().nullable(),
  last_chunk_ms: z.number().nonnegative().nullable(),
  partial: z.boolean(),
  aborted: z.boolean(),
  error: z
    .object({
      kind: z.string(),
      message: z.string(),
      stack: z.string().optional(),
    })
    .nullable(),
})

export const HttpLogRecord = z.object({
  ts: z.string(),
  request_id: z.string(),
  session_id: z.string(),
  parent_session_id: z.string().nullable(),
  message_id: z.string().nullable(),
  attempt: z.number().int().nonnegative(),
  parent_request_id: z.string().nullable(),
  provider_id: z.string(),
  model_id: z.string(),
  duration_ms: z.number().nonnegative(),
  request: HttpLogRequest,
  response: HttpLogResponse,
})

export type HttpLogRecord = z.infer<typeof HttpLogRecord>
export type HttpLogRequest = z.infer<typeof HttpLogRequest>
export type HttpLogResponse = z.infer<typeof HttpLogResponse>

// ─── Bus events ──────────────────────────────────────────────────────────────

export const LlmHttpRequestEvent = { type: "llm.http.request" } as const

export const LlmHttpResponseEvent = { type: "llm.http.response" } as const

// ─── Internal state ───────────────────────────────────────────────────────────

const log = Log.create({ service: "http-log" })

const MAX_BYTES = Number(process.env["OPENCODE_HTTP_LOG_MAX_BYTES"] ?? 64 * 1024 * 1024)
const MAX_BODY_BYTES = process.env["OPENCODE_HTTP_LOG_MAX_BODY_BYTES"]
  ? Number(process.env["OPENCODE_HTTP_LOG_MAX_BODY_BYTES"])
  : Infinity
const MAX_SESSIONS = Number(process.env["OPENCODE_HTTP_LOG_MAX_SESSIONS"] ?? 50)

type WriterEntry = { writer: BufferedWriter.Writer; size: number; idle: ReturnType<typeof setTimeout> }
const writers = new Map<string, WriterEntry>()
const MAX_WRITERS = 16
let initialized = false

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sessionDir(sessionId: string): string {
  return path.join(vaultPath.logDir("global"), "session", sessionId)
}

function sessionFile(sessionId: string): string {
  return path.join(sessionDir(sessionId), "http.jsonl")
}

function evict(sessionId: string) {
  const entry = writers.get(sessionId)
  if (!entry) return
  try {
    entry.writer.flush()
    entry.writer.dispose()
  } catch {}
  clearTimeout(entry.idle)
  writers.delete(sessionId)
}

function rollFile(sessionId: string) {
  const entry = writers.get(sessionId)
  if (!entry) return
  try {
    entry.writer.flush()
    entry.writer.dispose()
  } catch {}
  clearTimeout(entry.idle)
  writers.delete(sessionId)
  const ts = new Date().toISOString().replace(/[:.]/g, "-")
  const src = sessionFile(sessionId)
  const dst = path.join(sessionDir(sessionId), `http.${ts}.jsonl`)
  try {
    fs.renameSync(src, dst)
  } catch {}
}

function resetIdle(sessionId: string) {
  const entry = writers.get(sessionId)
  if (!entry) return
  clearTimeout(entry.idle)
  entry.idle = setTimeout(() => evict(sessionId), 5 * 60 * 1000)
}

function getWriter(sessionId: string): BufferedWriter.Writer {
  const existing = writers.get(sessionId)
  if (existing) {
    resetIdle(sessionId)
    return existing.writer
  }

  // evict oldest if at cap
  if (writers.size >= MAX_WRITERS) {
    const oldest = writers.keys().next().value
    if (oldest) evict(oldest)
  }

  const dir = sessionDir(sessionId)
  fs.mkdirSync(dir, { recursive: true })

  const filePath = sessionFile(sessionId)
  let existingSize = 0
  try {
    existingSize = fs.statSync(filePath).size
  } catch {}

  const writer = BufferedWriter.create({
    writeFn: (content) => fs.appendFileSync(filePath, content),
    flushIntervalMs: 200,
    maxBufferSize: 100,
    maxBufferBytes: 64 * 1024,
  })

  const idle = setTimeout(() => evict(sessionId), 5 * 60 * 1000)
  writers.set(sessionId, { writer, size: existingSize, idle })
  return writer
}

function truncateBody(raw: string | null): { raw: string | null; bytes_total: number; truncated: boolean } {
  if (raw == null) return { raw: null, bytes_total: 0, truncated: false }
  const bytes = Buffer.byteLength(raw, "utf8")
  if (bytes <= MAX_BODY_BYTES) return { raw, bytes_total: bytes, truncated: false }
  // utf8-safe slice
  const buf = Buffer.from(raw, "utf8").subarray(0, MAX_BODY_BYTES)
  return { raw: buf.toString("utf8"), bytes_total: bytes, truncated: true }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export namespace HttpSessionLog {
  export function record(envelope: HttpLogRecord): void {
    try {
      const line = NdjsonSafe.stringify(envelope) + "\n"
      const writer = getWriter(envelope.session_id)
      writer.write(line)

      const entry = writers.get(envelope.session_id)
      if (entry) {
        entry.size += Buffer.byteLength(line, "utf8")
        if (entry.size > MAX_BYTES) rollFile(envelope.session_id)
      }
    } catch (e) {
      log.error("record failed", { sessionID: envelope.session_id, err: String(e) })
    }
  }

  export async function init(): Promise<void> {
    if (initialized) return
    initialized = true
    try {
      const sessionRoot = path.join(vaultPath.logDir("global"), "session")
      fs.mkdirSync(sessionRoot, { recursive: true })
      const dirs = fs.readdirSync(sessionRoot)
      const withMtime = dirs
        .map((d) => {
          try {
            const stat = fs.statSync(path.join(sessionRoot, d))
            return { name: d, mtime: stat.mtimeMs }
          } catch {
            return null
          }
        })
        .filter(Boolean) as { name: string; mtime: number }[]
      withMtime.sort((a, b) => b.mtime - a.mtime)
      const toDelete = withMtime.slice(MAX_SESSIONS)
      for (const d of toDelete) {
        try {
          fs.rmSync(path.join(sessionRoot, d.name), { recursive: true, force: true })
        } catch {}
      }
    } catch (e) {
      log.error("init failed", { err: String(e) })
    }
  }

  export function disposeSync(): void {
    for (const [id] of writers) {
      try {
        const entry = writers.get(id)
        if (entry) {
          entry.writer.flush()
          entry.writer.dispose()
          clearTimeout(entry.idle)
        }
      } catch {}
    }
    writers.clear()
  }

  export async function dispose(): Promise<void> {
    disposeSync()
  }

  /** Build a request envelope from raw fetch inputs */
  export function buildRequest(
    input: RequestInfo | URL,
    init: RequestInit & { body?: BodyInit | null },
  ): HttpLogRequest {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url
    const method = init?.method ?? "GET"
    const rawHeaders: Record<string, string> = {}
    if (init?.headers) {
      const h = new Headers(init.headers as HeadersInit)
      h.forEach((v, k) => {
        rawHeaders[k] = v
      })
    }
    const bodyStr = typeof init?.body === "string" ? init.body : null
    const { raw: truncatedRaw, bytes_total, truncated } = truncateBody(bodyStr)
    const redactedRaw = Redact.body(truncatedRaw)
    return {
      method,
      url,
      headers: Redact.headers(rawHeaders),
      body: Redact.parseBodyJson(redactedRaw),
      body_raw: redactedRaw,
      body_bytes_total: bytes_total,
      truncated,
    }
  }

  /** Build a response envelope from assembled body string */
  export function buildResponse(opts: {
    status: number | null
    headers: Record<string, string>
    bodyRaw: string | null
    streaming: boolean
    chunkCount: number | null
    firstChunkMs: number | null
    lastChunkMs: number | null
    partial: boolean
    aborted: boolean
    error: { kind: string; message: string; stack?: string } | null
  }): HttpLogResponse {
    const { raw: truncatedRaw, bytes_total, truncated } = truncateBody(opts.bodyRaw)
    const redactedRaw = Redact.body(truncatedRaw)
    return {
      status: opts.status,
      headers: Redact.headers(opts.headers),
      body: Redact.parseBodyJson(redactedRaw),
      body_raw: redactedRaw,
      body_bytes_total: bytes_total,
      truncated,
      streaming: opts.streaming,
      chunk_count: opts.chunkCount,
      first_chunk_ms: opts.firstChunkMs,
      last_chunk_ms: opts.lastChunkMs,
      partial: opts.partial,
      aborted: opts.aborted,
      error: opts.error,
    }
  }
}

// ─── App exit wiring ─────────────────────────────────────────────────────────

process.on("exit", () => HttpSessionLog.disposeSync())
process.on("SIGTERM", async () => {
  await HttpSessionLog.dispose()
  process.exit(0)
})
