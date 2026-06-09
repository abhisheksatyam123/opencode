import { appendFile, mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { Log } from "@/foundation/util/log"
import { vaultPath } from "@/notes/root"

export type IntelGraphLogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR"

const log = Log.create({ service: "intelgraph" })

export type IntelGraphLogEntry = {
  level?: IntelGraphLogLevel
  source: "opencode" | "frontend" | "backend" | "notes" | "vendor" | "plugin"
  component?: string
  message: string
  workspaceRoot?: string
  error?: unknown
  context?: Record<string, unknown>
}

function serializeError(error: unknown): Record<string, unknown> | undefined {
  if (!error) return undefined
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: error.cause instanceof Error ? serializeError(error.cause) : error.cause,
    }
  }
  if (typeof error === "object") return error as Record<string, unknown>
  return { message: String(error) }
}

export function intelGraphLogPath(workspaceRoot: string): string {
  const explicit = process.env.OPENCODE_INTELGRAPH_LOG_FILE || process.env.INTELGRAPH_LOG_FILE
  if (explicit) return resolve(explicit)
  return resolve(vaultPath.root(), "log", "intelgraph.log")
}

export async function appendIntelGraphLog(workspaceRoot: string, entry: IntelGraphLogEntry): Promise<void> {
  const file = intelGraphLogPath(workspaceRoot)
  const level = entry.level ?? "ERROR"
  const record = {
    timestamp: new Date().toISOString(),
    level,
    source: entry.source,
    component: entry.component ?? entry.source,
    message: entry.message,
    workspace: resolve(entry.workspaceRoot ?? workspaceRoot ?? process.cwd()),
    pid: process.pid,
    context: entry.context,
    error: serializeError(entry.error),
  }
  writeCentralLog(level, entry)
  try {
    await mkdir(dirname(file), { recursive: true })
    await appendFile(file, `${JSON.stringify(record)}\n`, "utf8")
  } catch (err) {
    process.stderr.write(
      `[intelgraph-log] failed to append ${file}: ${err instanceof Error ? err.message : String(err)}\n`,
    )
  }
}

function writeCentralLog(level: IntelGraphLogLevel, entry: IntelGraphLogEntry) {
  const extra = {
    source: entry.source,
    component: entry.component,
    workspaceRoot: entry.workspaceRoot,
    context: entry.context,
    error: entry.error,
  }
  if (level === "DEBUG") return log.debug(entry.message, extra)
  if (level === "INFO") return log.info(entry.message, extra)
  if (level === "WARN") return log.warn(entry.message, extra)
  return log.error(entry.message, extra)
}
