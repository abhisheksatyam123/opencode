#!/usr/bin/env bun
/**
 * test-slow — rank tests and files by duration from the last run.
 *
 * Reads .artifacts/unit/test-state.json. Default mode prints the slowest
 * 20 tests and slowest 10 files. `--files`/`--tests` restricts scope,
 * `--top N` changes the count, `--threshold MS` filters by minimum duration.
 *
 * Usage:
 *   bun run test:slow                         # default: top 20 tests + top 10 files
 *   bun run test:slow --top 50
 *   bun run test:slow --files --top 5
 *   bun run test:slow --threshold 1000        # only ≥1s
 */

import fs from "node:fs"
import path from "node:path"

interface TestRecord {
  status: string
  durationMs: number
  file: string
  name: string
}
interface FileRecord {
  status: string
  durationMs: number
  numTests: number
  numFailed: number
}
interface State {
  tests: Record<string, TestRecord>
  files: Record<string, FileRecord>
}

const STATE_FILE = path.resolve(process.cwd(), ".artifacts/unit/test-state.json")

type Scope = "both" | "files" | "tests"
interface Args {
  top: number
  threshold: number
  scope: Scope
}

const usage = [
  "usage: test-slow [--top N] [--threshold MS] [--files|--tests]",
  "",
  "reads .artifacts/unit/test-state.json and prints duration rankings.",
].join("\n")

const argHandlers: Record<string, (args: Args, argv: string[], index: number) => number> = {
  "--top": (args, argv, index) => {
    args.top = Number(argv[index + 1])
    return index + 1
  },
  "--threshold": (args, argv, index) => {
    args.threshold = Number(argv[index + 1])
    return index + 1
  },
  "--files": (args, _argv, index) => {
    args.scope = "files"
    return index
  },
  "--tests": (args, _argv, index) => {
    args.scope = "tests"
    return index
  },
  "--help": () => {
    process.stderr.write(`${usage}\n`)
    process.exit(2)
  },
  "-h": () => {
    process.stderr.write(`${usage}\n`)
    process.exit(2)
  },
}

function parseArgs(argv: string[]): Args {
  const args: Args = { top: 20, threshold: 0, scope: "both" }
  for (let i = 0; i < argv.length; i++) {
    const handler = argHandlers[argv[i]]
    if (handler) i = handler(args, argv, i)
  }
  return args
}

function loadState(): State {
  if (!fs.existsSync(STATE_FILE)) {
    process.stderr.write(`no test state at ${STATE_FILE} — run \`bun test\` first.\n`)
    process.exit(3)
  }
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as State
}

function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`
  return `${Math.round(ms)}ms`
}

function topByDuration<T extends { durationMs: number }>(items: T[], top: number, threshold: number): T[] {
  return items
    .filter((item) => item.durationMs >= threshold)
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, top)
}

function printHeading(label: string, count: number, threshold: number): void {
  process.stdout.write(`\n── Slowest ${label} (top ${count}${threshold ? `, ≥${threshold}ms` : ""}) ──\n`)
}

function printTests(state: State, top: number, threshold: number): void {
  const rows = topByDuration(Object.values(state.tests), top, threshold)
  printHeading("tests", rows.length, threshold)
  for (const t of rows) {
    const dur = formatMs(t.durationMs).padStart(8)
    process.stdout.write(`  ${dur}  ${t.status === "failed" ? "× " : "  "}${t.file} :: ${t.name}\n`)
  }
}

function printFiles(state: State, top: number, threshold: number): void {
  const rows = topByDuration(
    Object.entries(state.files).map(([file, rec]) => ({ file, ...rec })),
    top,
    threshold,
  )
  printHeading("files", rows.length, threshold)
  for (const f of rows) {
    const dur = formatMs(f.durationMs).padStart(8)
    const fail = f.numFailed > 0 ? `× ${f.numFailed}` : "    "
    process.stdout.write(`  ${dur}  ${fail.padEnd(4)}  ${f.file}  (${f.numTests} tests)\n`)
  }
}

function main(): number {
  const { top, threshold, scope } = parseArgs(process.argv.slice(2))
  const state = loadState()
  if (scope === "tests" || scope === "both") printTests(state, top, threshold)
  if (scope === "files" || scope === "both") printFiles(state, scope === "files" ? top : Math.min(10, top), threshold)
  process.stdout.write("\n")
  return 0
}

process.exit(main())
