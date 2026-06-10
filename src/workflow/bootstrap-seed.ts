// src/workflow/bootstrap-seed.ts — Stage 1, leaf I1.7.
// -------------------------------------------------------------------------
// Authoritative contract:
//   project/software/opencode/specification/contract/l3-registry.md
//     §degraded-mode-fallback (Bootstrap path: "on first run, if
//     `<vaultRoot>/atomic/<kind>/` is empty AND `cfg.bootstrap.<kind> !==
//     false`, the engine writes seed default files. Subsequent runs see
//     populated vault — no degraded mode.").
//   project/software/opencode/specification/schema/phase-card.md
//   project/software/opencode/architecture/file-loaded-os-roadmap.md
//     §Stage-1 ("Add bootstrap step that seeds default phase/role files
//     on first run if absent.")
//
// Migration safety valve: a brand-new install (or a vault wiped between
// runs) MUST NOT see degraded WARNs forever. On boot, if any of the three
// Stage-1 atomic subtrees is empty, write minimal-but-valid seed cards
// derived from the in-code DEFAULT_*_BINDINGS maps. Each seed card carries
// the exact frontmatter every L3 registry validator demands; users may
// rewrite the body / extend the frontmatter post-seed without breaking
// the registry contract.
//
// Idempotency rule: per L3 §degraded-mode-fallback, "subsequent runs see
// populated vault — no degraded mode". We treat any `.md` file under the
// kind's atomic subtree as proof of seed (or user authorship) and skip.
// Never overwrite. Never delete.
//
// Failure rule: per L3 §degraded-mode-fallback risks table —
// "Bootstrap seed write fails: log error, continue with degraded mode
// (empty registry)". Errors are accumulated in `Stats.errors[]` and
// NEVER thrown. Engine boot survives any seed failure.
//
// Cfg gate: `cfg.bootstrap.<kind> !== false` toggles per-kind. Stage 1
// reads via `OPENCODE_BOOTSTRAP_SEED=0` env (no cfg shape exists yet for
// `bootstrap.*`; cfg-key path lands in Stage 2 alongside the policy
// registry shape).
// -------------------------------------------------------------------------

import path from "path"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "fs"
import { Log } from "@/foundation/util/log"
import { vaultPath } from "@/notes/root"
import { Phase } from "@/workflow/phase"
import { RuntimeRole } from "@/workflow/runtime-role"
import { DispatchReason } from "@/workflow/dispatch-reason"
import { Policy } from "@/permission/policy"

export namespace BootstrapSeed {
  const log = Log.create({ service: "bootstrap-seed" })

  export type Stats = {
    kinds_seeded: string[]
    files_written: number
    files_skipped: number
    errors: string[]
  }

  // ── Per-kind seed catalogues ─────────────────────────────────────────
  //
  // Each entry is the canonical seed shape we want every brand-new vault
  // to have. Keep these synchronised with the in-code DEFAULT_*_BINDINGS
  // in `src/workflow/{phase,runtime-role,dispatch-reason}.ts`. The
  // bootstrap gate test (test/workflow/bootstrap-seed.test.ts) loops the
  // DEFAULT_*_BINDINGS keys and asserts every key has a matching seed
  // entry — drifts in either direction fail the test.
  //
  // NOTE: order values mirror the existing 11 hand-authored seed cards
  // under `<vault>/atomic/workflow/phase/`. They are NOT discoverable
  // from DEFAULT_PHASE_BINDINGS alone (which is a flat Record).

  type PhaseSeed = {
    /** Canonical key from DEFAULT_PHASE_BINDINGS (e.g. "Root cause"). */
    bindingKey: string
    /** Filename stem (kebab). MUST equal `phase` field. */
    stem: string
    order: number
    leaf_type: string
    description: string
    aliases?: string[]
  }

