#!/usr/bin/env bun
/**
 * script/generate-tool-cards.ts
 * Generates atomic/tools/<id>.md vault cards for every registered tool id.
 * Run: bun run script/generate-tool-cards.ts
 *
 * Output: $OPENCODE_NOTES_ROOT/atomic/tools/<id>.md (one file per tool)
 * Idempotent: existing cards are overwritten with fresh content.
 */

import fs from "fs"
import path from "path"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import z from "zod"
// Inlined from former src/tool/search/hints.ts — only this script consumes it
// after the search-tool deletion. Kept separate from the tool runtime so the
// minimalist surface (read/write/edit/bash/batch/task/…) stays uncluttered.
const CLAUDE_ALIAS_HINTS: Record<string, string> = {
  AskUserQuestion: "question",
  TaskCreate: "task",
  TaskList: "todo",
  TaskUpdate: "todo",
  TaskOutput: "todo",
  TaskStop: "todo",
  EnterWorktree: "enter_worktree",
  ExitWorktree: "exit_worktree",
}
import { ToolRegistry } from "../src/tool/registry"
import { ProviderID, ModelID } from "../src/provider/schema"
import { Instance } from "../src/config/project/instance"

// ─── Resolve notes root ───────────────────────────────────────────────────────

const NOTES_ROOT = process.env["OPENCODE_NOTES_ROOT"] ?? path.join(process.env["HOME"] ?? "~", "notes")

const TOOLS_DIR = path.join(NOTES_ROOT, "atomic", "tools")
fs.mkdirSync(TOOLS_DIR, { recursive: true })

// ─── Helpers ─────────────────────────────────────────────────────────────────

function aliasesFor(id: string): string[] {
  return Object.entries(CLAUDE_ALIAS_HINTS)
    .filter(([, target]) => target === id)
    .map(([alias]) => alias)
}

function renderCard(tool: {
  id: string
  description: string
  aliases: string[]
  schema: Record<string, unknown>
}): string {
  const aliasList = tool.aliases.length > 0 ? `\n- Claude aliases: ${tool.aliases.join(", ")}` : ""
  const props = (tool.schema as any)?.properties ?? {}
  const required: string[] = (tool.schema as any)?.required ?? []

  // Handle discriminated unions / oneOf / anyOf — flatten all variant properties
  const variants: any[] = (tool.schema as any)?.oneOf ?? (tool.schema as any)?.anyOf ?? []
  const variantProps: Record<string, any> = {}
  for (const v of variants) {
    for (const [k, def] of Object.entries(v?.properties ?? {})) {
      if (!variantProps[k]) variantProps[k] = def
    }
  }
  const allProps = { ...variantProps, ...props }

  const paramLines = Object.entries(allProps).map(([name, def]: [string, any]) => {
    const req = required.includes(name) ? " *(required)*" : " *(optional)*"
    const type = def.type ?? def.anyOf?.map((x: any) => x.type ?? x.const).join(" | ") ?? "any"
    // Sanitize: strip ephemeral tmp paths injected by Instance.directory at generation time
    const rawDesc: string = def.description ?? ""
    const desc = rawDesc ? ` — ${rawDesc.replace(/\/tmp\/[^\s.]+/g, "<workdir>")}` : ""
    const enumVals = def.enum ? ` (one of: ${def.enum.map((v: any) => `\`${v}\``).join(", ")})` : ""
    return `- \`${name}\`${req} \`${type}\`${desc}${enumVals}`
  })

  const paramsSection =
    paramLines.length > 0 ? `## Parameters\n\n${paramLines.join("\n")}` : `## Parameters\n\n*(no parameters)*`

  const exampleArgs = Object.fromEntries(
    Object.entries(allProps)
      .filter(([name]) => required.includes(name))
      .slice(0, 3)
      .map(([name, def]: [string, any]) => [name, def.example ?? def.default ?? `<${name}>`]),
  )
  const exampleJson = JSON.stringify({ tool: tool.id, args: exampleArgs }, null, 2)

  return `---
tags:
  - tool-card
tool_id: ${tool.id}
---

# ${tool.id}

${tool.description}
${aliasList}

${paramsSection}

## When to use

Use the tool directly by its id: \`${tool.id}\` with arguments matching the schema below.

## Examples

\`\`\`json
${exampleJson}
\`\`\`
`
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const tmp = mkdtempSync(path.join(tmpdir(), "tool-cards-"))
  try {
    await Instance.provide({
      directory: tmp,
      fn: async () => {
        const tools = await ToolRegistry.tools({
          providerID: ProviderID.make(""),
          modelID: ModelID.make(""),
        })

        let written = 0
        for (const tool of tools) {
          const parameters = (tool as any).parameters
          // Sanitize: strip ephemeral tmp paths injected by Instance.directory
          const rawDesc: string = (tool as any).description ?? tool.id
          const description = rawDesc.replace(/\/tmp\/[^\s.]+/g, "<workdir>")
          const schema = parameters
            ? (z.toJSONSchema(parameters, { unrepresentable: "any" }) as Record<string, unknown>)
            : {}
          const card = renderCard({
            id: tool.id,
            description,
            aliases: aliasesFor(tool.id),
            schema,
          })

          const outPath = path.join(TOOLS_DIR, `${tool.id}.md`)
          fs.writeFileSync(outPath, card, "utf8")
          written++
          console.log(`  ✓ ${tool.id}`)
        }

        console.log(`\nWrote ${written} tool cards to ${TOOLS_DIR}`)
      },
    })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error("generate-tool-cards failed:", err)
  process.exit(1)
})
