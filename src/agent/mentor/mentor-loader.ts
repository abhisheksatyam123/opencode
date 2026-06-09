import * as path from "path"
import { lintMentorRulesDir, type MentorRule } from "@/agent/mentor/mentor-lint"
import { Global } from "@/filesystem/global"

export type { MentorRule } from "@/agent/mentor/mentor-lint"

export type LoadedMentorRules = {
  rules: MentorRule[]
  sourceDir: string
}

export function formatActiveMentorRulesSection(rules: MentorRule[]): string {
  if (rules.length === 0) return "## Active mentor rules\n\n_None_"
  const rows = rules
    .map(
      (r) =>
        `- ${r.rule_id} [${r.priority}] scope=${r.scope} when=${r.condition} → ${r.action}${r.source_ref ? ` (${r.source_ref})` : ""}`,
    )
    .join("\n")
  return `## Active mentor rules\n\n${rows}`
}

export async function loadMentorRulesAtSessionStart(input?: {
  projectRoot?: string
  mentorDir?: string
}): Promise<LoadedMentorRules> {
  const sourceDir = input?.mentorDir ?? path.join(Global.Path.config, "mentor")
  const lint = await lintMentorRulesDir(sourceDir)
  if (!lint.ok) {
    const reasons = [
      ...lint.schemaErrors,
      ...lint.duplicateRuleIds.map((id) => `duplicate rule_id: ${id}`),
      ...lint.conflicts.map(
        (c) => `conflict ${c.rule_ids[0]}↔${c.rule_ids[1]} scope=${c.scope} property=${c.property}`,
      ),
    ]
    throw new Error(`MentorScript load failed: ${reasons.join("; ") || "unknown error"}`)
  }
  return { rules: lint.rules, sourceDir }
}
