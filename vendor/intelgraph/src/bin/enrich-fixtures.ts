#!/usr/bin/env node

/**
 * CLI tool for enriching WLAN API fixtures with exhaustive relation data.
 *
 * Usage:
 *   npm run enrich:fixtures [--api=<name>] [--snapshot-id=<id>] [--dry-run]
 *
 * Examples:
 *   npm run enrich:fixtures                          # Enrich all 60 APIs
 *   npm run enrich:fixtures --api=arp_offload_proc_frame  # Enrich single API
 *   npm run enrich:fixtures --snapshot-id=42         # Enrich all with specific snapshot
 *   npm run enrich:fixtures --dry-run                 # Simulate without writing
 */

import fs from "fs/promises"
import path from "path"
import { enrichApiFixture } from "../fixtures/exhaustive-relation-scanner"
import type { ApiFixture } from "../fixtures/intent-mapper"

interface CliArgs {
  api?: string
  snapshotId: number
  dryRun: boolean
}

/**
 * Parse command-line arguments.
 */
function parseArgs(): CliArgs {
  const args: CliArgs = {
    snapshotId: 1,
    dryRun: false,
  }

  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--api=")) {
      args.api = arg.slice(6)
    } else if (arg.startsWith("--snapshot-id=")) {
      args.snapshotId = Number(arg.slice(14))
    } else if (arg === "--dry-run") {
      args.dryRun = true
    } else if (arg === "--help" || arg === "-h") {
      printUsage()
      process.exit(0)
    }
  }

  return args
}

/**
 * Print usage information.
 */
function printUsage(): void {
  console.log(`
Enrich WLAN API fixtures with exhaustive relation data.

Usage:
  npm run enrich:fixtures [--api=<name>] [--snapshot-id=<id>] [--dry-run]

Options:
  --api=<name>           Enrich a single API fixture by name (e.g. arp_offload_proc_frame)
  --snapshot-id=<id>     Backend snapshot ID to query (default: 1)
  --dry-run              Simulate enrichment without writing to disk
  --help, -h            Show this help message

Examples:
  npm run enrich:fixtures                           # Enrich all 60 APIs
  npm run enrich:fixtures --api=arp_offload_proc_frame  # Single API
  npm run enrich:fixtures --snapshot-id=42         # All with snapshot 42
  npm run enrich:fixtures --dry-run                 # Dry-run simulation
`)
}

/**
 * Load existing fixture from disk.
 */
async function loadFixture(apiName: string): Promise<ApiFixture> {
  const fixturePath = path.join(process.cwd(), "test/fixtures/c/wlan/api", `${apiName}.json`)
  const content = await fs.readFile(fixturePath, "utf-8")
  return JSON.parse(content)
}

/**
 * Save fixture to disk (unless --dry-run).
 */
async function saveFixture(apiName: string, fixture: ApiFixture, dryRun: boolean): Promise<void> {
  const fixturePath = path.join(process.cwd(), "test/fixtures/c/wlan/api", `${apiName}.json`)

  if (dryRun) {
    console.log(`  [DRY-RUN] Would write ${fixturePath}`)
    return
  }

  const content = JSON.stringify(fixture, null, 2)
  await fs.writeFile(fixturePath, content, "utf-8")
}

/**
 * Enrich a single API and report progress.
 */
async function enrichSingleApi(apiName: string, snapshotId: number, dryRun: boolean): Promise<void> {
  console.log(`\nEnriching ${apiName}...`)

  try {
    const existingFixture = await loadFixture(apiName)
    const beforeRelationCount = Object.values(existingFixture.relations).reduce(
      (sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0),
      0,
    )

    const enrichedFixture = await enrichApiFixture(apiName, snapshotId)
    const afterRelationCount = Object.values(enrichedFixture.relations).reduce(
      (sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0),
      0,
    )

    const metadata = enrichedFixture.enrichment_metadata
    if (metadata) {
      const hitCount = metadata.intents_hit.length
      const totalCount = metadata.intents_queried.length
      const newRelations = afterRelationCount - beforeRelationCount

      console.log(`  [intents: ${hitCount}/${totalCount} hit, +${newRelations} new relations]`)

      if (metadata.intents_hit.length > 0) {
        console.log(`    Hit: ${metadata.intents_hit.join(", ")}`)
      }
    } else {
      console.log(`  [no enrichment metadata]`)
    }

    // Backup original if writing (not dry-run)
    if (!dryRun) {
      const backupPath = path.join(
        process.cwd(),
        "test/fixtures/c/wlan/api",
        `${apiName}.json.pre-enrich`,
      )
      await fs.writeFile(backupPath, JSON.stringify(existingFixture, null, 2), "utf-8")
    }

    await saveFixture(apiName, enrichedFixture, dryRun)
  } catch (err) {
    console.error(`  ✗ Error: ${err}`)
    throw err
  }
}

