#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { AgentPromptLoader } from "@/agent/prompt-loader"
import { AgentPromptSource } from "@/agent/prompt-source"

const agentDir = AgentPromptSource.root()
const failures: string[] = []

function fail(message: string) {
  failures.push(message)
}

function read(path: string) {
  return readFileSync(path, "utf8")
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) out.push(...walk(path))
    else if (stat.isFile() && path.endsWith(".md")) out.push(path)
  }
  return out.sort()
}

function frontmatter(text: string): Record<string, string> {
  if (!text.startsWith("---\n")) return {}
  const end = text.indexOf("\n---", 4)
  if (end < 0) return {}
  const out: Record<string, string> = {}
  for (const line of text.slice(4, end).split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (match) out[match[1]!] = match[2]!.trim()
  }
  return out
}

function listValue(raw: string | undefined): string[] {
  if (!raw) return []
  const trimmed = raw.trim()
  if (trimmed === "[]") return []
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [trimmed]
  return trimmed
    .slice(1, -1)
    .split(",")
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean)
}

function includesShared(meta: Record<string, string>, include: string): boolean {
  return listValue(meta.shared_includes).includes(include)
}

function h1Headings(markdown: string): string[] {
  const headings: string[] = []
  let inFence = false
  for (const line of markdown.split(/\r?\n/)) {
    if (/^```/.test(line.trimStart())) inFence = !inFence
    if (inFence) continue
    if (/^#\s+\S/.test(line)) headings.push(line.trim())
  }
  return headings
}

const composedPromptSentinels = [
  "Canonical top-level sections for task notes: `## Tasks` and `## Systems` only.",
  "Canonical contract: [[project/software/opencode/specification/contract/todo-agent-protocol]].",
  "/local/mnt/workspace/notes/",
  "scratchpad/task/<project>/<state>/todo-<slug>/todo.md",
  "project/software/",
]
const legacyTaskTopLevelRe = /^## (Outcome|Runtime|Progress|Plan|Messages|Reservations)\b/m

function meaningfulDuplicateLines(files: string[]) {
  const seen = new Map<string, string[]>()
  for (const file of files) {
    const rel = relative(agentDir, file)
    const lines = read(file).split(/\r?\n/)
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!.trim().replace(/\s+/g, " ")
      if (line.length < 45) continue
      if (line.startsWith("|") || line.startsWith("---")) continue
      if (/^(shared_includes|model_default|model_fallbacks|inbox_triggers):/.test(line)) continue
      if (
        line.startsWith("- [[src/agent/prompts") ||
        line.startsWith("- [[project/software/opencode/specification/contract/agent-tier-model]]")
      )
        continue
      const locations = seen.get(line) ?? []
      locations.push(`${rel}:${index + 1}`)
      seen.set(line, locations)
    }
  }
  return [...seen.entries()].filter(([, locations]) => new Set(locations.map((x) => x.split(":")[0])).size > 1)
}

if (!existsSync(agentDir)) fail(`missing canonical agent prompt dir: ${agentDir}`)

const files = existsSync(agentDir) ? walk(agentDir) : []
const loadedCards = files.filter((file) => !relative(agentDir, file).startsWith("_") && file.endsWith(".md"))

for (const rel of ["_shared/base.md", "_shared/tier1.md", "_shared/tier2.md", "_shared/generate.md"]) {
  const file = join(agentDir, rel)
  if (!existsSync(file)) {
    fail(`missing shared prompt: ${rel}`)
    continue
  }
  const body = AgentPromptLoader.extractSection(read(file), "System prompt")?.trim() ?? ""
  if (!body) fail(`${rel} has empty ## System prompt`)
  const h1 = h1Headings(body)
  if (h1.length > 0) fail(`${rel} uses H1 under ## System prompt; use ### or deeper: ${h1.join(", ")}`)
}

const base = existsSync(join(agentDir, "_shared/base.md"))
  ? (AgentPromptLoader.extractSection(read(join(agentDir, "_shared/base.md")), "System prompt") ?? "")
  : ""
for (const sentinel of [
  "### Identity",
  "### Todo File Contract",
  "### Core Tool Contract",
  "This base prompt is the only system-prompt location for tool-use policy",
]) {
  if (!base.includes(sentinel)) fail(`base prompt missing sentinel: ${sentinel}`)
}
if (base.length > 12_000) fail(`base prompt too large: ${base.length} chars > 12000`)

for (const file of loadedCards) {
  const rel = relative(agentDir, file)
  const text = read(file)
  const meta = frontmatter(text)
  for (const section of ["System prompt", "Acceptance criteria", "Failure modes", "Links"]) {
    if (!new RegExp(`^## ${section}$`, "im").test(text)) fail(`${rel} missing ## ${section}`)
  }

  const systemPrompt = AgentPromptLoader.extractSection(text, "System prompt")?.trim() ?? ""
  if (systemPrompt.length > 3_500) fail(`${rel} local ## System prompt too large: ${systemPrompt.length} chars > 3500`)

  if (!includesShared(meta, "prompt:_shared/base")) fail(`${rel} must include prompt:_shared/base`)

  if (meta.tier === "0") {
    if (includesShared(meta, "prompt:_shared/tier1") || includesShared(meta, "prompt:_shared/tier2")) {
      fail(`${rel} tier 0 must not include tier worker shared blocks`)
    }
  }

  if (meta.tier === "1" && !includesShared(meta, "prompt:_shared/tier1"))
    fail(`${rel} tier 1 must include prompt:_shared/tier1`)

  if (meta.tier === "2") {
    if (listValue(meta.spawns).length > 0) fail(`${rel} tier 2 must not declare spawn targets`)
    const isHiddenPrimary = meta.hidden === "true" && meta.mode === "primary"
    if (!isHiddenPrimary && !includesShared(meta, "prompt:_shared/tier2"))
      fail(`${rel} spawnable tier 2 must include prompt:_shared/tier2`)
    if (isHiddenPrimary && includesShared(meta, "prompt:_shared/tier2"))
      fail(`${rel} hidden primary runtime helper should not inherit tier2 leaf-executor block`)
  }

  if (/write:\s*deny/.test(text)) {
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (/\b(write|append|add)\b.*`## (Progress|Systems|Open Questions|Messages)`/i.test(line)) {
        fail(`${rel}:${index + 1} has write-denied permission but claims direct task-note mutation`)
      }
    }
  }
}

