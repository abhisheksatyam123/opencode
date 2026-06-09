#!/usr/bin/env bun
/**
 * contract-guard — enforce contract-centric test strategy.
 *
 * Single source of truth for every testable behaviour is its contract spec under
 *   project/software/opencode/specification/contract/
 * (vault path = $OPENCODE_NOTES_ROOT or ~/notes by default).
 *
 * Checks (hard-fail):
 *   1. Every *.contract.test.ts must cite a contract note path in its header
 *      (comment within first 20 lines matching /specification\/contract\/[a-z0-9-]+/).
 *   2. If the current commit/staged change touches a specification/contract/*.md,
 *      at least one *.contract.test.ts file matching the same slug must also be
 *      staged/modified in the same commit. Mode controlled by --mode:
 *        --mode=staged  (pre-commit, default)
 *        --mode=range HEAD~1..HEAD  (PR/CI — diff across range)
 *   3. No legacy dual file pairs: `<name>.test.ts` + `<name>.contract.test.ts` in
 *      the same dir. Presence of both = hard fail. Migrate → delete the legacy.
 *   4. [removed] legacy `*-effect.test.ts` pairing rule retired after vitest
 *      migration (`it.effect` handles Effect-specific behavior).
 *   5. No `from "bun:test"` imports remain in `test/` or `src/`.
 *
 * Exit codes:
 *   0  — all checks pass
 *   1  — violations found; prints a structured report
 *
 * Invoke:
 *   bun run test:contract-guard                 # staged mode (pre-commit)
 *   bun run test:contract-guard --mode=range A..B
 *   bun run test:contract-guard --mode=all      # scan entire tree, no git
 *
 * Spec:
 *   project/software/opencode/decision/adr-contract-based-test-strategy
 *   atomic/pattern/contract-based-test-stratification
 */
import { execSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { resolve, basename, dirname } from "node:path"
import { readdir, stat } from "node:fs/promises"

const PKG_ROOT = resolve(import.meta.dir, "..")
const REPO_ROOT = PKG_ROOT
const VAULT_ROOT = process.env["OPENCODE_NOTES_ROOT"] ?? resolve(process.env["HOME"] ?? "", "notes")
const SPEC_DIR_ABS = resolve(VAULT_ROOT, "doc/project/software/opencode/specification/contract")
const SPEC_DIR_REL = "project/software/opencode/specification/contract"

type Mode = "staged" | "range" | "all"
const args = process.argv.slice(2)
let mode: Mode = "staged"
let range = ""
for (let i = 0; i < args.length; i++) {
  if (args[i]?.startsWith("--mode=")) mode = args[i]!.split("=")[1] as Mode
  else if (!range && args[i] && !args[i]!.startsWith("--")) range = args[i]!
}

type Violation = { rule: string; file: string; msg: string }
const violations: Violation[] = []
function fail(rule: string, file: string, msg: string) {
  violations.push({ rule, file, msg })
}

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  let entries: string[] = []
  try {
    entries = await readdir(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    if (name === "node_modules" || name === ".git" || name === "dist" || name === "build") continue
    const p = resolve(dir, name)
    const s = await stat(p).catch(() => null)
    if (!s) continue
    if (s.isDirectory()) await walk(p, out)
    else if (s.isFile()) out.push(p)
  }
  return out
}

function gitFiles(): string[] {
  try {
    if (mode === "staged") {
      return execSync("git diff --cached --name-only --diff-filter=ACMR", { cwd: REPO_ROOT })
        .toString()
        .split("\n")
        .filter(Boolean)
    }
    if (mode === "range") {
      if (!range) throw new Error("--mode=range requires a git range, e.g. HEAD~1..HEAD")
      return execSync(`git diff --name-only --diff-filter=ACMR ${range}`, { cwd: REPO_ROOT })
        .toString()
        .split("\n")
        .filter(Boolean)
    }
    return []
  } catch (e) {
    console.error("git query failed:", e)
    return []
  }
}

// ---------- Rule 1 + 3 : scan all test files in pkg ----------
const pkgTestDir = resolve(PKG_ROOT, "test")
const allFiles = await walk(pkgTestDir)
const testFiles = allFiles.filter((p) => p.endsWith(".test.ts"))
const contractTests = testFiles.filter((p) => p.endsWith(".contract.test.ts"))
const regularTests = testFiles.filter((p) => !p.endsWith(".contract.test.ts") && !p.endsWith(".regression.test.ts"))

// Rule 1: every *.contract.test.ts cites a contract note path
for (const f of contractTests) {
  const head = readFileSync(f, "utf8").split("\n").slice(0, 25).join("\n")
  if (!/specification\/contract\/[a-z0-9-]+/i.test(head)) {
    fail(
      "R1.no-citation",
      f,
      `*.contract.test.ts must cite a contract spec path in the first 25 lines (match /specification\\/contract\\/<slug>/).`,
    )
  }
}

// Rule 3: no dual <name>.test.ts + <name>.contract.test.ts in same directory
const byBase = new Map<string, { legacy?: string; contract?: string }>()
function key(p: string) {
  const dir = dirname(p)
  const b = basename(p).replace(/\.contract\.test\.ts$|-effect\.test\.ts$|\.test\.ts$/, "")
  return `${dir}::${b}`
}
for (const p of regularTests) {
  const k = key(p)
  const v = byBase.get(k) ?? {}
  v.legacy = p
  byBase.set(k, v)
}
for (const p of contractTests) {
  const k = key(p)
  const v = byBase.get(k) ?? {}
  v.contract = p
  byBase.set(k, v)
}
for (const [, v] of byBase) {
  if (v.legacy && v.contract) {
    fail("R3.dual-legacy+contract", v.legacy, `Legacy .test.ts co-exists with ${basename(v.contract)}. Delete legacy.`)
  }
}

// ---------- Rule 5 : no bun:test imports ----------
// Keep Rule 1/3 source (`allFiles`) scoped to test/, and explicitly extend
// R5 by walking src/ separately so future scope additions are composable.
// Vendored subtrees can carry their own test harnesses (`bun:test` allowed there).
const pkgSrcDir = resolve(PKG_ROOT, "src")
const srcFiles = await walk(pkgSrcDir)
const R5_EXCLUDE_REL_PREFIXES = ["src/surface/web/official/"]
const bunTestPattern = /from\s+["']bun:test["']/
const bunImportScanFiles = [...new Set([...allFiles, ...srcFiles])]
  .filter((p) => p.endsWith(".ts") && !p.endsWith(".d.ts"))
  .filter((p) => {
    const rel = p.replace(REPO_ROOT + "/", "")
    return !R5_EXCLUDE_REL_PREFIXES.some((prefix) => rel.startsWith(prefix))
  })
for (const f of bunImportScanFiles) {
  const text = readFileSync(f, "utf8")
  if (bunTestPattern.test(text)) {
    fail("R5.no-bun-test-import", f, `bun:test import is forbidden after vitest migration. Use 'vitest'.`)
  }
}

// ---------- Rule 2 : spec↔test co-change (staged/range mode only) ----------
if (mode !== "all") {
  const changed = gitFiles()
  const changedSpecs = changed.filter((p) => p.includes(`${SPEC_DIR_REL}/`) && p.endsWith(".md"))
  const changedTests = changed.filter((p) => p.startsWith("test/") && p.endsWith(".contract.test.ts"))
  const citedSlugs = new Set<string>()
  for (const t of changedTests) {
    const abs = resolve(REPO_ROOT, t)
    if (!existsSync(abs)) continue
    const head = readFileSync(abs, "utf8").split("\n").slice(0, 25).join("\n")
    const m = head.match(/specification\/contract\/([a-z0-9-]+)/gi)
    if (m) for (const hit of m) citedSlugs.add(hit.split("/").pop()!)
  }
  for (const spec of changedSpecs) {
    const slug = basename(spec, ".md")
    if (!citedSlugs.has(slug)) {
      fail(
        "R2.spec-without-test",
        spec,
        `Contract spec '${slug}' changed but no *.contract.test.ts citing this slug is staged. Update tests in the same commit.`,
      )
    }
  }
}

// ---------- Report ----------
if (violations.length === 0) {
  console.log(JSON.stringify({ ok: true, mode, contractTests: contractTests.length }))
  process.exit(0)
}
console.error("contract-guard: violations found")
for (const v of violations) {
  console.error(`  [${v.rule}] ${v.file.replace(REPO_ROOT + "/", "")}`)
  console.error(`           ${v.msg}`)
}
console.error("")
console.error("Fix rules (see project/software/opencode/decision/adr-contract-based-test-strategy):")
console.error("  R1 — cite `specification/contract/<slug>` in first 25 lines of *.contract.test.ts")
console.error("  R2 — when a contract spec changes, stage the matching *.contract.test.ts in the same commit")
console.error("  R3 — delete legacy *.test.ts once *.contract.test.ts lands")
console.error('  R5 — remove all `from "bun:test"` imports (use `vitest`)')
process.exit(1)
// keep SPEC_DIR_ABS referenced so tsc/bun don't drop it on unused-var lint
void SPEC_DIR_ABS
