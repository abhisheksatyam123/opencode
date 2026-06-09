import type { Seed } from "@/tool/notes/types"

// ---------------------------------------------------------------------------
// Bootstrap seed data — minimal starter notes for an empty project vault.
//
// Optional notes are human-curated. The
// bootstrap creates a baseline set of architecture, concept, module, skill,
// and task notes so agents can orient immediately.
// ---------------------------------------------------------------------------

export const bootData: Seed[] = [
  // ── Architecture notes ────────────────────────────────────────────────────
  {
    path: "architecture/system-overview",
    title: "system-overview",
    fm: {
      description: "Top-level system map: modules, data flows, and control layers.",
      owner: "architecture",
      tags: ["architecture/system-overview", "status/stable"],
    },
    sec: {
      Purpose: "- Canonical entry point for understanding the system topology.",
      "Participating modules": "- _Add module notes here as you create them: [[module/<name>]]_",
      Topology: "- _Describe the structural map of module relationships and major boundaries._",
      "Data flow": "- _Describe the system-level data path: producer → orchestrator → transforms → sink._",
      "Control layers": "- _Describe cross-module orchestration, policy, and execution boundaries._",
      Patterns: "- _Stable cross-module design rules._",
      "Atomic sources": "- _Source files or modules that are the primary implementation reference._",
      Boundaries: "- _Ownership edges and interface contracts between modules._",
    },
  },
  {
    path: "architecture/data-flow-map",
    title: "data-flow-map",
    fm: {
      description: "Canonical map of data contracts, producers, transforms, and consumers.",
      owner: "architecture",
      tags: ["architecture/data-flow-map", "status/stable"],
    },
    sec: {
      Purpose: "- Map all data contracts, producers, transforms, and consumers across the system.",
      "Participating modules": "- _Add module notes here as you create them: [[module/<name>]]_",
      Topology: "- _Describe the data topology: sources, transforms, sinks._",
      "Data flow": "- _Describe the canonical data path end-to-end._",
      "Control layers": "- _Describe which layers own data validation and transformation._",
      Patterns: "- _Stable data-flow design rules._",
      "Atomic sources": "- _Source files that define the data contracts._",
      Boundaries: "- _Data ownership edges and contract boundaries._",
    },
  },
  {
    path: "architecture/control-layer-map",
    title: "control-layer-map",
    fm: {
      description: "Canonical map of orchestration boundaries and control-plane ownership.",
      owner: "architecture",
      tags: ["architecture/control-layer-map", "status/stable"],
    },
    sec: {
      Purpose: "- Map all orchestration boundaries and control-plane ownership across the system.",
      "Participating modules": "- _Add module notes here as you create them: [[module/<name>]]_",
      Topology: "- _Describe the control topology: orchestrators, workers, gates._",
      "Data flow": "- _Describe how control signals flow through the system._",
      "Control layers": "- _Describe the canonical control-plane hierarchy._",
      Patterns: "- _Stable control-layer design rules._",
      "Atomic sources": "- _Source files that define the control contracts._",
      Boundaries: "- _Control ownership edges and escalation paths._",
    },
  },

  // ── Concept notes ─────────────────────────────────────────────────────────
  {
    path: "concept/workspace-memory-model",
    title: "workspace-memory-model",
    fm: {
      description: "Optional notes for human reference.",
      owner: "notes",
      tags: ["concept/workspace-memory-model", "status/stable"],
    },
    sec: {
      Meaning: [
        "Task notes are lightweight coordination artifacts for the active goal, plan, evidence, and remaining work.",
        "Module notes are optional human reference for ownership, data flow, and control layers.",
        "Atomic notes are optional shared concepts reused across projects.",
        "Clear modular code is the primary source of truth; notes are supporting references.",
      ].join("\n"),
      Invariants: [
        "- Task notes are temporary: they are created per goal and archived when done.",
        "- Module notes are stable: headings are link contracts and must not be renamed without a backlink sweep.",
        "- Atomic notes are universal: they live in the shared vault and are reused across projects.",
      ].join("\n"),
      Lifecycle: [
        "- Task coordination file: created only when useful, updated minimally, archived at close.",
        "- Module note: created when the user or task needs durable human reference.",
        "- Atomic note: created only for reusable concepts worth preserving.",
      ].join("\n"),
    },
  },
  {
    path: "concept/flow-lens",
    title: "flow-lens",
    fm: {
      description: "Shared meaning of flow as the runtime-path lens used inside architecture and module notes.",
      owner: "notes",
      tags: ["concept/flow-lens", "status/stable"],
    },
    sec: {
      Meaning: [
        "Flow is the runtime-path lens: it describes how data or control moves through the system at execution time.",
        "Architecture notes use flow to describe cross-module data paths and control boundaries.",
        "Module notes use flow to describe the internal data path and control layers of a subsystem.",
      ].join("\n"),
      Invariants: [
        "- Flow sections describe runtime behavior, not static structure.",
        "- Data flow describes what moves; control layers describe who decides.",
        "- Flow is always directional: source → transform → sink.",
      ].join("\n"),
      Lifecycle: [
        "- Flow understanding is built incrementally as the system is explored.",
        "- Flow sections are updated when new data paths or control boundaries are discovered.",
      ].join("\n"),
    },
  },

  // ── Module notes ──────────────────────────────────────────────────────────
  {
    path: "module/note-quality",
    title: "note-quality",
    fm: {
      description: "Authoritative quality contract for all note types.",
      owner: "notes-tool",
      tags: ["module/note-quality", "status/stable"],
    },
    sec: {
      Composition: "- Defines lightweight note quality checks for human-authored notes.",
      "Data flow": "- note file → audit engine → issue list → formatted report.",
      "Control layers": "- audit engine → blocking issues → advisory issues → pass/fail verdict.",
      Patterns: [
        "- Link instead of duplicate: use wikilinks to reference other notes.",
        "- Sections are link contracts: do not rename headings without a backlink sweep.",
        "- Audit only when maintaining human-authored notes.",
      ].join("\n"),
      "Atomic sources": "- `src/tool/notes/ops-audit.ts` — audit engine implementation.",
      Boundaries: "- Audit engine owns all quality checks. Callers must not implement their own audit logic.",
    },
  },

  // ── Skill notes ───────────────────────────────────────────────────────────
  {
    path: "skill/notes-workflow",
    title: "notes-workflow",
    fm: {
      description: "Standard procedure for optional note lookup. Agents may read notes but should not write project notes unless asked.",
      status: "evergreen",
      tags: ["skill/notes-workflow", "status/stable"],
    },
    sec: {
      "When to use": "When existing project notes may clarify a component or prior decision.",
      Procedure: [
        "1. Read only the note section needed for the current question.",
        "2. Prefer source code when notes are stale, missing, or ambiguous.",
        "3. Do not create or update project notes unless the user explicitly asks.",
      ].join("\n"),
      Pitfalls: [
        "- Treating notes as authoritative when code differs.",
        "- Writing notes instead of making code clear and modular.",
      ].join("\n"),
      Related: "- [[concept/workspace-memory-model]]",
    },
  },
  {
    path: "skill/notes-map",
    title: "notes-map",
    fm: {
      description: "Map the system: explore components, data flows, and interactions before writing code.",
      status: "evergreen",
      tags: ["skill/notes-map", "status/stable"],
    },
    sec: {
      Purpose: "Map the system topology before writing code — explore components, data flows, and interactions.",
      Workflow: [
        "1. Read existing notes only when they are directly useful",
        "2. `internal notes lookup op=index path=architecture/<name>` — read system topology",
        '3. `internal notes lookup op=read path=module/<name> section="Data flow"` — trace data paths',
        "4. Prefer source code when notes are stale, missing, or ambiguous",
        "5. Do not create or update project notes unless the user explicitly asks",
      ].join("\n"),
      "When to use": "Before implementing any change that touches multiple modules.",
      Pitfalls: "- Letting notes override clear evidence from source code.",
      Related: "- [[concept/workspace-memory-model]]",
    },
  },
  {
    path: "skill/notes-design",
    title: "notes-design",
    fm: {
      description: "Design before execution: make contracts, interfaces, and invariants clear in code and TODO planning.",
      status: "evergreen",
      tags: ["skill/notes-design", "status/stable"],
    },
    sec: {
      Purpose: "Design before execution — make contracts, interfaces, and invariants clear in code and TODO planning.",
      Workflow: [
        "1. Inspect the existing code paths and public interfaces",
        "2. Identify invariants and failure modes",
        "3. Record only task-local decisions in `## Systems` when needed",
        "4. Implement so the code expresses the contract clearly",
      ].join("\n"),
      "When to use": "Before implementing any interface contract or invariant.",
      Pitfalls: "- Leaving contracts implicit in tangled code.",
      Related: "- [[concept/workspace-memory-model]]",
    },
  },
  {
    path: "skill/notes-execute",
    title: "notes-execute",
    fm: {
      description: "Execute with code-first discipline: implement clear modular code and verify behavior.",
      status: "evergreen",
      tags: ["skill/notes-execute", "status/stable"],
    },
    sec: {
      Purpose: "Execute with code-first discipline — inspect code, implement, test, and keep TODO evidence concise.",
      Workflow: [
        "1. Inspect the relevant source code",
        "2. Implement the smallest clear change",
        "3. Run tests to verify behavior",
        "4. Update `## Tasks`/`## Systems` only with concise task evidence when needed",
      ].join("\n"),
      "When to use": "Before implementing any code change.",
      Pitfalls: "- Hiding unclear behavior in notes instead of making code understandable.",
      Related: "- [[concept/workspace-memory-model]]",
    },
  },
  {
    path: "skill/notes-audit",
    title: "notes-audit",
    fm: {
      description: "Audit note quality for human-authored notes when explicitly requested.",
      status: "evergreen",
      tags: ["skill/notes-audit", "status/stable"],
    },
    sec: {
      Purpose: "Audit note quality for human-authored notes when explicitly requested.",
      Workflow: [
        "1. Run note audit only when the user requests note maintenance",
        "2. Report issues without expanding notes by default",
        "3. Let the user decide whether notes should be changed",
      ].join("\n"),
      "When to use": "Only when the user requests note maintenance.",
      Pitfalls: "- Running note maintenance during code work creates noise.",
      Related: "- [[module/note-quality]]",
    },
  },

  // ── Runtime session prompts ─────────────────────────────────────────────
  {
    path: "atomic/session-prompt/plan",
    title: "plan",
    fm: {
      description: "Plan-mode turn reminder injected from the notes vault.",
      owner: "session-runtime",
      tags: ["session-prompt", "status/stable"],
    },
    sec: {
      "System prompt": "Plan mode: keep coordination concise and action-oriented.",
    },
  },
  {
    path: "atomic/session-prompt/max-steps",
    title: "max-steps",
    fm: {
      description: "Max-steps final-response reminder injected from the notes vault.",
      owner: "session-runtime",
      tags: ["session-prompt", "status/stable"],
    },
    sec: {
      "System prompt": "Max steps hit. No tools. Text only.\nSay: max steps reached, what done, what left, next step.",
    },
  },
  {
    path: "atomic/session-prompt/agent",
    title: "agent",
    fm: {
      description: "Base agent reminder preserved as a vault session prompt.",
      owner: "session-runtime",
      tags: ["session-prompt", "status/stable"],
    },
    sec: {
      "System prompt": [
        "You are an OpenCode agent.",
        "",
        "- Work the assigned task only.",
        "- Keep task findings concise. Prefer file:line and command evidence.",
        "- Small safe steps. Ask only for true blockers or irreversible choices.",
        "- Use available tools directly (read, write, bash, task, question). Batch independent safe reads/searches when possible.",
        "- Source edits/build/tests/refactors follow assigned role/subagent rules.",
        "- Output terse: result → evidence → next action.",
      ].join("\n"),
    },
  },

  // ── Task notes ────────────────────────────────────────────────────────────
  {
    path: "task/todo-bootstrap-notes-vault",
    title: "todo-bootstrap-notes-vault",
    fm: {
      description: "Bootstrap the project notes vault with baseline architecture, concept, module, and skill notes.",
      tags: ["task/bootstrap-notes-vault", "status/done"],
    },
    sec: {
      Tasks: [
        "- [x] Bootstrap the project notes vault with baseline architecture/concept/module/skill notes.",
        "- [x] Evidence: `write op=bootstrap` completed; audit passed.",
      ].join("\n"),
Systems: "",
    },
  },

  // ── MOC ───────────────────────────────────────────────────────────────────
  {
    path: "moc/project-home",
    title: "project-home",
    fm: {
      title: "project-home",
      type: "moc",
      status: "seedling",
      created: new Date().toISOString().slice(0, 10),
      updated: new Date().toISOString().slice(0, 10),
      tags: ["meta/project-home"],
    },
    sec: {
      Purpose:
        "- Curated entry point for optional project reference notes.",
      Notes: [
        "- _Add module notes here as you create them: [[module/<name>]]_",
        "- _Add architecture notes here as you create them: [[architecture/<name>]]_",
        "- _Add active task notes here as you create them: [[task/todo-<goal>]]_",
        "",
        "Universal atomic notes live in `~/notes/atomic/` and are reachable as `[[Title]]` from anywhere.",
      ].join("\n"),
    },
  },
]
