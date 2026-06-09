#!/usr/bin/env bun
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const root = process.cwd()
const roots = ["script", "src"]
const rootFiles = ["package.json"]
const extensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md"])
const ignoredDirs = new Set(["node_modules", ".git", "dist", "build", ".artifacts", "coverage"])
const offenders: string[] = []

function ext(path: string) {
  const index = path.lastIndexOf(".")
  return index >= 0 ? path.slice(index) : ""
}

function scanFile(path: string) {
  if (!extensions.has(ext(path))) return
  const text = readFileSync(path, "utf8")
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    if (lines[index]?.trim() === "undefined") offenders.push(`${relative(root, path)}:${index + 1}`)
  }
}

function walk(dir: string) {
  for (const name of readdirSync(dir)) {
    if (ignoredDirs.has(name)) continue
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      walk(path)
      continue
    }
    if (!stat.isFile()) continue
    scanFile(path)
  }
}

for (const item of roots) walk(join(root, item))
for (const item of rootFiles) scanFile(join(root, item))

if (offenders.length) {
  console.error("[no-standalone-undefined-guard] FAIL: standalone `undefined` lines found")
  for (const item of offenders) console.error(`- ${item}`)
  process.exit(1)
}

console.log("[no-standalone-undefined-guard] PASS")
