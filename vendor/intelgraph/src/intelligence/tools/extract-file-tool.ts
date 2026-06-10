/**
 * extract-file-tool.ts
 * IntelGraph tool for incremental per-file extraction.
 *
 * When a user saves a file in their editor, this tool re-extracts just
 * that file: purges stale nodes/edges, parses with tree-sitter, and
 * inserts updated facts. Takes ~100-200ms per file.
 *
 * This is the TS/Rust equivalent of clangd's textDocument/didSave
 * re-indexing — the graph stays current without full rebuilds.
 */

import { z } from "zod"
import { resolve, relative } from "node:path"
import { existsSync } from "node:fs"
import { ExtractorRunner } from "../extraction/runner.js"
import type { IngestDeps } from "./ingest-tool.js"

// ---------------------------------------------------------------------------
// Dep singleton — shared with ingest-tool via setIngestDeps()
// ---------------------------------------------------------------------------

let DEPS: IngestDeps | null = null

export function setExtractFileDeps(deps: IngestDeps | null): void {
  DEPS = deps
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const extractFileInputSchema = z.object({
  filePath: z.string().describe("Absolute path to the file that changed"),
  workspaceRoot: z.string().optional().describe("Workspace root (defaults to cwd)"),
})

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export async function executeExtractFileTool(args: z.infer<typeof extractFileInputSchema>): Promise<string> {
  if (!DEPS) {
    return JSON.stringify({
      status: "error",
      error: "intelligence backend not initialized",
    })
  }

  const workspaceRoot = args.workspaceRoot ?? process.cwd()
  const filePath = resolve(args.filePath)

  if (!existsSync(filePath)) {
    return JSON.stringify({
      status: "error",
      error: `file not found: ${filePath}`,
    })
  }

  const relPath = relative(workspaceRoot, filePath)

  // Find the current ready snapshot
  const snapshot = await DEPS.db.getLatestReadySnapshot(workspaceRoot)
  if (!snapshot) {
    return JSON.stringify({
      status: "error",
      error: "no ready snapshot — run `npm run extract` first",
    })
  }

  const snapshotId = snapshot.snapshotId
  const start = Date.now()

  // Purge stale data for this file (only when the sink supports it).
  let purged = { nodes: 0, edges: 0 }
  if (typeof DEPS.sink.purgeFile === "function") {
    purged = await DEPS.sink.purgeFile(snapshotId, relPath)
  }

  // Re-extract just this file. Use runnerFactory when provided (test injection).
  const runner = DEPS.runnerFactory
    ? DEPS.runnerFactory({ snapshotId, workspaceRoot, sink: DEPS.sink })
    : new ExtractorRunner({
        snapshotId,
        workspaceRoot,
        lsp: DEPS.lsp,
        sink: DEPS.sink,
        plugins: DEPS.plugins,
        flushThreshold: 500,
        fileFilter: new Set([filePath]),
      })

  const report = await runner.run()
  const elapsed = Date.now() - start

  return JSON.stringify({
    status: "ok",
    file: relPath,
    snapshotId,
    purged,
    pluginsRun: report.pluginsRun,
    factsInserted: report.perPlugin.reduce((n, p) => n + p.factsYielded, 0),
    durationMs: elapsed,
  })
}
