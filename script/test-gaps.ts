#!/usr/bin/env bun
/**
 * test-gaps — testing-infra gap dashboard.
 *
 * Surfaces:
 *   1. Skipped tests    — test.skip / it.skip / describe.skip across the repo
 *   2. Todo tests       — test.todo / it.todo
 *   3. Flaky candidates — tests with failureStreak >= 2 in test-state.json
 *   4. Slowest 10       — tests and files by durationMs
 *   5. Orphan src files — src/*.ts with no sibling *.test.ts
 *   6. Coverage summary — from .artifacts/unit/coverage/coverage-summary.json
 *
 * Read-only. Prints to stdout. Exit code 0 regardless of findings (it's a
 * report, not a gate). Pipe to a file or grep for specific sections.
 *
 * Usage: bun run test:gaps
 */

import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"

interface TestRecord {
  status: string
  durationMs: number
  failureStreak: number
  file: string
  name: string
}
interface FileRecord {
  status: string
  durationMs: number
  numTests: number
  numFailed: number
  numSkipped: number
}
interface State {
  tests: Record<string, TestRecord>
  files: Record<string, FileRecord>
}

const STATE_FILE = path.resolve(process.cwd(), ".artifacts/unit/test-state.json")
const COVERAGE_SUMMARY = path.resolve(process.cwd(), ".artifacts/unit/coverage/coverage-summary.json")

function h(title: string): void {
  process.stdout.write(`\n── ${title} ${"─".repeat(Math.max(3, 60 - title.length))}\n`)
}

function loadStateMaybe(): State | null {
  if (!fs.existsSync(STATE_FILE)) return null
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as State
  } catch {
    return null
  }
}

