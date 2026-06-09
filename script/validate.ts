#!/usr/bin/env bun
import { resolve } from "node:path"

type Stage = {
  label: string
  command: string[]
}

const REPO_ROOT = resolve(import.meta.dir, "..")

const STAGES: Stage[] = [
  { label: "no-standalone-undefined", command: ["bun", "run", "test:no-standalone-undefined"] },
  { label: "dep-check", command: ["bun", "run", "dep-check"] },
  { label: "lint", command: ["bun", "run", "lint"] },
  { label: "typecheck", command: ["bun", "run", "typecheck"] },
  { label: "contract-guard", command: ["bun", "run", "test:contract-guard"] },
]

let failures = 0
for (const stage of STAGES) {
  console.log(`\n[validate] START ${stage.label}`)
  const result = Bun.spawnSync(stage.command, {
    cwd: REPO_ROOT,
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  })
  const exitCode = result.exitCode ?? (result.success ? 0 : 1)
  const ok = exitCode === 0
  console.log(`[validate] ${ok ? "PASS" : "FAIL"} ${stage.label} (exit ${exitCode})`)
  if (!ok) failures += 1
}

if (failures > 0) {
  console.error(`\n[validate] FAIL summary ${STAGES.length - failures}/${STAGES.length} stages passed`)
  process.exit(1)
}

console.log(`\n[validate] PASS summary ${STAGES.length}/${STAGES.length} stages passed`)
