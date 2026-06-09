import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"

type Level = "debug" | "info" | "warn" | "error"
type DiagnosticClient = Pick<OpencodeClient, "app">

type LogInput = {
  client?: DiagnosticClient
  service: string
  message: string
  level?: Level
  extra?: Record<string, unknown>
}

type QueuedLog = {
  service: string
  message: string
  level: Level
  extra: Record<string, unknown>
}

type RuntimeDiagnosticOptions = {
  service?: string
  extra?: Record<string, unknown>
}

const MAX_BUFFERED_LOGS = 500
const rawConsole = {
  debug: console.debug.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
}

function directLogUrl() {
  if (typeof window === "undefined") return
  try {
    return new URL("/log", window.location.href).toString()
  } catch {
    return
  }
}

async function sendDirect(log: QueuedLog) {
  const url = directLogUrl()
  if (!url || typeof fetch === "undefined") return false
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      keepalive: true,
      body: JSON.stringify({
        service: log.service,
        level: log.level,
        message: log.message,
        extra: log.extra,
      }),
    })
    return true
  } catch (error) {
    rawConsole.warn("[web.diagnostic] direct backend log failed", diagnosticError(error))
    return false
  }
}

async function flushDirect() {
  if (directFlushing || defaultClient) return
  directFlushing = true
  try {
    for (const log of [...buffered]) {
      await sendDirect(log)
    }
  } finally {
    directFlushing = false
  }
}

let defaultClient: DiagnosticClient | undefined
let flushing = false
let runtimeInstalled = false
let consoleInstalled = false
let directFlushing = false
let droppedLogs = 0
const buffered: QueuedLog[] = []

function isBenignWindowError(message?: string) {
  if (!message) return false
  return (
    message.includes("ResizeObserver loop completed with undelivered notifications") ||
    message.includes("ResizeObserver loop limit exceeded")
  )
}

function errorSummary(extra: Record<string, unknown>) {
  const error = extra.error
  const message = typeof extra.message === "string" ? extra.message : undefined
  const errorMessage =
    error && typeof error === "object" && "message" in error && typeof error.message === "string"
      ? error.message
      : undefined
  const filename = typeof extra.filename === "string" ? extra.filename : undefined
  const lineno = typeof extra.lineno === "number" ? extra.lineno : undefined
  const colno = typeof extra.colno === "number" ? extra.colno : undefined
  const location = filename ? `${filename}${lineno ? `:${lineno}${colno ? `:${colno}` : ""}` : ""}` : undefined
  const text = message || errorMessage
  if (!text && !location) return
  return [text, location].filter(Boolean).join(" @ ")
}

function writeConsole(level: Level, prefix: string, extra: Record<string, unknown>) {
  if (level === "error") {
    const summary = errorSummary(extra)
    if (summary) rawConsole.error(prefix, summary, extra)
    else rawConsole.error(prefix, extra)
  } else if (level === "warn") rawConsole.warn(prefix, extra)
  else if (level === "debug") rawConsole.debug(prefix, extra)
  else rawConsole.info(prefix, extra)
}

function queue(log: QueuedLog) {
  buffered.push(log)
  if (buffered.length <= MAX_BUFFERED_LOGS) return
  const overflow = buffered.length - MAX_BUFFERED_LOGS
  buffered.splice(0, overflow)
  droppedLogs += overflow
}

async function send(client: DiagnosticClient, log: QueuedLog) {
  await client.app.log({
    service: log.service,
    level: log.level,
    message: log.message,
    extra: log.extra,
  })
}

async function flush(client: DiagnosticClient) {
  if (flushing) return
  flushing = true

  try {
    if (droppedLogs > 0) {
      const dropped = droppedLogs
      droppedLogs = 0
      await send(client, {
        service: "web.diagnostic",
        level: "warn",
        message: "diagnostic_log_buffer_overflow",
        extra: { dropped },
      })
    }

    while (buffered.length > 0) {
      const next = buffered.shift()
      if (!next) break
      try {
        await send(client, next)
      } catch (error) {
        buffered.unshift(next)
        rawConsole.warn("[web.diagnostic] backend log failed", diagnosticError(error))
        return
      }
    }
  } finally {
    flushing = false
  }
}

export function setDiagnosticClient(client: DiagnosticClient | undefined) {
  defaultClient = client
  if (!client) return
  void flush(client)
}

export function diagnosticError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    }
  }
  return {
    value: String(error),
  }
}

export function emitDiagnosticLog(input: LogInput) {
  const level: Level = input.level ?? "info"
  const payload: QueuedLog = {
    service: input.service,
    message: input.message,
    level,
    extra: input.extra ?? {},
  }
  const prefix = `[${payload.service}] ${payload.message}`
  writeConsole(level, prefix, payload.extra)

  queue(payload)

  const client = input.client ?? defaultClient
  if (!client) {
    void sendDirect(payload)
    void flushDirect()
    return
  }
  void flush(client)
}

export function installRuntimeDiagnosticHandlers(options: RuntimeDiagnosticOptions = {}) {
  if (runtimeInstalled || typeof window === "undefined") return
  runtimeInstalled = true

  const service = options.service ?? "web.runtime"
  const base = options.extra ?? {}

  if (!consoleInstalled) {
    consoleInstalled = true
    ;(["debug", "info", "warn", "error"] as const).forEach((level) => {
      console[level] = (...args: unknown[]) => {
        rawConsole[level](...args)
        emitDiagnosticLog({
          service: "web.console",
          level,
          message: args
            .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(diagnosticError(arg))))
            .join(" ")
            .slice(0, 2_000),
          extra: { ...base, page: window.location.href, args: args.map((arg) => diagnosticError(arg)) },
        })
      }
    })
  }

  emitDiagnosticLog({
    service,
    level: "info",
    message: "runtime.diagnostics_installed",
    extra: { ...base, page: window.location.href },
  })

  window.addEventListener(
    "error",
    (event) => {
      const target = event.target as (EventTarget & { tagName?: string; src?: string; href?: string }) | null
      const isResourceError = !!target && target !== window
      if (isResourceError) {
        emitDiagnosticLog({
          service,
          level: "error",
          message: "window.resource_error",
          extra: {
            ...base,
            page: window.location.href,
            tagName: target?.tagName,
            src: target?.src,
            href: target?.href,
          },
        })
        return
      }

      const errorEvent = event as ErrorEvent
      if (isBenignWindowError(errorEvent.message)) return
      emitDiagnosticLog({
        service,
        level: "error",
        message: "window.error",
        extra: {
          ...base,
          page: window.location.href,
          message: errorEvent.message,
          filename: errorEvent.filename,
          lineno: errorEvent.lineno,
          colno: errorEvent.colno,
          error: diagnosticError(errorEvent.error),
        },
      })
    },
    true,
  )

  window.addEventListener("unhandledrejection", (event) => {
    emitDiagnosticLog({
      service,
      level: "error",
      message: "window.unhandled_rejection",
      extra: {
        ...base,
        page: window.location.href,
        reason: diagnosticError(event.reason),
      },
    })
  })
}
