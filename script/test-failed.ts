#!/usr/bin/env bun
/**
 * test-failed — re-run only files that had failures in the last run.
 *
 * Reads .artifacts/unit/test-state.json (written by the state reporter),
 * picks files whose FileRecord.status !== "passed", and spawns
 * `vitest run <those-files>` with any extra args forwarded.
 *
 * Usage:
 *   bun run test:failed                 # re-run every failed/skipped file
 *   bun run test:failed --only-failed   # exclude skipped-only files
 *   bun run test:failed -t "regex"      # additional vitest args pass through
 */

import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"

interface FileRecord {
  status: "passed" | "failed" | "skipped" | "todo"
  numFailed: number
  numSkipped: number
}
interface State {
  version: number
  files: Record<string, FileRecord>
}

const STATE_FILE = path.resolve(process.cwd(), ".artifacts/unit/test-state.json")

function usage(message?: string): never {
  if (message) process.stderr.write(`error: ${message}\n`)
  process.stderr.write(
    [
      "usage: test-failed [--only-failed] [-- <vitest-args>...]",
      "",
      "reads .artifacts/unit/test-state.json and re-runs files with any",
      "failures (or skipped, unless --only-failed). the state file is written",
      "by test/boundary/reporters/state-reporter.ts during every `vitest run`.",
    ].join("\n") + "\n",
  )
  process.exit(2)
}

function loadState(): State {
  if (!fs.existsSync(STATE_FILE)) {
    process.stderr.write(
      `no test state at ${STATE_FILE}\n` +
        "hint:  run \`bun test\` at least once so the state reporter can record results.\n",
    )
    process.exit(3)
  }
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as State
}

function main(): number {
  const argv = process.argv.slice(2)
  if (argv.includes("--help") || argv.includes("-h")) usage()

  const onlyFailed = argv.includes("--only-failed")
  const passthroughArgs = argv.filter((a) => a !== "--only-failed")

  const state = loadState()
  const pick = Object.entries(state.files).filter(([, rec]) => {
    if (rec.status === "passed") return false
    if (onlyFailed && rec.numFailed === 0) return false
    return true
  })

  if (pick.length === 0) {
    process.stdout.write("nothing to re-run — all files passed in the last run.\n")
    return 0
  }

  pick.sort(([a], [b]) => a.localeCompare(b))
  const files = pick.map(([f]) => f)

  process.stdout.write(`re-running ${files.length} file(s):\n`)
  for (const [f, rec] of pick) {
    const marker = rec.numFailed > 0 ? `× ${rec.numFailed}` : rec.numSkipped > 0 ? `~ ${rec.numSkipped}` : "?"
    process.stdout.write(`  ${marker.padEnd(5)} ${f}\n`)
  }
  process.stdout.write("\n")

  const spawned = spawnSync("bunx", ["vitest", "run", ...files, ...passthroughArgs], {
    stdio: "inherit",
    cwd: process.cwd(),
  })
  return spawned.status ?? 1
}

process.exit(main())
