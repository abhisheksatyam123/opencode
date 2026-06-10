#!/usr/bin/env node
/**
 * query.ts — Query the IntelGraph intelligence graph directly from a SQLite snapshot.
 *
 * This tool runs entirely from the CLI without a
 * running server.  It opens the persisted .intelgraph/intelligence.db and
 * executes a typed query via the orchestrated query pipeline.
 *
 * Usage:
 *   bun run src/bin/query.ts [workspace] --intent=<intent> [options]
 *
 * Options:
 *   --intent=<intent>       Required. One of the 97+ QUERY_INTENTS
 *   --snapshot-id=<n>       Snapshot ID (default: latest ready)
 *   --api=<name>            apiName parameter
 *   --struct=<name>         structName parameter
 *   --src=<name>            srcApi parameter
 *   --dst=<name>            dstApi parameter
 *   --pattern=<str>         pattern parameter
 *   --file=<path>           filePath parameter
 *   --line=<n>              lineNumber parameter
 *   --depth=<n>             depth parameter
 *   --limit=<n>             limit parameter
 *   --log-level=<level>     logLevel parameter
 *   --json                  Output raw JSON (NodeProtocolResponse)
 *   --flat                  Output legacy flat {nodes, edges} JSON
 *   --help / -h             Show usage
 *
 * Exit codes:
 *   0  — success
 *   1  — no persisted snapshot found (run `bun run extract <workspace>` first)
 *   2  — bad arguments / validation error
 *   3  — query execution error
 */

import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { createSqliteStore } from "../intelligence/db/sqlite/factory.js"
import { SqliteGraphProjectionService } from "../intelligence/db/sqlite/projection-service.js"
import {
  QUERY_INTENTS,
  validateQueryRequest,
  executeOrchestratedQuery,
  queryNodeAdapter,
} from "../intelligence/public-api.js"
import { toLegacyFlatResponse } from "../intelligence/query-node-adapter.js"
import type { OrchestratorRunnerDeps } from "../intelligence/orchestrator-runner.js"

// ── Types ────────────────────────────────────────────────────────────────────

type OutputFormat = "human" | "json" | "flat"

type LogLevel = "ERROR" | "WARN" | "INFO" | "DEBUG" | "VERBOSE" | "TRACE" | "UNKNOWN"

const LOG_LEVELS: readonly LogLevel[] = ["ERROR", "WARN", "INFO", "DEBUG", "VERBOSE", "TRACE", "UNKNOWN"]

// ── Help text ────────────────────────────────────────────────────────────────

const HELP = `
Usage: intelgraph-query [workspace] --intent=<intent> [options]

Arguments:
  workspace               Path to workspace (default: current directory)

Required:
  --intent=<intent>       Query intent. Run with --list-intents to see all.

Options:
  --snapshot-id=<n>       Snapshot ID (default: latest ready snapshot)
  --api=<name>            apiName parameter
  --struct=<name>         structName parameter
  --src=<name>            srcApi parameter
  --dst=<name>            dstApi parameter
  --pattern=<str>         pattern parameter
  --file=<path>           filePath parameter
  --line=<n>              lineNumber (1-based)
  --depth=<n>             depth parameter
  --limit=<n>             max result rows (default: 20)
  --log-level=<level>     logLevel: ERROR|WARN|INFO|DEBUG|VERBOSE|TRACE|UNKNOWN

Output format (pick one):
  --json                  Output raw JSON (NodeProtocolResponse)
  --flat                  Output legacy flat {nodes, edges} JSON
  (default)               Human-readable summary

Other:
  --list-intents          Print all available query intents and exit
  --help / -h             Show this help

Examples:
  bun run src/bin/query.ts . --intent=who_calls_api --api=MyFunction
  bun run src/bin/query.ts . --intent=find_module_imports --api=myModule --json
  bun run src/bin/query.ts . --intent=find_workspace_health --flat
`.trim()

// ── Argument parsing ─────────────────────────────────────────────────────────