for (const file of files) {
  const rel = relative(agentDir, file)
  const text = read(file)
  const lines = text.split(/\r?\n/)
  lines.forEach((line, index) => {
    if (line.includes("## Open questions") || line.includes("Open questions"))
      fail(`${rel}:${index + 1} uses non-canonical Open questions casing`)
    if (/\bTier[012]\b|\bTier-[012]\b|\btier-[012]\b/.test(line))
      fail(`${rel}:${index + 1} uses non-canonical tier spelling`)
    if (/45 minutes|5 -> 10 -> 20 -> 45/.test(line)) fail(`${rel}:${index + 1} uses stale task-result backoff`)
    if (/CLAUDE\.md|greeting-responder|friendly joke|elite AI agent architect/i.test(line))
      fail(`${rel}:${index + 1} contains generic/off-system or stale tool wording`)
    if (/[^\x00-\x7F]/.test(line)) fail(`${rel}:${index + 1} contains non-ASCII prompt text`)
  })
}

for (const [line, locations] of meaningfulDuplicateLines(files)) {
  fail(`duplicate prompt line: ${line}\n  ${locations.join("; ")}`)
}

const loaded = await AgentPromptLoader.loadAgentCards(agentDir)
for (const error of loaded.errors)
  fail(`loader error ${relative(agentDir, error.file)}: ${error.code}: ${error.message}`)
for (const issue of AgentPromptLoader.validateRegistryHealth(loaded)) fail(`registry issue: ${issue.message}`)

for (const [name, card] of Object.entries(loaded.cards)) {
  for (const sentinel of composedPromptSentinels) {
    if (!card.prompt.includes(sentinel)) fail(`${name} composed prompt missing todo/notes sentinel: ${sentinel}`)
  }
  if ((card.prompt.match(/Canonical top-level sections for task notes/g) ?? []).length !== 1)
    fail(`${name} composed prompt should inherit the task-note contract exactly once`)
  if (legacyTaskTopLevelRe.test(card.prompt))
    fail(`${name} composed prompt references legacy task-note top-level section`)
}

if (failures.length) {
  console.error(`[prompt-lint] FAIL (${failures.length})`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log(`[prompt-lint] PASS (${Object.keys(loaded.cards).length} cards, ${files.length} markdown files)`)
