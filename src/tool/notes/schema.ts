import { NEED, REDUCTION_KINDS, REDUCTION_SCOPES } from "@/tool/notes/types"
import type { ReductionKind, ReductionScope } from "@/tool/notes/types"

// ---------------------------------------------------------------------------
// Helpers — note schema/seed logic + reduction classifiers
//
// Section seeds match the canonical vault templates in ~/notes/_templates/
// and the schemas declared in ~/notes/atomic/README.md and the project README.
// ---------------------------------------------------------------------------

const atomicSeeds: Record<string, string[]> = {
  Reasoning: [
    "<2-4 short paragraphs explaining why the claim is true. Define terms. Give the mechanism, not just the conclusion.>",
  ],
  Related: ["- [[<related atomic note title>]]"],
  "Applied in": ["- [[<project note that references this atom>]]"],
}

const SECTION_SEEDS: Partial<Record<keyof typeof NEED | "", Record<string, string[]>>> = {
  atomic: atomicSeeds,
  principle: atomicSeeds,
  pattern: atomicSeeds,
  reference: {
    Purpose: ["- <why this reference exists>"],
    Entries: ["| key | meaning | since |", "|---|---|---|", "| | | |"],
  },
  literature: {
    "Key claims": ["- <claim 1>", "- <claim 2>"],
    "My reading": ["<your synthesis — what does this mean to you?>"],
    "Permanent notes extracted": ["- [[<atomic note created from this source>]]"],
  },
  skill: {
    "When to use": ["<trigger conditions — when should future-you reach for this?>"],
    Procedure: ["1. <step>", "2. <step>", "3. <step>"],
    Pitfalls: ["- <pitfall>"],
    Related: ["- [[<related note>]]"],
  },
  concept: {
    Meaning: ["<shared domain abstraction — what this concept means across the system>"],
    Invariants: ["- <rules that always hold for this concept>"],
    Lifecycle: ["- <how this concept is created, used, and retired>"],
  },
  module: {
    "Data flow": ["- <data path: source → transform → sink>"],
    "Control layers": ["- <control-plane path: caller → orchestrator → worker>"],
    Patterns: ["- <project-specific instantiation of an atomic concept>"],
    "Atomic sources": ["- <source files or modules that are the primary implementation reference>"],
    Boundaries: ["- <ownership edges and interface contracts>"],
  },
  architecture: {
    Purpose: ["<what cross-module interaction space this note explains and why>"],
    "Participating modules": ["- [[<module note>]]"],
    Topology: ["- <structural map of module relationships and major boundaries>"],
    "Data flow": ["- <system path: producer → orchestrator → transforms → sink>"],
    "Control layers": ["- <cross-module orchestration, policy, and execution boundaries>"],
    Patterns: ["- <stable cross-module design rules>"],
    "Atomic sources": ["- <source files or modules that are the primary implementation reference>"],
    Boundaries: ["- <ownership edges and interface contracts between modules>"],
  },
  data: {
    Purpose: ["<what this data layer manages>"],
    Schema: ["- <field>: <type> — <meaning>"],
    Invariants: ["- <rules that always hold>"],
    Producers: ["- [[<module that writes this data>]]"],
    Consumers: ["- [[<module that reads this data>]]"],
  },
  derived: {
    Purpose: ["<what composed view this note captures>"],
    Composition: ["- [[<atomic note>]]", "- [[<module note>]]"],
    Boundaries: ["- <ownership edges and interface contracts>"],
    "Data flow": ["- <data path>"],
    "Control layers": ["- <control plane path>"],
  },
  decision: {
    Context: ["<what situation forced this decision? what constraints?>"],
    Decision: ["<what we chose>"],
    "Alternatives considered": ["- **Option A** — <summary, why rejected>", "- **Option B** — <summary, why rejected>"],
    Consequences: ["- Positive: ...", "- Negative: ...", "- Follow-ups: ..."],
  },
  diagram: {
    Purpose: ["<what this diagram visualizes>"],
    Source: ["`<path/to/diagram.puml>`"],
  },
  flow: {
    Purpose: ["<runtime path this flow describes>"],
    Producer: ["- [[<module>]]"],
    Orchestrator: ["- [[<module>]]"],
    Worker: ["- [[<module>]]"],
    Sink: ["- [[<module>]]"],
    Transitions: ["1. <step>", "2. <step>"],
  },
  moc: {
    Purpose: ["<what this map curates and for whom>"],
    Notes: ["- [[<note>]] — <one-line description>"],
  },
  task: {
    Tasks: ["- [ ] <actionable task>", "- [ ] <next actionable task>"],
    Systems: [],
  },
  question: {
    "Why I'm asking": ["<what prompted this? what would change if I knew the answer?>"],
    "What I've tried": ["- <attempt or known fact>"],
    Leads: ["- [[<possible source>]]"],
    Answer: ["<filled in when answered. link the permanent note that captures the answer.>"],
  },
  thinking: {
    "Why I'm asking": ["<what prompted this? what would change if I knew the answer?>"],
    "What I've tried": ["- <attempt or known fact>"],
    Leads: ["- [[<possible source>]]"],
    Answer: ["<filled in when answered. link the permanent note that captures the answer.>"],
  },
  log: {
    "Worked on": ["- "],
    Learned: ["- "],
    "Open threads": ["- "],
    Tomorrow: ["- "],
  },
  journal: {
    "Worked on": ["- "],
    Learned: ["- "],
    "Open threads": ["- "],
    Tomorrow: ["- "],
  },
}