interface ParsedArgs {
  workspace: string
  intent: string | null
  snapshotId: number | null
  apiName: string | undefined
  structName: string | undefined
  srcApi: string | undefined
  dstApi: string | undefined
  pattern: string | undefined
  filePath: string | undefined
  lineNumber: number | undefined
  depth: number | undefined
  limit: number | undefined
  logLevel: LogLevel | undefined
  format: OutputFormat
  listIntents: boolean
  help: boolean
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2)
  let workspace = process.cwd()
  let intent: string | null = null
  let snapshotId: number | null = null
  let apiName: string | undefined
  let structName: string | undefined
  let srcApi: string | undefined
  let dstApi: string | undefined
  let pattern: string | undefined
  let filePath: string | undefined
  let lineNumber: number | undefined
  let depth: number | undefined
  let limit: number | undefined
  let logLevel: LogLevel | undefined
  let format: OutputFormat = "human"
  let listIntents = false
  let help = false

  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      help = true
    } else if (arg === "--list-intents") {
      listIntents = true
    } else if (arg === "--json") {
      format = "json"
    } else if (arg === "--flat") {
      format = "flat"
    } else if (arg.startsWith("--intent=")) {
      intent = arg.slice("--intent=".length)
    } else if (arg.startsWith("--snapshot-id=")) {
      const n = Number(arg.slice("--snapshot-id=".length))
      if (Number.isFinite(n) && n >= 1) snapshotId = Math.floor(n)
      else {
        console.error("--snapshot-id= requires a positive integer")
        process.exit(2)
      }
    } else if (arg.startsWith("--api=")) {
      apiName = arg.slice("--api=".length)
    } else if (arg.startsWith("--struct=")) {
      structName = arg.slice("--struct=".length)
    } else if (arg.startsWith("--src=")) {
      srcApi = arg.slice("--src=".length)
    } else if (arg.startsWith("--dst=")) {
      dstApi = arg.slice("--dst=".length)
    } else if (arg.startsWith("--pattern=")) {
      pattern = arg.slice("--pattern=".length)
    } else if (arg.startsWith("--file=")) {
      filePath = arg.slice("--file=".length)
    } else if (arg.startsWith("--line=")) {
      const n = Number(arg.slice("--line=".length))
      if (Number.isFinite(n) && n >= 1) lineNumber = Math.floor(n)
      else {
        console.error("--line= requires a positive integer")
        process.exit(2)
      }
    } else if (arg.startsWith("--depth=")) {
      const n = Number(arg.slice("--depth=".length))
      if (Number.isFinite(n) && n >= 1) depth = Math.floor(n)
      else {
        console.error("--depth= requires a positive integer")
        process.exit(2)
      }
    } else if (arg.startsWith("--limit=")) {
      const n = Number(arg.slice("--limit=".length))
      if (Number.isFinite(n) && n >= 1) limit = Math.floor(n)
      else {
        console.error("--limit= requires a positive integer")
        process.exit(2)
      }
    } else if (arg.startsWith("--log-level=")) {
      const v = arg.slice("--log-level=".length).toUpperCase() as LogLevel
      if (LOG_LEVELS.includes(v)) logLevel = v
      else {
        console.error(`--log-level= must be one of: ${LOG_LEVELS.join(", ")}`)
        process.exit(2)
      }
    } else if (!arg.startsWith("--")) {
      workspace = resolve(arg)
    } else {
      console.error(`Unknown option: ${arg}`)
      console.error("Run with --help for usage.")
      process.exit(2)
    }
  }

  return {
    workspace,
    intent,
    snapshotId,
    apiName,
    structName,
    srcApi,
    dstApi,
    pattern,
    filePath,
    lineNumber,
    depth,
    limit,
    logLevel,
    format,
    listIntents,
    help,
  }
}

// ── DB helpers ───────────────────────────────────────────────────────────────

function findDbPath(workspace: string): string | null {
  const dbPath = join(workspace, ".intelgraph", "intelligence.db")
  return existsSync(dbPath) ? dbPath : null
}

// ── Human-readable formatter ─────────────────────────────────────────────────

