#!/usr/bin/env node
/**
 * extract-file — re-extract a single file incrementally.
 *
 * Called by nvim BufWritePost autocmd on file save. Purges stale graph
 * data for the file and re-extracts it. Typically ~100-200ms.
 *
 * Usage:
 *   npx tsx src/bin/extract-file.ts <file-path> [--workspace-root <path>]
 */

import { resolve, relative, dirname } from "node:path"
import { existsSync } from "node:fs"
import { createSqliteStore } from "../intelligence/db/sqlite/factory.js"
import { ExtractorRunner } from "../intelligence/extraction/runner.js"
import { BUILT_IN_EXTRACTORS } from "../plugins/index.js"
import type { ILanguageClient } from "../lsp/ports.js"

const args = process.argv.slice(2)
let filePath = ""
let workspaceRoot = ""

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--workspace-root" && args[i + 1]) {
    workspaceRoot = resolve(args[++i]!)
  } else if (!args[i]!.startsWith("-")) {
    filePath = resolve(args[i]!)
  }
}

if (!filePath || !existsSync(filePath)) {
  process.exit(1)
}

if (!workspaceRoot) {
  // Walk up to find .intelgraph/ directory
  let dir = dirname(filePath)
  while (dir !== dirname(dir)) {
    if (existsSync(`${dir}/.intelgraph/intelligence.db`)) {
      workspaceRoot = dir
      break
    }
    dir = dirname(dir)
  }
  if (!workspaceRoot) process.exit(1)
}

const dbPath = `${workspaceRoot}/.intelgraph/intelligence.db`
if (!existsSync(dbPath)) process.exit(1)

const stubLsp = {
  root: workspaceRoot,
  openFile: async () => false,
  documentSymbol: async () => [],
  outgoingCalls: async () => [],
  incomingCalls: async () => [],
  references: async () => [],
  definition: async () => [],
} as unknown as ILanguageClient

async function main() {
  const { client, foundation, sink: store } = createSqliteStore({ path: dbPath })
  try {

    const snapshot = await foundation.getLatestReadySnapshot(workspaceRoot)
    if (!snapshot) process.exit(0) // no snapshot yet — skip silently

    const relPath = relative(workspaceRoot, filePath)

    // Purge stale data
    await store.purgeFile(snapshot.snapshotId, relPath)

    // Re-extract just this file
    const runner = new ExtractorRunner({
      snapshotId: snapshot.snapshotId,
      workspaceRoot,
      lsp: stubLsp,
      sink: store,
      plugins: BUILT_IN_EXTRACTORS,
      flushThreshold: 500,
      fileFilter: new Set([filePath]),
    })
    await runner.run()
  } finally {
    client.close()
  }
}

main().catch(() => process.exit(1))
