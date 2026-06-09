// Shared task-note seed contract used by todo/workflow tools.

import { DispatchRoles } from "@/permission/policy/dispatch-roles"

export const WORKFLOW_KINDS = [
  "feature", // Full SE lifecycle: plan → design → contract → spec → impl → test → verify
  "bugfix", // Reproduce → root-cause → fix → regression test → verify
  "refactor", // Design → impl → test — no contract/spec/API sections
  "explore", // Research and spike — no impl/verify, ends with design docs
  "chore", // Maintenance (deps, config, CI) — minimal phases
  "learning", // Study / knowledge capture — plan + notes only
] as const

export type WorkflowKind = (typeof WORKFLOW_KINDS)[number]

type PhaseKey =
  | "Plan"
  | "Design"
  | "Root cause"
  | "Contract"
  | "Spec"
  | "Implement"
  | "Rethink & Redesign"
  | "Test Strategy"
  | "Verification"
  | "Research"
  | "Notes"

const WORKFLOW_PHASES: Record<WorkflowKind, PhaseKey[]> = {
  feature: ["Plan", "Design", "Contract", "Spec", "Implement", "Rethink & Redesign", "Test Strategy", "Verification"],
  bugfix: ["Plan", "Root cause", "Design", "Implement", "Rethink & Redesign", "Test Strategy", "Verification"],
  refactor: ["Plan", "Design", "Implement", "Rethink & Redesign", "Test Strategy", "Verification"],
  explore: ["Plan", "Research", "Design", "Rethink & Redesign", "Notes"],
  chore: ["Plan", "Implement", "Test Strategy"],
  learning: ["Plan", "Research", "Notes"],
}

// Per-phase scaffold metadata for the H4 placeholder leaf emitted under each
// `### <Phase>` heading. Aligns with contract §4 (todo-note-format) — every
// leaf carries a metadata blockquote with status/priority/type/agent/etc.
//
// `agent` is now resolved at seed time via DispatchRoles.resolvePhaseSync
// (see resolvePhaseAgent below). Only `type` and `priority` remain literal
// — those are intrinsic phase properties, not agent-routing decisions.
const PHASE_LEAF_META: Record<PhaseKey, { type: string; priority: string }> = {
  Plan: { type: "plan", priority: "high" },
  Design: { type: "design", priority: "high" },
  "Root cause": { type: "search", priority: "high" },
  Contract: { type: "contract", priority: "high" },
  Spec: { type: "spec", priority: "high" },
  Implement: { type: "impl", priority: "high" },
  "Rethink & Redesign": { type: "design", priority: "med" },
  "Test Strategy": { type: "test", priority: "high" },
  Verification: { type: "verify", priority: "high" },
  Research: { type: "search", priority: "med" },
  Notes: { type: "learn", priority: "med" },
}

const AGENT_CAPABILITY_PROFILE: Record<string, string> = {
  implementer: "code_patch, reasoning, tool_calling",
  planner: "reasoning, long_context",
  adviser: "reasoning, risk_review",
  searcher: "speed, long_context",
  worker: "code_patch, tool_calling, terminal_agentic",
}

function capabilityProfile(agentName: string): string {
  return AGENT_CAPABILITY_PROFILE[agentName] ?? "reasoning, tool_calling"
}

/** Cfg shape consumed by taskNoteSeed for phase → agent overrides. */
export type SeedCfg = Parameters<typeof DispatchRoles.resolvePhaseSync>[1]

const WORKFLOW_META: Record<WorkflowKind, { label: string; flow: string }> = {
  feature: { label: "Feature", flow: "Plan → Design → Contract → Spec → Implement → Test → Verify" },
  bugfix: { label: "Bug Fix", flow: "Plan → Root Cause → Design → Implement → Test → Verify" },
  refactor: { label: "Refactor", flow: "Plan → Design → Implement → Test → Verify" },
  explore: { label: "Explore", flow: "Plan → Research → Design → Notes" },
  chore: { label: "Chore", flow: "Plan → Implement → Test" },
  learning: { label: "Learning", flow: "Plan → Research → Notes" },
}

export function taskSlugFromNote(note: string) {
  const parts = note.split("/").filter(Boolean)
  const last = (parts.at(-1) ?? "").replace(/\.md$/, "")
  const parent = parts.at(-2) ?? ""
  const base = last === "todo" && parent.startsWith("todo-") ? parent : last
  return base.replace(/^todo-/, "") || "task"
}

// Emit one heading-tree phase block per contract §4:
//   ### <Phase>
//   #### [<phase-num>] <placeholder leaf>
//   > status: pending
//   > priority: <p>
//   > type: <t>
//   > agent: <a>
//   > close-signal: _placeholder_
//   > blocked-by:
//   > provider:models:
//
// The placeholder leaf is the v2-shape entry point — planner replaces or
// extends it during plan-tree authoring. Empty `### <Phase>` (no H4) is also
// v2-valid; we seed a placeholder so new tasks demonstrate the leaf contract.
function buildPhase(key: PhaseKey, phaseIndex: number, agentName: string): string[] {
  const heading = `### ${key}`
  const meta = PHASE_LEAF_META[key]
  const num = String(phaseIndex + 1)
  const phaseSlug = key
    .toLowerCase()
    .replace(/[^a-z]+/g, "-")
    .replace(/^-|-$/g, "")
  return [
    heading,
    "",
    `#### [${num}] ${phaseSlug} placeholder`,
    "",
    "> status: pending",
    `> priority: ${meta.priority}`,
    `> type: ${meta.type}`,
    `> agent: ${agentName}`,
    `> required-capabilities: ${capabilityProfile(agentName)}`,
    "> close-signal: _TODO: replace placeholder before first dispatch_",
    "> blocked-by:",
    "> provider:models:",
    "",
  ]
}

/**
 * Seed a fresh task note. The `cfg` argument supplies optional phase → agent
 * overrides (`cfg.dispatch_roles.phase[<Phase>]`); when omitted, every phase
 * receives its built-in default agent — preserving prior hardcoded behavior.
 */
export function taskNoteSeed(
  taskNote: string,
  todoLabel?: string,
  workflow: WorkflowKind = "feature",
  cfg: SeedCfg = {},
) {
  void workflow
  void cfg
  const slug = taskSlugFromNote(taskNote)
  const description = todoLabel?.trim() || slug.replace(/-/g, " ")
  return [
    "---",
    "tags:",
    `  - task/${slug}`,
    "  - status/active",
    `description: ${description}`,
    "---",
    "",
    `# todo-${slug}`,
    "",
    "## Tasks",
    "",
    `- [ ] ${description}`,
    "",
    "## Systems",
    "",
  ].join("\n")
}