function printHumanReadable(intent: string, items: Array<Record<string, unknown>>): void {
  const sep = "─".repeat(60)
  console.log(`\n${sep}`)
  console.log(`Intent: ${intent}  (${items.length} result${items.length === 1 ? "" : "s"})`)
  console.log(sep)

  if (items.length === 0) {
    console.log("  (no results)")
    console.log(sep)
    return
  }

  for (const item of items) {
    // Try to find a meaningful primary label
    const label =
      (item.name as string | undefined) ??
      (item.api as string | undefined) ??
      (item.symbol as string | undefined) ??
      (item.module as string | undefined) ??
      (item.file as string | undefined) ??
      "(unnamed)"

    const kind = item.kind ? ` [${item.kind}]` : ""
    const module = item.module && item.module !== label ? `  module: ${item.module}` : ""
    const file = item.file ? `  file: ${item.file}${item.line != null ? `:${item.line}` : ""}` : ""
    const detail = item.detail ? `  detail: ${item.detail}` : ""
    const score = item.score != null ? `  score: ${item.score}` : ""

    console.log(`\n  ${label}${kind}${module}${file}${detail}${score}`)

    // Print any remaining fields not already shown
    const shown = new Set(["name", "api", "symbol", "module", "file", "line", "kind", "detail", "score"])
    for (const [k, v] of Object.entries(item)) {
      if (!shown.has(k) && v != null && v !== "") {
        const display = typeof v === "object" ? JSON.stringify(v) : String(v)
        if (display.length <= 120) {
          console.log(`    ${k}: ${display}`)
        }
      }
    }
  }

  console.log(`\n${sep}`)
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv)

  if (parsed.help) {
    console.log(HELP)
    process.exit(0)
  }

  if (parsed.listIntents) {
    console.log("Available query intents:")
    for (const intent of QUERY_INTENTS) {
      console.log(`  ${intent}`)
    }
    process.exit(0)
  }

  if (!parsed.intent) {
    console.error("Error: --intent=<intent> is required.")
    console.error("Run with --help for usage, or --list-intents to see all intents.")
    process.exit(2)
  }

  if (!existsSync(parsed.workspace)) {
    console.error(`Workspace not found: ${parsed.workspace}`)
    process.exit(1)
  }

  const dbPath = findDbPath(parsed.workspace)
  if (!dbPath) {
    console.error(
      `No persisted snapshot found in ${parsed.workspace}.\n` +
        `Run: bun run extract ${parsed.workspace}\n` +
        `to create one first.`,
    )
    process.exit(1)
  }

  const { client, foundation, lookup } = createSqliteStore({ path: dbPath })

  try {
    // Resolve snapshot ID
    let snapshotId = parsed.snapshotId
    if (snapshotId === null) {
      const snapshotRef = await foundation.getLatestReadySnapshot(parsed.workspace)
      if (snapshotRef) {
        snapshotId = snapshotRef.snapshotId
      } else {
        // Fall back to most-recent ready snapshot regardless of workspace path
        const fallbackRow = client.raw
          .prepare(
            `SELECT snapshot_id AS snapshotId FROM graph_snapshots WHERE status = 'ready'
             ORDER BY snapshot_id DESC LIMIT 1`,
          )
          .get() as { snapshotId: number } | undefined
        if (fallbackRow) {
          snapshotId = fallbackRow.snapshotId
        }
      }
    }

    if (snapshotId === null) {
      console.error(`No ready snapshot found for ${parsed.workspace} in ${dbPath}.`)
      process.exit(1)
    }

    // Build the raw query request object
    const rawRequest: Record<string, unknown> = {
      intent: parsed.intent,
      snapshotId,
    }
    if (parsed.apiName !== undefined) rawRequest.apiName = parsed.apiName
    if (parsed.structName !== undefined) rawRequest.structName = parsed.structName
    if (parsed.srcApi !== undefined) rawRequest.srcApi = parsed.srcApi
    if (parsed.dstApi !== undefined) rawRequest.dstApi = parsed.dstApi
    if (parsed.pattern !== undefined) rawRequest.pattern = parsed.pattern
    if (parsed.filePath !== undefined) rawRequest.filePath = parsed.filePath
    if (parsed.lineNumber !== undefined) rawRequest.lineNumber = parsed.lineNumber
    if (parsed.depth !== undefined) rawRequest.depth = parsed.depth
    if (parsed.limit !== undefined) rawRequest.limit = parsed.limit
    if (parsed.logLevel !== undefined) rawRequest.logLevel = parsed.logLevel

    // Validate the request
    const validated = validateQueryRequest(rawRequest)
    if (!validated.ok) {
      console.error(`Invalid query request: ${validated.errors.join("; ")}`)
      process.exit(2)
    }

    const request = validated.value

    // Build minimal OrchestratorRunnerDeps — no-op enrichers since CLI is read-only
    const projection = new SqliteGraphProjectionService()
    const deps: OrchestratorRunnerDeps = {
      persistence: {
        dbLookup: lookup,
        authoritativeStore: {
          persistEnrichment: async (_req, result) => result.persistedRows,
        },
        graphProjection: projection,
      },
      clangdEnricher: {
        source: "clangd" as const,
        enrich: async () => ({ attempts: [], persistedRows: 0 }),
      },
      cParserEnricher: {
        source: "c_parser" as const,
        enrich: async () => ({ attempts: [], persistedRows: 0 }),
      },
    }

    // Execute the query
    let normalizedResponse
    try {
      normalizedResponse = await executeOrchestratedQuery(request, deps)
    } catch (err) {
      console.error(`Query execution failed: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(3)
    }

    // Convert to NodeProtocolResponse
    const nodeProto = queryNodeAdapter.toNodeResponse(request, normalizedResponse)

    // Output
    if (parsed.format === "json") {
      console.log(JSON.stringify(nodeProto, null, 2))
    } else if (parsed.format === "flat") {
      const flat = toLegacyFlatResponse(nodeProto)
      console.log(JSON.stringify(flat, null, 2))
    } else {
      // Human-readable — items are flat node objects (NodeProtocolResponse data items)
      const items = nodeProto.data.items as Array<Record<string, unknown>>
      printHumanReadable(request.intent, items)
    }
  } finally {
    client.close()
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err instanceof Error ? err.message : String(err))
  process.exit(3)
})
