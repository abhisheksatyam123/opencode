import * as fs from "fs/promises"
import * as path from "path"
import matter from "gray-matter"
import z from "zod"
import { Global } from "@/filesystem/global"

const MentorRuleSchema = z.object({
  rule_id: z.string().regex(/^[a-z][a-z0-9_]*$/),
  scope: z.string().min(1),
  condition: z.string().min(1),
  action: z.string().min(1),
  priority: z.enum(["high", "medium", "low"]),
  property: z.string().min(1).optional(),
  source_ref: z.string().min(1).optional(),
})

const MentorRulesetSchema = z.object({
  rules: z.array(MentorRuleSchema).min(1),
})

export type MentorRule = z.infer<typeof MentorRuleSchema>
export type MentorRuleset = z.infer<typeof MentorRulesetSchema>

export type MentorLintConflict = {
  scope: string
  property: string
  rule_ids: [string, string]
  actions: [string, string]
}

export type MentorLintResult = {
  ok: boolean
  files: number
  rules: MentorRule[]
  schemaErrors: string[]
  duplicateRuleIds: string[]
  conflicts: MentorLintConflict[]
}

function inferProperty(rule: MentorRule): string {
  if (rule.property) return rule.property
  const txt = rule.action.toLowerCase()
  if (txt.includes("background=true") || txt.includes("non-blocking") || txt.includes("fan-out")) {
    return "dispatch_mode"
  }
  if (txt.includes("must not launch other subagents") || txt.includes("no agent spawning")) {
    return "spawn_policy"
  }
  if (txt.includes("never touch source") || txt.includes("write code")) {
    return "source_mutation_policy"
  }
  const normalized = txt.replace(/[^a-z0-9\s]/g, " ").trim()
  return normalized.split(/\s+/).slice(0, 4).join("_") || "generic"
}

function parseYamlFile(raw: string): unknown {
  const wrapped = `---\n${raw}\n---\n`
  return matter(wrapped).data
}

async function listMentorFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  return entries
    .filter((e) => e.isFile() && /\.ya?ml$/i.test(e.name))
    .map((e) => path.join(dir, e.name))
    .sort((a, b) => a.localeCompare(b))
}

export async function loadMentorRuleFiles(
  dir: string,
): Promise<{ file: string; rules: MentorRule[]; errors: string[] }[]> {
  const files = await listMentorFiles(dir)
  const out: { file: string; rules: MentorRule[]; errors: string[] }[] = []

  for (const file of files) {
    const raw = await fs.readFile(file, "utf8").catch(() => "")
    if (!raw.trim()) {
      out.push({ file, rules: [], errors: ["empty file"] })
      continue
    }
    let parsed: unknown
    try {
      parsed = parseYamlFile(raw)
    } catch (err: any) {
      out.push({ file, rules: [], errors: [`yaml parse failed: ${err?.message ?? String(err)}`] })
      continue
    }

    const validated = MentorRulesetSchema.safeParse(parsed)
    if (!validated.success) {
      const errors = validated.error.issues.map((i) => `${i.path.join("@/agent/mentor") || "root"}: ${i.message}`)
      out.push({ file, rules: [], errors })
      continue
    }
    out.push({ file, rules: validated.data.rules, errors: [] })
  }

  return out
}

export function detectMentorConflicts(rules: MentorRule[]): MentorLintConflict[] {
  const conflicts: MentorLintConflict[] = []
  const seen = new Map<string, MentorRule>()

  for (const rule of rules) {
    const property = inferProperty(rule)
    const key = `${rule.scope}::${property}`
    const prev = seen.get(key)
    if (!prev) {
      seen.set(key, rule)
      continue
    }
    if (prev.action.trim() === rule.action.trim()) continue
    conflicts.push({
      scope: rule.scope,
      property,
      rule_ids: [prev.rule_id, rule.rule_id],
      actions: [prev.action, rule.action],
    })
  }

  return conflicts
}

export async function lintMentorRulesDir(dir: string): Promise<MentorLintResult> {
  const loaded = await loadMentorRuleFiles(dir)
  const files = loaded.length
  const schemaErrors = loaded.flatMap((r) => r.errors.map((e) => `${path.basename(r.file)}: ${e}`))
  const rules = loaded.flatMap((r) => r.rules)

  const idCounts = new Map<string, number>()
  for (const rule of rules) {
    idCounts.set(rule.rule_id, (idCounts.get(rule.rule_id) ?? 0) + 1)
  }
  const duplicateRuleIds = Array.from(idCounts.entries())
    .filter(([, n]) => n > 1)
    .map(([id]) => id)

  const conflicts = detectMentorConflicts(rules)
  const ok = schemaErrors.length === 0 && duplicateRuleIds.length === 0 && conflicts.length === 0 && files > 0

  return {
    ok,
    files,
    rules,
    schemaErrors,
    duplicateRuleIds,
    conflicts,
  }
}

function printResult(result: MentorLintResult) {
  if (result.schemaErrors.length > 0) {
    for (const err of result.schemaErrors) {
      console.error(`SCHEMA_ERROR: ${err}`)
    }
  }
  if (result.duplicateRuleIds.length > 0) {
    for (const id of result.duplicateRuleIds) {
      console.error(`DUPLICATE_RULE_ID: ${id}`)
    }
  }
  if (result.conflicts.length > 0) {
    for (const conflict of result.conflicts) {
      const [a, b] = conflict.rule_ids
      console.error(`CONFLICT: ${a} ↔ ${b} — scope=${conflict.scope} property=${conflict.property}`)
    }
  }
  if (result.ok) {
    console.log(`mentor:lint ✓ files=${result.files} rules=${result.rules.length} conflicts=0`)
  }
}

async function main() {
  const dirArg = process.argv.slice(2).find((a) => !a.startsWith("-"))
  const dir = dirArg ?? path.join(Global.Path.config, "mentor")
  const result = await lintMentorRulesDir(dir)
  printResult(result)
  process.exit(result.ok ? 0 : 1)
}

if (import.meta.main) {
  await main()
}