export function seedSection(kind: keyof typeof NEED | "", sec: string): string[] {
  return [...(SECTION_SEEDS[kind]?.[sec] ?? ["- TODO."])]
}

export function qualityMsg(kind: keyof typeof NEED, _flow: boolean) {
  if (kind === "task")
    return "Task notes use exactly two top-level sections: ## Tasks and ## Systems. Keep both concise and execution-focused."
  if (kind === "module")
    return "Module notes are interfaces to subsystems. Composition section lists the atomic concepts the module instantiates. Sections are stable headings — do not rename without a backlink sweep."
  if (kind === "atomic" || kind === "principle" || kind === "pattern")
    return "Atomic notes are single ideas. Claim is one sentence. Reasoning gives the mechanism. Related lists 2+ neighbors. Applied in is the reverse index."
  if (kind === "concept")
    return "Concept notes define shared domain abstractions. Meaning is the canonical definition. Invariants are rules that always hold. Lifecycle describes creation and retirement."
  if (kind === "skill") return "Skill notes capture repeatable procedures with trigger conditions and pitfalls."
  return "Section structure is the link contract. Keep headings stable."
}

export function validReductionKind(v: unknown): v is ReductionKind {
  return typeof v === "string" && (REDUCTION_KINDS as readonly string[]).includes(v)
}

export function validReductionScope(v: unknown): v is ReductionScope {
  return typeof v === "string" && (REDUCTION_SCOPES as readonly string[]).includes(v)
}

export function classifyLine(line: string): ReductionKind {
  const row = line.toLowerCase()
  if (/\b(step|procedure|workflow|how to|run|execute|command)\b/.test(row)) return "procedure"
  if (/\b(module|subsystem|component|service|layer|owner)\b/.test(row)) return "topology"
  if (/\b(decision|rule|policy|gate|constraint|invariant)\b/.test(row)) return "decision"
  if (/\b(pattern|recurring|reusable|abstraction|class of)\b/.test(row)) return "pattern"
  return "fact"
}

export function scopeLine(line: string): ReductionScope {
  const row = line.toLowerCase()
  if (/\b(cross-module|architecture|system-level|end-to-end)\b/.test(row)) return "cross-module"
  if (/\b(system|global|vault|all modules)\b/.test(row)) return "system"
  if (/\b(module|subsystem|component|service)\b/.test(row)) return "module"
  return "task"
}

export function noteTarget(kind: ReductionKind, scope: ReductionScope): string {
  if (scope === "system" || scope === "cross-module") return "project/architecture/<name>"
  if (kind === "procedure") return "project/skill/<name>"
  if (kind === "topology") return "project/architecture/<name>"
  if (kind === "decision") return "project/decision/<name>"
  if (kind === "pattern") return "atomic/<name>"
  return "project/module/<name>"
}