function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`
  return `${Math.round(ms)}ms`
}

// ── 1-2. Skipped + todo via ripgrep (fast, no AST needed) ──────────────────

function grep(pattern: string, globs: string[]): string[] {
  // rg needs an explicit positional path when spawned without a TTY — the
  // `-g` filter alone doesn't supply one and rg silently exits with no hits.
  const args = ["-n", "--no-heading", "--color=never", pattern, ...globs.flatMap((g) => ["-g", g]), "."]
  const out = spawnSync("rg", args, { encoding: "utf8" })
  if (out.status !== 0 && out.status !== 1) return []
  return out.stdout.split("\n").filter(Boolean)
}

function sectionSkippedTodo(): void {
  const globs = ["*.test.ts"]
  const skipLines = grep("(test|it|describe)\\.skip\\b", globs)
  const todoLines = grep("(test|it)\\.todo\\b", globs)

  h(`Skipped tests (${skipLines.length} hits)`)
  if (skipLines.length === 0) process.stdout.write("  (none)\n")
  for (const l of skipLines.slice(0, 50)) process.stdout.write(`  ${l}\n`)
  if (skipLines.length > 50) process.stdout.write(`  … ${skipLines.length - 50} more\n`)

  h(`Todo tests (${todoLines.length} hits)`)
  if (todoLines.length === 0) process.stdout.write("  (none)\n")
  for (const l of todoLines) process.stdout.write(`  ${l}\n`)
}

// ── 3. Flaky candidates ─────────────────────────────────────────────────────

function sectionFlaky(state: State | null): void {
  h("Flaky candidates (failureStreak ≥ 2)")
  if (!state) {
    process.stdout.write("  (no test-state.json yet — run `bun test` first)\n")
    return
  }
  const flaky = Object.values(state.tests)
    .filter((t) => t.failureStreak >= 2)
    .sort((a, b) => b.failureStreak - a.failureStreak)
    .slice(0, 50)
  if (flaky.length === 0) process.stdout.write("  (none)\n")
  for (const t of flaky) {
    process.stdout.write(`  streak=${t.failureStreak}  ${t.file} :: ${t.name}\n`)
  }
}

// ── 4. Slowest tests/files ─────────────────────────────────────────────────

function sectionSlow(state: State | null): void {
  h("Slowest tests (top 10)")
  if (!state) {
    process.stdout.write("  (no test-state.json yet — run `bun test` first)\n")
    return
  }
  const slowT = Object.values(state.tests)
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 10)
  for (const t of slowT) {
    process.stdout.write(`  ${formatMs(t.durationMs).padStart(8)}  ${t.file} :: ${t.name}\n`)
  }

  h("Slowest files (top 10)")
  const slowF = Object.entries(state.files)
    .map(([file, rec]) => ({ file, ...rec }))
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 10)
  for (const f of slowF) {
    process.stdout.write(`  ${formatMs(f.durationMs).padStart(8)}  ${f.file}  (${f.numTests} tests)\n`)
  }
}

// ── 5. Orphan src files ─────────────────────────────────────────────────────

function listSrcFiles(): string[] {
  const out = spawnSync(
    "rg",
    ["--files", "-g", "*.ts", "-g", "!*.test.ts", "-g", "!*.d.ts", "src"],
    { encoding: "utf8" },
  )
  return out.stdout.split("\n").filter(Boolean)
}

function hasSiblingTest(file: string): boolean {
  // Three coverage lookups (any hit = not orphan):
  //   (a) <dir>/<base>.test.ts                sibling file
  //   (b) <dir>/*.test.ts                     sibling dir has a test named like base
  //   (c) test/<mirror of src-path>.test.ts   mirrored-path test
  //   (d) test/*/<base>.test.ts              topic-bucketed test anywhere under test/
  const dir = path.dirname(file)
  const base = path.basename(file, ".ts")

  const direct = path.join(dir, `${base}.test.ts`)
  if (fs.existsSync(direct)) return true

  try {
    const siblings = fs.readdirSync(dir)
    if (siblings.some((e) => e.endsWith(".test.ts") && e.startsWith(base))) return true
  } catch {
    /* unreadable — fall through */
  }

  // Mirrored path: src/foo/bar.ts → test/foo/bar.test.ts
  const rel = path.relative("src", file).replace(/\.ts$/, ".test.ts")
  if (fs.existsSync(path.join("test", rel))) return true

  // Topic-bucketed: src/foo/bar.ts → test/<anything>/bar.test.ts
  const found = spawnSync("rg", ["--files", "-g", `${base}.test.ts`, "test"], { encoding: "utf8" })
  if (found.status === 0 && found.stdout.trim().length > 0) return true

  return false
}

const ORPHAN_IGNORE = [
  /\/index\.ts$/,
  /\/types\.ts$/,
  /\/schema\.ts$/,
  /\/constants?\.ts$/,
  /\.sql\.ts$/,
  /\/cli\/cmd\//, // commands are integration-tested, not unit-tested
  /\/shims?\//,
]

function sectionOrphans(): void {
  h("Orphan src files (no sibling *.test.ts)")
  const files = listSrcFiles().filter((f) => !ORPHAN_IGNORE.some((rx) => rx.test(f)))
  const orphans = files.filter((f) => !hasSiblingTest(f)).sort()
  process.stdout.write(`  ${orphans.length} orphan file(s) out of ${files.length} scanned\n`)
  for (const o of orphans.slice(0, 50)) process.stdout.write(`  ${o}\n`)
  if (orphans.length > 50) process.stdout.write(`  … ${orphans.length - 50} more\n`)
}

// ── 6. Coverage summary ─────────────────────────────────────────────────────

function sectionCoverage(): void {
  h("Coverage summary")
  if (!fs.existsSync(COVERAGE_SUMMARY)) {
    process.stdout.write("  (no coverage summary — run `bun test:coverage` first)\n")
    return
  }
  try {
    const raw = JSON.parse(fs.readFileSync(COVERAGE_SUMMARY, "utf8")) as {
      total: { lines: { pct: number }; functions: { pct: number }; branches: { pct: number }; statements: { pct: number } }
    }
    const t = raw.total
    process.stdout.write(
      `  lines:      ${t.lines.pct.toFixed(2)}%\n` +
        `  functions:  ${t.functions.pct.toFixed(2)}%\n` +
        `  branches:   ${t.branches.pct.toFixed(2)}%\n` +
        `  statements: ${t.statements.pct.toFixed(2)}%\n`,
    )
  } catch (e) {
    process.stdout.write(`  (parse failed: ${e instanceof Error ? e.message : String(e)})\n`)
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

function main(): number {
  process.stdout.write(`\n═══ Test Gap Report — ${new Date().toISOString()} ═══\n`)
  const state = loadStateMaybe()
  sectionSkippedTodo()
  sectionFlaky(state)
  sectionSlow(state)
  sectionOrphans()
  sectionCoverage()
  process.stdout.write("\n")
  return 0
}

process.exit(main())
