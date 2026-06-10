#!/usr/bin/env node
/**
 * extract — build the intelligence graph DB for a workspace.
 *
 * Usage:
 *   npx tsx src/bin/extract.ts [workspace-path]
 *   npx tsx src/bin/extract.ts --force                 # rebuild even if exists
 *
 * Runs all applicable extractors (ts-core, rust-core, clangd-core) and
 * writes the graph into .intelgraph/intelligence.db. Run once per
 * workspace. After that, incremental updates happen automatically on
 * file save via the intelligence_extract_file transport tool.
 *
 * Exit code: 0 success, 1 failure
 */

import { resolve, join } from "node:path"
import { existsSync, mkdirSync } from "node:fs"
import { execSync } from "node:child_process"
import { createSqliteStore } from "../intelligence/db/sqlite/factory.js"
import { ExtractorRunner } from "../intelligence/extraction/runner.js"
import { BUILT_IN_EXTRACTORS } from "../plugins/index.js"
import type { ILanguageClient } from "../lsp/ports.js"

const args = process.argv.slice(2)
let workspace = process.cwd()
let force = false
let rebuild = false

for (const arg of args) {
  if (arg === "--force" || arg === "-f") {
    force = true
  } else if (arg === "--rebuild" || arg === "-r") {
    rebuild = true
    force = true
  } else if (arg === "--help" || arg === "-h") {
    console.log("Usage: extract [workspace-path] [--force] [--rebuild]")
    console.log("\nBuilds .intelgraph/intelligence.db for the workspace.")
    console.log("  --force    Overwrite existing snapshot")
    console.log("  --rebuild  Keep old snapshot as baseline, build a new one alongside it")
    console.log("             Then run: bun run analyze <ws> --compare=<prev-id>")
    console.log("\nAfter initial build, file saves trigger incremental updates via IntelGraph.")
    process.exit(0)
  } else if (!arg.startsWith("-")) workspace = resolve(arg)
}

// Detect current git revision for snapshot provenance
function gitRev(dir: string): string | null {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: dir, stdio: "pipe" }).toString().trim()
  } catch {
    return null
  }
}

if (!existsSync(workspace)) {
  console.error(`Error: workspace not found: ${workspace}`)
  process.exit(1)
}

const dbDir = join(workspace, ".intelgraph")
mkdirSync(dbDir, { recursive: true })
const dbPath = join(dbDir, "intelligence.db")

const stubLsp = {
  root: workspace,
  openFile: async () => false,
  documentSymbol: async () => [],
  outgoingCalls: async () => [],
  incomingCalls: async () => [],
  references: async () => [],
  definition: async () => [],
} as unknown as ILanguageClient

async function main() {
  const start = Date.now()
  console.log(`Workspace: ${workspace}`)
  console.log(`DB:        ${dbPath}`)

  const rev = gitRev(workspace)
  if (rev) console.log(`Git rev:   ${rev}`)

  const store_trio = createSqliteStore({ path: dbPath })
  const { client, foundation, sink: store } = store_trio
  try {
    await foundation.initSchema()

    const existing = await foundation.getLatestReadySnapshot(workspace)
    if (existing && !force) {
      const n = (
        client.raw.prepare("SELECT COUNT(*) AS n FROM graph_nodes WHERE snapshot_id=?").get(existing.snapshotId) as {
          n: number
        }
      ).n
      const e = (
        client.raw.prepare("SELECT COUNT(*) AS n FROM graph_edges WHERE snapshot_id=?").get(existing.snapshotId) as {
          n: number
        }
      ).n
      console.log(`\nSnapshot ${existing.snapshotId} already exists (${n} nodes, ${e} edges).`)
      console.log("Use --force to rebuild, or --rebuild to keep it as baseline for --compare diffs.")
      return
    }

    const baselineId = rebuild ? (existing?.snapshotId ?? null) : null
    if (rebuild && baselineId) {
      console.log(`\nBaseline snapshot: #${baselineId} (kept for comparison)`)
    }

    console.log(force && existing && !rebuild ? "\nRebuilding..." : "\nExtracting...")
    const ref = await foundation.beginSnapshot({
      workspaceRoot: workspace,
      compileDbHash: "cli-extract",
      parserVersion: "0.1.0",
      ...(rev ? { sourceRevision: rev } : {}),
    } as Parameters<typeof foundation.beginSnapshot>[0])

    const runner = new ExtractorRunner({
      snapshotId: ref.snapshotId,
      workspaceRoot: workspace,
      lsp: stubLsp,
      sink: store,
      plugins: BUILT_IN_EXTRACTORS,
      flushThreshold: 2000,
    })

    const report = await runner.run()
    await foundation.commitSnapshot(ref.snapshotId)

    const elapsed = ((Date.now() - start) / 1000).toFixed(1)
    const n = (
      client.raw.prepare("SELECT COUNT(*) AS n FROM graph_nodes WHERE snapshot_id=?").get(ref.snapshotId) as {
        n: number
      }
    ).n
    const e = (
      client.raw.prepare("SELECT COUNT(*) AS n FROM graph_edges WHERE snapshot_id=?").get(ref.snapshotId) as {
        n: number
      }
    ).n

    console.log(`\nDone in ${elapsed}s (snapshot ${ref.snapshotId})`)
    console.log(`  Nodes: ${n}`)
    console.log(`  Edges: ${e}`)
    for (const p of report.perPlugin) {
      if (p.status === "skipped") continue
      const files = Object.entries(p.metrics?.counters ?? {}).find(([k]) => k.endsWith("files-discovered"))?.[1] ?? 0
      console.log(
        `  ${p.status === "success" ? "+" : "!"} ${p.name} — ${files} files, ${p.factsYielded} facts, ${p.durationMs}ms`,
      )
    }
    if (baselineId) {
      console.log(`\nBaseline: #${baselineId}   New: #${ref.snapshotId}`)
      console.log(`Run: bun run analyze ${workspace} --compare=${baselineId}`)
    } else {
      console.log(`\nReady. File saves will update the graph incrementally.`)
    }
  } finally {
    client.close()
  }
}

main().catch((err) => {
  console.error("Extract failed:", err)
  process.exit(1)
})