  const PHASE_SEEDS: ReadonlyArray<PhaseSeed> = Object.freeze([
    {
      bindingKey: "Plan",
      stem: "plan",
      order: 1,
      leaf_type: "plan",
      description: "Decompose scope into a tree of leaves; gate spec-readiness.",
    },
    {
      bindingKey: "Research",
      stem: "research",
      order: 2,
      leaf_type: "search",
      description: "Read code and prior notes to build evidence for design.",
    },
    {
      bindingKey: "Root cause",
      stem: "root-cause",
      order: 3,
      leaf_type: "search",
      description: "Locate the source of an observed defect.",
      aliases: ["Root cause", "Root Cause", "root cause"],
    },
    {
      bindingKey: "Design",
      stem: "design",
      order: 4,
      leaf_type: "design",
      description: "Author the architectural shape of a change.",
    },
    {
      bindingKey: "Contract",
      stem: "contract",
      order: 5,
      leaf_type: "contract",
      description: "Author API/wire/schema/protocol contracts.",
    },
    {
      bindingKey: "Spec",
      stem: "spec",
      order: 6,
      leaf_type: "spec",
      description: "Author acceptance specs and test criteria.",
    },
    {
      bindingKey: "Implement",
      stem: "implement",
      order: 7,
      leaf_type: "impl",
      description: "Edit source files to satisfy a contracted leaf.",
    },
    {
      bindingKey: "Rethink & Redesign",
      stem: "rethink",
      order: 8,
      leaf_type: "design",
      description: "Recover from failed verification by redesigning.",
      aliases: ["Rethink & Redesign", "rethink-redesign"],
    },
    {
      bindingKey: "Test Strategy",
      stem: "test-strategy",
      order: 9,
      leaf_type: "test",
      description: "Define adversarial test approach.",
      aliases: ["Test Strategy", "test strategy"],
    },
    {
      bindingKey: "Verification",
      stem: "verification",
      order: 10,
      leaf_type: "verify",
      description: "Acceptance gatekeeper + audit.",
    },
  ])

  type RuntimeRoleSeed = {
    role: string
    consumer: string
    invocation: "sync" | "async" | "effect-async"
    description: string
    tags?: string[]
  }

  const RUNTIME_ROLE_SEEDS: ReadonlyArray<RuntimeRoleSeed> = Object.freeze([
    {
      role: "compaction",
      consumer: "src/session/compaction.ts",
      invocation: "effect-async",
      description: "Conversation compaction subsystem.",
    },
    {
      role: "user-proxy",
      consumer: "src/session/prompt.ts",
      invocation: "async",
      description: "Headless blocker resolver for autonomous loop sessions.",
      tags: ["runtime-role/loop"],
    },
    {
      role: "halt-auditor",
      consumer: "src/session/prompt.ts",
      invocation: "async",
      description: "Loop-session halt arbiter.",
      tags: ["runtime-role/loop"],
    },
    {
      role: "title",
      consumer: "src/session/prompt.ts",
      invocation: "effect-async",
      description: "Session-title generator.",
    },
    {
      role: "adviser",
      consumer: "src/process/session/prompt.ts",
      invocation: "async",
      description: "Read-only advisory leaf for tradeoffs, risk review, and unblock recommendations.",
    },
  ])

  type ReasonSeed = {
    reason: string
    trigger: string
    description: string
    tags?: string[]
  }

  const REASON_SEEDS: ReadonlyArray<ReasonSeed> = Object.freeze([
    {
      reason: "default-fallback",
      trigger: "working-memory signal carries no `suggested_agent`",
      description: "Catch-all dispatch handler.",
    },
    {
      reason: "missing-discovery",
      trigger: "design-phase todo activates without upstream research evidence",
      description: "Forces searcher dispatch when planner lacks evidence.",
    },
    {
      reason: "pending-dispatch",
      trigger: "dispatch queue entry has no explicit `agent` field",
      description: "Default planner dispatch for unrouted queue entries.",
    },
    {
      reason: "failed-progress",
      trigger: "Progress section contains failed/blocked entries",
      description: "Loop back to planner after failure.",
      tags: ["dispatch-reason/loop-back"],
    },
    {
      reason: "open-questions",
      trigger: "Gaps section non-empty",
      description: "Loop back to planner to resolve unresolved gaps/blockers.",
      tags: ["dispatch-reason/loop-back"],
    },
    {
      reason: "phase-gate-verify",
      trigger: "phase todo `[x]` without sibling `[verify]` leaf",
      description: "Validation gate before phase advancement.",
      tags: ["dispatch-reason/gate"],
    },
  ])