/**
 * Enrich all APIs in batch with progress reporting.
 */
async function enrichAllApisBatch(snapshotId: number, dryRun: boolean): Promise<void> {
  console.log(`\nEnriching all API fixtures (snapshot ${snapshotId})...`)

  const fixturesDir = path.join(process.cwd(), "test/fixtures/c/wlan/api")
  const files = await fs.readdir(fixturesDir)
  const apiNames = files
    .filter((f) => f.endsWith(".json") && !f.endsWith(".pre-enrich"))
    .map((f) => f.replace(".json", ""))
    .sort()

  console.log(`Found ${apiNames.length} API fixtures to process.`)

  let successCount = 0
  let failureCount = 0
  let totalRelationsAdded = 0
  const failedApis: Array<{ api: string; error: string }> = []

  for (let i = 0; i < apiNames.length; i++) {
    const apiName = apiNames[i]
    const progress = `[${i + 1}/${apiNames.length}]`

    try {
      const existingFixture = await loadFixture(apiName)
      const beforeRelationCount = Object.values(existingFixture.relations).reduce(
        (sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0),
        0,
      )

      const enrichedFixture = await enrichApiFixture(apiName, snapshotId)
      const afterRelationCount = Object.values(enrichedFixture.relations).reduce(
        (sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0),
        0,
      )

      const newRelations = afterRelationCount - beforeRelationCount
      totalRelationsAdded += newRelations

      const metadata = enrichedFixture.enrichment_metadata
      if (metadata) {
        const hitCount = metadata.intents_hit.length
        const totalCount = metadata.intents_queried.length

        console.log(
          `${progress} ${apiName.padEnd(35)} [intents: ${hitCount}/${totalCount} hit, +${newRelations} new relations]`,
        )
      } else {
        console.log(`${progress} ${apiName.padEnd(35)} [no metadata]`)
      }

      // Backup original if writing (not dry-run)
      if (!dryRun) {
        const backupPath = path.join(
          process.cwd(),
          "test/fixtures/c/wlan/api",
          `${apiName}.json.pre-enrich`,
        )
        try {
          await fs.stat(backupPath)
          // Backup already exists, skip
        } catch {
          await fs.writeFile(backupPath, JSON.stringify(existingFixture, null, 2), "utf-8")
        }
      }

      await saveFixture(apiName, enrichedFixture, dryRun)
      successCount++
    } catch (err) {
      console.log(`${progress} ${apiName.padEnd(35)} ✗ ${String(err).slice(0, 50)}...`)
      failureCount++
      failedApis.push({
        api: apiName,
        error: String(err),
      })
    }
  }

  // Summary report
  console.log("\n" + "=".repeat(80))
  console.log("Enrichment Summary:")
  console.log(`  Total APIs: ${apiNames.length}`)
  console.log(`  Successful: ${successCount}`)
  console.log(`  Failed: ${failureCount}`)
  console.log(`  Success rate: ${((successCount / apiNames.length) * 100).toFixed(1)}%`)
  console.log(`  Total relations added: ${totalRelationsAdded}`)

  if (dryRun) {
    console.log("  Mode: DRY-RUN (no files written)")
  } else {
    console.log("  Backups: .pre-enrich files created")
  }

  if (failedApis.length > 0) {
    console.log("\nFailed APIs:")
    for (const failed of failedApis) {
      console.log(`  - ${failed.api}: ${failed.error.slice(0, 60)}`)
    }
  }

  console.log("=".repeat(80))
}

/**
 * Main entry point.
 */
async function main(): Promise<void> {
  const args = parseArgs()

  try {
    if (args.api) {
      // Single API enrichment
      await enrichSingleApi(args.api, args.snapshotId, args.dryRun)
      console.log("\n✓ Single API enrichment complete")
    } else {
      // Batch enrichment
      await enrichAllApisBatch(args.snapshotId, args.dryRun)
    }
  } catch (err) {
    console.error(`\n✗ Enrichment failed: ${err}`)
    process.exit(1)
  }
}

main()
