// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Heading {
  level: number
  text: string
  anchor: string
  line: number
}

export interface BlockRef {
  id: string
  line: number
}

export interface Frontmatter {
  tags?: string[]
  aliases?: string[]
  description?: string
  [key: string]: unknown
}

export interface Issue {
  path: string
  line: number
  code: string
  msg: string
}

export const ADVISORY = new Set([
  "missing-applied-in",
  "orphan-atom",
  "duplicate-atom-alias",
  "stale-updated",
  "unpromoted-resolution",
])

// Hardcoded fallback when no override is set. Must match DEFAULT_NOTES_ROOT in
// note/task tooling. Override via OPENCODE_DEFAULT_NOTES_ROOT (tests) or the standard
// precedence chain (project/global opencode.json `notes.root`, OPENCODE_NOTES_ROOT).
const DEFAULT_NOTES_ROOT = "/local/mnt/workspace/notes"

// Allow tests to override the default notes root via OPENCODE_DEFAULT_NOTES_ROOT.
// This is a function so it reads the env var at call time, not at module load time.
export function ROOT() {
  return process.env.OPENCODE_DEFAULT_NOTES_ROOT?.trim() || DEFAULT_NOTES_ROOT
}

export function envNum(key: string, fallback: number, min: number, max: number) {
  const raw = process.env[key]
  const val = raw ? Number.parseInt(raw, 10) : fallback
  if (!Number.isFinite(val)) return fallback
  return Math.max(min, Math.min(max, val))
}

export const SAVE_TIMEOUT = envNum("OPENCODE_NOTES_SAVE_TIMEOUT_MS", 2500, 100, 30000)
export const SAVE_RETRY = envNum("OPENCODE_NOTES_SAVE_RETRY", 2, 0, 5)

// ---------------------------------------------------------------------------
// Required-section schema — aligned with the ~/notes vault canon
//
// Sources of truth (in ~/notes):
//   - atomic/README.md            atomic note schema
//   - _templates/task.md          task template
//   - _templates/concept.md       concept template
//   - _templates/skill.md         skill template
//   - _templates/decision.md      decision (ADR) template
//   - _templates/literature.md    literature note template
//   - _templates/question.md      question note template
//   - _templates/daily.md         daily journal template
//   - atomic/Module note as interface to a subsystem.md   module note schema
//
// Universal atom kinds (live in /home/abhi/notes/atomic/...):
//   atomic     — top-level loose atoms with the canon Claim/Reasoning shape
//   concept    — universal concept definition
//   principle  — normative claim
//   pattern    — recurring solution shape
//   reference  — lookup table / registry
//   skill      — reusable procedure
//   literature — source-bound notes (article/book/paper)
//
// Project-specific kinds (live in project/software/<name>/...):
//   architecture, module, data, derived, decision, diagram, flow, task, moc
//
// Holistic vault surfaces:
//   inbox, journal, log
// ---------------------------------------------------------------------------
export const NEED = {
  // ── atomic / universal ────────────────────────────────────────────────────
  // Per ~/notes/atomic/README.md: atomic notes use a `**Claim**: ...` bold
  // paragraph (validated separately, not as a heading) plus three H2 sections:
  // Reasoning, Related, Applied in.
  atomic: ["Reasoning", "Related", "Applied in"],
  principle: ["Reasoning", "Related", "Applied in"],
  pattern: ["Reasoning", "Related", "Applied in"],
  reference: ["Purpose", "Entries"],
  literature: ["Key claims", "My reading", "Permanent notes extracted"],
  skill: ["When to use", "Procedure", "Pitfalls", "Related"],
  "session-prompt": ["System prompt"],

  // ── project-specific ──────────────────────────────────────────────────────
  concept: ["Meaning", "Invariants", "Lifecycle"],
  module: [
    "Responsibilities",
    "Composition",
    "Public API",
    "Key files",
    "Data flow",
    "Control layers",
    "Use cases",
    "Patterns",
    "Atomic sources",
    "Boundaries",
  ],
  architecture: [
    "Purpose",
    "Participating modules",
    "Topology",
    "Data flow",
    "Control layers",
    "Patterns",
    "Atomic sources",
    "Boundaries",
  ],
  data: ["Purpose", "Schema", "Invariants", "Producers", "Consumers"],
  derived: ["Purpose", "Composition", "Boundaries", "Data flow", "Control layers"],
  decision: ["Context", "Decision", "Alternatives considered", "Consequences"],
  diagram: ["Purpose", "Source"],
  flow: ["Purpose", "Producer", "Orchestrator", "Worker", "Sink", "Transitions"],
  moc: ["Purpose", "Notes"],

  // ── task / scratchpad ─────────────────────────────────────────────────────
  // Canonical task-note contract: exactly two top-level sections.
  task: ["Tasks", "Systems"],

  // ── question / thinking ───────────────────────────────────────────────────
  question: ["Why I'm asking", "What I've tried", "Leads", "Answer"],
  thinking: ["Why I'm asking", "What I've tried", "Leads", "Answer"],

  // ── holistic surfaces ─────────────────────────────────────────────────────
  log: ["Worked on", "Learned", "Open threads", "Tomorrow"],
  inbox: [],
  journal: ["Worked on", "Learned", "Open threads", "Tomorrow"],
} as const

// Lifecycle status — canonical 5-state vocabulary from ~/notes/README.md.
// Legacy 3-state vocabulary (stable/wip/deprecated) is accepted as alias.
export const STATUS_CANONICAL = ["seedling", "growing", "evergreen", "superseded", "archived"] as const
export const STATUS_LEGACY_ALIAS: Record<string, (typeof STATUS_CANONICAL)[number]> = {
  stable: "evergreen",
  wip: "growing",
  draft: "seedling",
  deprecated: "superseded",
}
export type StatusCanonical = (typeof STATUS_CANONICAL)[number]

export function normalizeStatus(value: unknown): StatusCanonical | undefined {
  if (typeof value !== "string") return undefined
  const v = value.trim().toLowerCase()
  if ((STATUS_CANONICAL as readonly string[]).includes(v)) return v as StatusCanonical
  return STATUS_LEGACY_ALIAS[v]
}

export const REDUCTION_KINDS = ["fact", "pattern", "procedure", "topology", "decision"] as const
export const REDUCTION_SCOPES = ["task", "module", "cross-module", "system"] as const

export type ReductionKind = (typeof REDUCTION_KINDS)[number]
export type ReductionScope = (typeof REDUCTION_SCOPES)[number]

export interface Candidate {
  kind: ReductionKind
  scope: ReductionScope
  line: number
  text: string
  suggestion: string
}

export interface Seed {
  path: string
  title: string
  fm: Frontmatter
  sec: Partial<Record<string, string>>
}
