#!/usr/bin/env bun

import fs from "fs/promises"
import path from "path"

type ContractStatus = "stable" | "active" | "wip" | "draft" | "trial" | "superseded" | "deprecated"

const ALLOWED_STATUS = new Set<ContractStatus>(["stable", "active", "wip", "draft", "trial", "superseded", "deprecated"])
const REQUIRED_KEYS = ["title", "type", "project", "status", "description"] as const

const notesRoot = process.env.OPENCODE_NOTES_ROOT ?? "/local/mnt/workspace/notes"
const contractDir = path.join(notesRoot, "project/software/opencode/specification/contract")

function parseFrontmatter(md: string): { frontmatter: string; body: string } | null {
  if (!md.startsWith("---\n")) return null
  const idx = md.indexOf("\n---", 4)
  if (idx === -1) return null
  const frontmatter = md.slice(4, idx)
  const body = md.slice(idx + 4)
  return { frontmatter, body }
}

function readKey(frontmatter: string, key: string): string | undefined {
  const m = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))
  if (!m) return undefined
  return m[1]?.trim()
}

async function main() {
  const entries = await fs.readdir(contractDir, { withFileTypes: true })
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => path.join(contractDir, e.name))
    .sort()

  const violations: string[] = []
  for (const file of files) {
    const rel = path.relative(notesRoot, file)
    const text = await fs.readFile(file, "utf8")
    const parsed = parseFrontmatter(text)
    if (!parsed) {
      violations.push(`${rel}: missing/invalid frontmatter`)
      continue
    }

    const { frontmatter, body } = parsed
    for (const key of REQUIRED_KEYS) {
      if (!readKey(frontmatter, key)) violations.push(`${rel}: missing frontmatter key "${key}"`)
    }

    const type = readKey(frontmatter, "type")
    if (type !== "contract" && !rel.endsWith("/_index.md")) {
      violations.push(`${rel}: type must be \"contract\"`)
    }

    const project = readKey(frontmatter, "project")
    if (project !== "opencode") violations.push(`${rel}: project must be \"opencode\"`)

    const status = readKey(frontmatter, "status")
    if (status && !ALLOWED_STATUS.has(status as ContractStatus)) {
      violations.push(`${rel}: status \"${status}\" is not in allowed set`)
    }

    if (status === "superseded") {
      if (!/Superseded/i.test(body)) {
        violations.push(`${rel}: superseded contract must explicitly state superseded in body`)
      }
    }
  }

  if (violations.length > 0) {
    console.error("contract-notes-audit: violations found")
    for (const v of violations) console.error(`- ${v}`)
    process.exit(1)
  }

  console.log(JSON.stringify({ ok: true, contractDir, files: files.length }))
}

await main()