  // ── Renderers ────────────────────────────────────────────────────────

  function fmYaml(record: Record<string, string | number | string[] | undefined>): string {
    const lines: string[] = []
    for (const [k, v] of Object.entries(record)) {
      if (v === undefined) continue
      if (Array.isArray(v)) {
        if (v.length === 0) continue
        lines.push(`${k}: [${v.map((x) => JSON.stringify(x)).join(", ")}]`)
      } else if (typeof v === "string") {
        // Quote when YAML disambiguation requires it. Conservative rules:
        //   - leading char is a YAML flow/block indicator (`-`, `?`, `:`,
        //     `,`, `[`, `]`, `{`, `}`, `#`, `&`, `*`, `!`, `|`, `>`, `'`,
        //     `"`, `%`, `@`, `` ` ``, whitespace)
        //   - contains `: ` (mapping ambiguity) or ` #` (comment marker)
        //   - contains a control char (tab/newline/CR)
        //   - trailing whitespace
        // Mid-string hyphen / colon-without-space are OK unquoted (e.g.
        // "root-cause", "https://example"); we keep these unquoted to
        // avoid noise in the seed output that would leak into test
        // regexes downstream.
        const needsQuote =
          /^[-?:,\[\]\{\}#&*!|>'"%@`\s]/.test(v) ||
          /: |\s#/.test(v) ||
          /[\t\n\r]/.test(v) ||
          /\s$/.test(v) ||
          v.length === 0
        lines.push(`${k}: ${needsQuote ? JSON.stringify(v) : v}`)
      } else {
        lines.push(`${k}: ${v}`)
      }
    }
    return lines.join("\n")
  }

  function renderPhaseCard(seed: PhaseSeed, defaultOwner: string): string {
    // Aliases must always include the canonical bindingKey (PascalCase /
    // space-bearing form from DEFAULT_PHASE_BINDINGS) when the stem is
    // kebab-cased — otherwise the resolvers primary call shape (the
    // Phase.get(<PascalCase>) form using PHASE_DEFAULTS keys) cannot
    // resolve a card whose phase field is the kebab-stem. T.3 round-trip
    // caught this gap: 8 of 11 seed cards previously had no aliases, so
    // post-seed Phase.get(legacy PascalCase key) returned undefined
    // despite the card being present. (Apostrophe-free comment per
    // V.2f stripComments tokenizer rules — single-quote strings span
    // multiple lines until the next single-quote, so a stray apostrophe
    // would leak quoted-phase-literal hits across the comment block.)
    const aliasSet = new Set<string>([
      ...(seed.aliases ?? []),
      ...(seed.bindingKey !== seed.stem ? [seed.bindingKey] : []),
    ])
    const aliases = aliasSet.size > 0 ? Array.from(aliasSet) : undefined

    const fm = fmYaml({
      phase: seed.stem,
      order: seed.order,
      default_owner: defaultOwner,
      section_ownership: [seed.bindingKey],
      allowed_leaf_types: [seed.leaf_type],
      description: seed.description,
      aliases,
      tags: ["phase/core"],
    })
    return `---
${fm}
---

# ${seed.stem}

## Purpose

${seed.description}

This card was written by the engine bootstrap on first run. Replace this
prose with project-specific guidance — the registry only cares about the
frontmatter above.

## Owner contract

- \`default_owner: ${defaultOwner}\`
- Override path: \`cfg.dispatch_roles.phase["${seed.bindingKey}"]\`
`
  }

  function renderReasonCard(seed: ReasonSeed, defaultHandler: string): string {
    const fm = fmYaml({
      reason: seed.reason,
      default_handler: defaultHandler,
      trigger: seed.trigger,
      override_path: `cfg.dispatch_reasons.${seed.reason}`,
      description: seed.description,
      tags: seed.tags ?? ["dispatch-reason/core"],
    })
    return `---
${fm}
---

# ${seed.reason}

## Purpose

${seed.description}

Bootstrap-seeded card. Edit body freely; registry validates frontmatter only.
`
  }

  function renderRuntimeRoleCard(seed: RuntimeRoleSeed, defaultAgent: string): string {
    const fm = fmYaml({
      role: seed.role,
      default_agent: defaultAgent,
      consumer: seed.consumer,
      invocation: seed.invocation,
      override_path: `cfg.runtime_roles.${seed.role}`,
      description: seed.description,
      tags: seed.tags ?? ["runtime-role/core"],
    })
    return `---
${fm}
---

# ${seed.role}

## Purpose

${seed.description}

Bootstrap-seeded card. Edit body freely; registry validates frontmatter only.
`
  }

  // ── Policy seed catalogue (I2.7 — Stage 2) ──────────────────────────
  //
  // Policy cards are seeded one-per-domain from `Policy.DEFAULT_POLICY_VALUES`.
  // Catalogue is *derived* from the registry's defaults map (not duplicated)
  // so the bootstrap-vs-registry drift test is automatic — adding a new
  // domain to the registry seeds it on next boot without any change here.
  //
  // The render path differs from phase/runtime-role/dispatch-reason because
  // policy cards have a nested `values:` block in frontmatter; the existing
  // `fmYaml` renderer is flat. We emit the nested values explicitly.

  type PolicySeed = {
    domain: Policy.Domain
    description: string
  }

  const POLICY_SEED_DESCRIPTIONS: Readonly<Record<Policy.Domain, string>> = Object.freeze({
    compaction: "Auto-compaction trigger thresholds and summary targets.",
    "context-packet": "Per-tier limits for the Plan/Progress/excerpt context packet.",
    scheduler: "Concurrency caps and dedup-window for the dispatch scheduler.",
    budget: "Default per-task token budget — soft (warn) and hard (refuse).",
    "bg-task": "Background-task TTL and cleanup window.",
    retrieval: "Persistent-memory retrieval scoring weights (Stage 4 consumer).",
    predicate: "Default per-predicate timeout for archive/verify gates (Stage 3).",
    delegation: "Provider IDs allowed for subagent delegation. Stage 7.2 — qpilot/qgenie only.",
  })

  function policySeedCatalogue(): ReadonlyArray<PolicySeed> {
    return (Object.keys(Policy.DEFAULT_POLICY_VALUES) as Policy.Domain[]).map((domain) => ({
      domain,
      description: POLICY_SEED_DESCRIPTIONS[domain],
    }))
  }

  /**
   * Render a nested `values:` YAML block. Policy values are scalars (numbers
   * + booleans) keyed by string; recursion not needed.
   */
  function renderPolicyValues(values: Record<string, unknown>): string {
    const lines: string[] = []
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) continue
      if (typeof v === "number" || typeof v === "boolean") {
        lines.push(`  ${k}: ${v}`)
      } else if (typeof v === "string") {
        lines.push(`  ${k}: ${JSON.stringify(v)}`)
      }
      // arrays / nested objects: out-of-scope for Stage 2 policy values
    }
    return lines.join("\n")
  }

  function renderPolicyCard(seed: PolicySeed): string {
    const values = Policy.DEFAULT_POLICY_VALUES[seed.domain] as Record<string, unknown>
    const valuesYaml = renderPolicyValues(values)
    const fmHead = fmYaml({
      domain: seed.domain,
      version: "1.0.0",
      description: seed.description,
      tags: ["policy/core"],
    })
    return `---
${fmHead}
values:
${valuesYaml}
---

# ${seed.domain}

## Purpose

${seed.description}

Bootstrap-seeded card. Edit the \`values:\` block to override engine
defaults; the registry validates per-key and falls back to the in-code
default for any missing/invalid key (per-key fallback per
\`policy-card §validation-rules\` rule 3).

## Cross-references

- [[../../../project/software/opencode/specification/schema/policy-card]]
- [[../../../project/software/opencode/specification/contract/l3-registry]]
`
  }

  // ── Per-kind dispatch ────────────────────────────────────────────────

  type Kind = "phase" | "runtime-role" | "dispatch-reason" | "policy"

  function vaultDirFor(kind: Kind): string {
    switch (kind) {
      case "phase":
        return vaultPath.atomic("workflow", "phase")
      case "runtime-role":
        return vaultPath.atomic("runtime-role")
      case "dispatch-reason":
        return vaultPath.atomic("workflow", "dispatch-reason")
      case "policy":
        return vaultPath.atomic("policy")
    }
  }

  /** True when the kind's atomic subtree already has at least one .md file. */
  function isAlreadyPopulated(kind: Kind): boolean {
    const dir = vaultDirFor(kind)
    if (!existsSync(dir)) return false
    try {
      return readdirSync(dir).some((n) => n.endsWith(".md"))
    } catch {
      // I/O failure on the readdir — treat as populated to avoid clobbering
      // a vault we couldn't fully inspect.
      return true
    }
  }

  function seedPhase(stats: Stats): void {
    const dir = vaultDirFor("phase")
    mkdirSync(dir, { recursive: true })
    for (const seed of PHASE_SEEDS) {
      const owner = Phase.DEFAULT_PHASE_BINDINGS[seed.bindingKey]
      if (!owner) {
        // Drift: bindingKey not present in DEFAULT_PHASE_BINDINGS. Don't
        // write; surface as error so a future maintainer notices.
        stats.errors.push(`phase seed drift: bindingKey "${seed.bindingKey}" missing from DEFAULT_PHASE_BINDINGS`)
        continue
      }
      const target = path.join(dir, `${seed.stem}.md`)
      if (existsSync(target)) {
        stats.files_skipped += 1
        continue
      }
      try {
        writeFileSync(target, renderPhaseCard(seed, owner), { encoding: "utf-8", flag: "wx" })
        stats.files_written += 1
      } catch (err) {
        // EEXIST race or permission denied — record + continue.
        stats.errors.push(`phase seed write failed (${target}): ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  function seedRuntimeRole(stats: Stats): void {
    const dir = vaultDirFor("runtime-role")
    mkdirSync(dir, { recursive: true })
    for (const seed of RUNTIME_ROLE_SEEDS) {
      const agent = RuntimeRole.DEFAULT_RUNTIME_ROLE_BINDINGS[seed.role]
      if (!agent) {
        stats.errors.push(`runtime-role seed drift: role "${seed.role}" missing from DEFAULT_RUNTIME_ROLE_BINDINGS`)
        continue
      }
      const target = path.join(dir, `${seed.role}.md`)
      if (existsSync(target)) {
        stats.files_skipped += 1
        continue
      }
      try {
        writeFileSync(target, renderRuntimeRoleCard(seed, agent), { encoding: "utf-8", flag: "wx" })
        stats.files_written += 1
      } catch (err) {
        stats.errors.push(
          `runtime-role seed write failed (${target}): ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
  }

  function seedPolicy(stats: Stats): void {
    const dir = vaultDirFor("policy")
    mkdirSync(dir, { recursive: true })
    for (const seed of policySeedCatalogue()) {
      const target = path.join(dir, `${seed.domain}.md`)
      if (existsSync(target)) {
        stats.files_skipped += 1
        continue
      }
      try {
        writeFileSync(target, renderPolicyCard(seed), { encoding: "utf-8", flag: "wx" })
        stats.files_written += 1
      } catch (err) {
        stats.errors.push(`policy seed write failed (${target}): ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  function seedDispatchReason(stats: Stats): void {
    const dir = vaultDirFor("dispatch-reason")
    mkdirSync(dir, { recursive: true })
    for (const seed of REASON_SEEDS) {
      const handler = DispatchReason.DEFAULT_REASON_BINDINGS[seed.reason]
      if (!handler) {
        stats.errors.push(`dispatch-reason seed drift: reason "${seed.reason}" missing from DEFAULT_REASON_BINDINGS`)
        continue
      }
      const target = path.join(dir, `${seed.reason}.md`)
      if (existsSync(target)) {
        stats.files_skipped += 1
        continue
      }
      try {
        writeFileSync(target, renderReasonCard(seed, handler), { encoding: "utf-8", flag: "wx" })
        stats.files_written += 1
      } catch (err) {
        stats.errors.push(
          `dispatch-reason seed write failed (${target}): ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
  }

  // ── Public entry point ───────────────────────────────────────────────

  /**
   * Read the cfg.bootstrap.<kind> gate. Stage 1 implements only the env
   * fallback; the cfg key path lands in Stage 2 alongside the policy
   * registry shape. `OPENCODE_BOOTSTRAP_SEED=0` disables all kinds at
   * once. Future: per-kind env (e.g. `OPENCODE_BOOTSTRAP_SEED_PHASE=0`).
   */
  function gateAllowsSeed(): boolean {
    const env = process.env.OPENCODE_BOOTSTRAP_SEED?.trim()
    if (env === "0" || env === "false" || env === "no") return false
    return true
  }

  export async function run(): Promise<Stats> {
    const stats: Stats = {
      kinds_seeded: [],
      files_written: 0,
      files_skipped: 0,
      errors: [],
    }

    if (!gateAllowsSeed()) {
      log.info("seed.disabled", { gate: "OPENCODE_BOOTSTRAP_SEED" })
      return stats
    }

    const before = stats.files_written
    if (!isAlreadyPopulated("phase")) {
      try {
        seedPhase(stats)
        if (stats.files_written > before) stats.kinds_seeded.push("phase")
      } catch (err) {
        stats.errors.push(`phase seed pass crashed: ${err instanceof Error ? err.message : String(err)}`)
      }
    } else {
      stats.files_skipped += PHASE_SEEDS.length
    }

    const beforeRr = stats.files_written
    if (!isAlreadyPopulated("runtime-role")) {
      try {
        seedRuntimeRole(stats)
        if (stats.files_written > beforeRr) stats.kinds_seeded.push("runtime-role")
      } catch (err) {
        stats.errors.push(`runtime-role seed pass crashed: ${err instanceof Error ? err.message : String(err)}`)
      }
    } else {
      stats.files_skipped += RUNTIME_ROLE_SEEDS.length
    }

    const beforeDr = stats.files_written
    if (!isAlreadyPopulated("dispatch-reason")) {
      try {
        seedDispatchReason(stats)
        if (stats.files_written > beforeDr) stats.kinds_seeded.push("dispatch-reason")
      } catch (err) {
        stats.errors.push(`dispatch-reason seed pass crashed: ${err instanceof Error ? err.message : String(err)}`)
      }
    } else {
      stats.files_skipped += REASON_SEEDS.length
    }

    const beforePol = stats.files_written
    if (!isAlreadyPopulated("policy")) {
      try {
        seedPolicy(stats)
        if (stats.files_written > beforePol) stats.kinds_seeded.push("policy")
      } catch (err) {
        stats.errors.push(`policy seed pass crashed: ${err instanceof Error ? err.message : String(err)}`)
      }
    } else {
      stats.files_skipped += policySeedCatalogue().length
    }

    return stats
  }

  /** @internal — test inspection of the seed catalogues. */
  export const _internals = Object.freeze({
    PHASE_SEEDS,
    RUNTIME_ROLE_SEEDS,
    REASON_SEEDS,
    policySeedCatalogue,
    vaultDirFor,
    isAlreadyPopulated,
  })
}
