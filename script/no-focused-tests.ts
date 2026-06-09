#!/usr/bin/env bun
import { $ } from "bun"

const allowed = new Set(["test/boundary/lib/effect.ts"])
const files = (await $`git ls-files "test/**/*.ts" "test/**/*.tsx"`.text())
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)

const focusedPattern = /\b(?:describe|test|it)\.only\b|\.only\s*\(/g
const violations: string[] = []

for (const file of files) {
  const text = await Bun.file(file).text()
  const lines = text.split(/\r?\n/)
  for (const [index, line] of lines.entries()) {
    focusedPattern.lastIndex = 0
    if (!focusedPattern.test(line)) continue
    if (allowed.has(file)) continue
    violations.push(`${file}:${index + 1}: ${line.trim()}`)
  }
}

if (violations.length > 0) {
  console.error("Focused tests are not allowed. Remove .only markers:")
  for (const item of violations) console.error(`  ${item}`)
  process.exit(1)
}

console.log(`no focused tests (${files.length} files scanned)`)
