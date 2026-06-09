// prompt-loader.ts — load local agent cards from src/agent/prompts/<name>.md.
//
// Contract: project/software/opencode/specification/contract/agent-card-schema.
// ADR:      project/software/opencode/decision/agent-as-vault-card.
//
// Loader = pure: reads + validates cards, returns merge-ready records.
// Bundled generated prompts are the runtime source of truth. Tests and prompt
// tooling may pass an explicit sourceRoot to validate markdown files directly.
//
// Validation rules 1–12 from § "Validation rules (loader-rejected)" in D2.
// Bad card → excluded + warning + error record returned. ¬ throws.
// Cards starting with `_` are skipped.

import path from "path"
import matter from "gray-matter"
import { promises as fs } from "fs"
import { ConfigMarkdown } from "@/config/markdown"
import { Permission } from "@/permission"
import { Log } from "@/foundation/util/log"
import { Glob } from "@/foundation/util/glob"
import { EMBEDDED_AGENT_PROMPTS } from "@/agent/agent-prompts.gen"

export namespace AgentPromptLoader {
  const log = Log.create({ service: "agent-prompt-loader" })

  // Tier-2 catalog (Rule 5 — illegal_spawn) is now derived dynamically from
  // the set of cards with tier="2" discovered during loadAgentCards().
  // No hardcoded spawn catalog: the loaded prompt cards are the source of truth.
  // See § "Two-pass load" in loadAgentCards() below.

  // Known phase keys from taskNoteSeed() / D1 § "Phase ownership". Rule 8 (unknown_phase).
  export const KNOWN_PHASES = new Set([
    "Plan",
    "Root cause",
    "Design",
    "Contract",
    "Spec",
    "Implement",
    "Test Strategy",
    "Verification",
    "Rethink & Redesign",
    "Research",
    "Notes",
  ])

  export const REQUIRED_AGENT_NAMES = new Set([
    "orchestrator",
    "planner",
    "implementer",
    "adviser",
    "searcher",
    "worker",
    "user-proxy",
    "title",
    "compaction",
    "halt-auditor",
  ])

  export type RegistryHealthCode = "loader_error" | "missing_required_agent"

  export interface RegistryHealthIssue {
    code: RegistryHealthCode
    file?: string
    agent?: string
    message: string
  }

  export type ErrorCode =
    | "invalid_tier"
    | "duplicate_tier0"
    | "mode_mismatch"
    | "tier2_misconfig"
    | "illegal_spawn"
    | "bad_permission"
    | "bad_model"
    | "unknown_phase"
    | "missing_include"
    | "empty_prompt"
    | "bad_sections"
    | "name_mismatch"
    | "parse_error"

  export interface ValidationError {
    file: string
    code: ErrorCode
    message: string
  }

  // Loader-produced card. Subset of Agent.Info sourced from a markdown prompt card
  // markdown file. agent.ts merges these onto the in-code defaults so any field
  // omitted by the card retains its built-in value (description, native flag, …).
  export interface Card {
    name: string
    file: string
    tier: "0" | "1" | "2"
    /**
     * Model capability tier for routing. Derived from the card's `tier` field:
     *   "0" → "tier0", "1" → "tier1", "2" → "tier2"
     * Used by ModelRouter to select candidates from cfg.provider[id].models[model].tier.
     * Active model IDs are resolved from opencode.json, not prompt cards.
     */
    modelTier: "tier0" | "tier1" | "tier2"
    mode: "primary" | "subagent" | "all"
    hidden?: boolean
    native?: boolean
    description?: string
    permissionConfig?: Record<string, unknown>
    /** Composed system prompt: base shared block + tier shared block + card body's "## System prompt" section. */
    prompt: string
  }

  export interface LoadResult {
    cards: Record<string, Card>
    errors: ValidationError[]
    /**
     * Tier index built from successfully-loaded cards. Source of truth for any
     * runtime gate that previously hardcoded agent names (e.g. tier-2 spawn
     * allow-list, tier-0 default-agent lookup). Always present; empty Sets when
     * the prompt source has no cards in that tier.
     */
    tiers: { "0": Set<string>; "1": Set<string>; "2": Set<string> }
  }

  type PendingCard = {
    file: string
    base: string
    data: Record<string, unknown>
    body: string
    tier: "0" | "1" | "2"
  }

  const modelTierMap: Record<"0" | "1" | "2", "tier0" | "tier1" | "tier2"> = {
    "0": "tier0",
    "1": "tier1",
    "2": "tier2",
  }

  /**
   * Parse the card body and extract a named `## <heading>` section's content (without heading).
   *
   * Boundary rule (per `specification/contract/agent-card-schema` § Section extraction algorithm):
   * a `## Foo` section runs from the line after the matching heading until the next `## `
   * heading or EOF. H1 (`# `) and H3+ (`### `) inside the body are CONTENT, not terminators.
   *
   * Cards organize their `## System prompt` body with `### Sub-heading` subsections. H1
   * remains content for extraction compatibility, but validation rejects H1 inside prompt
   * cards so the contract stays visually consistent. Earlier impl treated H1 as a
   * terminator (`/^#{1,2}\s+\S/m`), silently truncating 70-96% of every card.
   *
   * @returns trimmed body string, or `""` for present-but-empty section, or `null` when absent.
   */
  export function extractSection(body: string, heading: string): string | null {
    const re = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*$`, "im")
    const m = body.match(re)
    if (!m) return null
    const start = m.index! + m[0].length
    // Stop at the next H2 outside fenced code blocks. H1 / H3+ and fenced
    // markdown examples are content per agent-card-schema contract.
    const tail = body.slice(start)
    const lines = tail.split(/(?<=\n)/)
    let offset = 0
    let inFence = false
    for (const line of lines) {
      if (/^```/.test(line.trimStart())) inFence = !inFence
      if (!inFence && /^##\s+\S/m.test(line)) return tail.slice(0, offset).trim()
      offset += line.length
    }
    return tail.trim()
  }

  /**
   * Validate a parsed card. Returns first failing error or null.
   *
   * @param opts.tier2Catalog - Set of tier-2 agent names. When omitted, Rule 5
   *   (illegal_spawn) is skipped — used during pass 1 of the two-pass loader
   *   (see loadAgentCards). When provided, validates tier-1 spawns ⊂ catalog.
   */
  export function validate(opts: {
    file: string
    name: string
    data: Record<string, unknown>
    body: string
    seenTier0: { name: string } | null
    sharedBlocks: Set<string>
    tier1Catalog?: Set<string>
    tier2Catalog?: Set<string>
  }): ValidationError | null {
    const { file, name, data, body, seenTier0, sharedBlocks, tier1Catalog, tier2Catalog } = opts
    const fail = (code: ErrorCode, message: string): ValidationError => ({ file, code, message })

    // Rule 12: agent (frontmatter) ≡ filename stem.
    const agentField = data["agent"]
    if (typeof agentField === "string" && agentField !== name) {
      return fail("name_mismatch", `frontmatter agent="${agentField}" ≠ filename stem "${name}"`)
    }

    // Rule 1: tier ∈ {0,1,2}.
    const tierRaw = data["tier"]
    const tier = typeof tierRaw === "number" ? String(tierRaw) : typeof tierRaw === "string" ? tierRaw : ""
    if (tier !== "0" && tier !== "1" && tier !== "2") {
      return fail("invalid_tier", `tier=${JSON.stringify(tierRaw)} ∉ {0,1,2}`)
    }

    const mode = data["mode"]
    // Rule 2: tier=0 ⇒ singleton (only ONE tier-0 card may exist; name is not
    // hardcoded — any name is permitted so long as no other tier-0 card has
    // been seen yet).
    if (tier === "0") {
      if (seenTier0 && seenTier0.name !== name) {
        return fail("duplicate_tier0", `second tier-0 card "${name}" after "${seenTier0.name}"`)
      }
      // Rule 3: tier=0 ⇒ mode=primary.
      if (mode !== "primary") return fail("mode_mismatch", `tier=0 requires mode=primary, got "${mode}"`)
    }

    // Rule 4: tier=2 ⇒ mode=subagent ∧ spawns=∅.
    if (tier === "2") {
      if (mode !== "subagent" && mode !== "primary") {
        // primary allowed for hidden tier-2 (e.g. compaction/title/halt-auditor/user-proxy);
        // names are not hardcoded — only the (mode=primary ∧ hidden) shape is.
        return fail("tier2_misconfig", `tier=2 requires mode=subagent (or primary+hidden), got "${mode}"`)
      }
      const spawns = data["spawns"]
      if (Array.isArray(spawns) && spawns.length > 0) {
        return fail("tier2_misconfig", `tier=2 must declare spawns=[]; got ${JSON.stringify(spawns)}`)
      }
    }

    // Rule 5a: tier=0 ⇒ spawns ⊂ tier-1 catalog plus direct read-only adviser exception
    // (skipped when catalogs are not supplied during loader pass 1).
    if (tier === "0" && tier1Catalog && tier2Catalog) {
      const spawns = data["spawns"]
      if (Array.isArray(spawns)) {
        for (const s of spawns) {
          const adviserException = s === "adviser" && tier2Catalog.has("adviser")
          if (typeof s !== "string" || (!tier1Catalog.has(s) && !adviserException)) {
            return fail("illegal_spawn", `tier=0 spawns contains "${s}" outside tier-1 catalog/adviser exception`)
          }
        }
      }
    }

    // Rule 5b: tier=1 ⇒ spawns ⊂ tier-2 catalog (skipped when catalog not supplied).
    if (tier === "1" && tier2Catalog) {
      const spawns = data["spawns"]
      if (Array.isArray(spawns)) {
        for (const s of spawns) {
          if (typeof s !== "string" || !tier2Catalog.has(s)) {
            return fail("illegal_spawn", `spawns contains "${s}" ∉ tier-2 catalog`)
          }
        }
      }
    }

    // Rule 6: permission parses through Permission.fromConfig.
    const perm = data["permission"]
    if (perm !== undefined) {
      if (typeof perm !== "object" || perm === null || Array.isArray(perm)) {
        return fail("bad_permission", `permission must be an object`)
      }
      try {
        Permission.fromConfig(perm as never)
      } catch (err) {
        return fail("bad_permission", `Permission.fromConfig threw: ${(err as Error).message}`)
      }
    }

    // Rule 7b: model_tier ∈ {tier0, tier1, tier2} if present.
    const modelTierRaw = data["model_tier"]
    if (modelTierRaw !== undefined) {
      if (modelTierRaw !== "tier0" && modelTierRaw !== "tier1" && modelTierRaw !== "tier2") {
        return fail("bad_model", `model_tier="${modelTierRaw}" ∉ {tier0, tier1, tier2}`)
      }
      const expectedModelTier: Record<"0" | "1" | "2", "tier0" | "tier1" | "tier2"> = {
        "0": "tier0",
        "1": "tier1",
        "2": "tier2",
      }
      if (modelTierRaw !== expectedModelTier[tier]) {
        return fail("bad_model", `model_tier="${modelTierRaw}" inconsistent with tier=${tier}`)
      }
    }

    // Rule 8: phase_ownership ⊂ KNOWN_PHASES.
    const phases = data["phase_ownership"]
    if (Array.isArray(phases)) {
      for (const p of phases) {
        if (typeof p !== "string" || !KNOWN_PHASES.has(p)) {
          return fail("unknown_phase", `phase_ownership contains "${p}" ∉ known phases`)
        }
      }
    }

    // Rule 9: required tier blocks and shared_includes references resolve.
    const requiredSharedBlocks = requiredSharedBlockNames(tier as "0" | "1" | "2")
    for (const blockName of requiredSharedBlocks) {
      if (!sharedBlocks.has(blockName)) {
        return fail("missing_include", `required shared block "${blockName}" — file missing`)
      }
    }

    const includes = data["shared_includes"]
    if (Array.isArray(includes)) {
      for (const inc of includes) {
        if (typeof inc !== "string" || !inc.startsWith("prompt:_shared/")) {
          return fail("missing_include", `shared_includes entry "${inc}" malformed`)
        }
        const blockName = inc.slice("prompt:_shared/".length)
        if (!sharedBlocks.has(blockName)) {
          return fail("missing_include", `shared_includes references "${blockName}" — file missing`)
        }
      }
    }

    // Rule 10: ## System prompt present + non-empty.
    const sysPrompt = extractSection(body, "System prompt")
    if (!sysPrompt || sysPrompt.length === 0) {
      return fail("empty_prompt", `## System prompt section missing or empty`)
    }
    const h1 = findH1Heading(sysPrompt)
    if (h1) {
      return fail("bad_sections", `## System prompt subsections must use ### or deeper headings; got "${h1}"`)
    }

    return null
  }

  function findH1Heading(body: string): string | null {
    let inFence = false
    for (const line of body.split(/\r?\n/)) {
      if (/^```/.test(line.trimStart())) inFence = !inFence
      if (inFence) continue
      if (/^#\s+\S/.test(line)) return line.trim()
    }
    return null
  }

  function requiredSharedBlockNames(tier: "0" | "1" | "2"): string[] {
    if (tier === "1") return ["base", "tier1"]
    if (tier === "2") return ["base", "tier2"]
    return ["base"]
  }

  function normalizeSharedInclude(input: string): string {
    return input.startsWith("prompt:_shared/") ? input.slice("prompt:_shared/".length) : input
  }

  /** Compose final system prompt: base → tier → extra shared_includes → card "## System prompt". */
  export function composePrompt(opts: {
    body: string
    tier: "0" | "1" | "2"
    sharedIncludes: string[]
    sharedBodies: Record<string, string>
  }): string {
    const parts: string[] = []
    const seen = new Set<string>()
    const includeNames = [
      ...requiredSharedBlockNames(opts.tier),
      ...opts.sharedIncludes.map(normalizeSharedInclude),
    ].filter((name) => {
      if (seen.has(name)) return false
      seen.add(name)
      return true
    })

    for (const name of includeNames) {
      const block = opts.sharedBodies[name]
      if (block) parts.push(block)
    }
    const sys = extractSection(opts.body, "System prompt")
    if (sys) parts.push(sys)
    return parts.join("\n\n")
  }

  function validatePendingCardsPassTwo(opts: {
    pending: PendingCard[]
    errors: ValidationError[]
    tiers: LoadResult["tiers"]
    sharedBlocks: Set<string>
    logMessage: string
  }) {
    const tier1Catalog = opts.tiers["1"]
    const tier2Catalog = opts.tiers["2"]
    const survivors: PendingCard[] = []

    for (const card of opts.pending) {
      if (card.tier === "0" || card.tier === "1") {
        const err = validate({
          file: card.file,
          name: card.base,
          data: card.data,
          body: card.body,
          seenTier0: null,
          sharedBlocks: opts.sharedBlocks,
          tier1Catalog,
          tier2Catalog,
        })
        if (err) {
          log.warn(opts.logMessage, { file: card.file, code: err.code, message: err.message })
          opts.errors.push(err)
          opts.tiers[card.tier].delete(card.base)
          continue
        }
      }
      survivors.push(card)
    }

    return survivors
  }

  function materializeCards(cards: Record<string, Card>, pending: PendingCard[], sharedBodies: Record<string, string>) {
    for (const card of pending) {
      const includes = Array.isArray(card.data["shared_includes"]) ? (card.data["shared_includes"] as string[]) : []
      const prompt = composePrompt({ body: card.body, tier: card.tier, sharedIncludes: includes, sharedBodies })

      cards[card.base] = {
        name: card.base,
        file: card.file,
        tier: card.tier,
        modelTier: modelTierMap[card.tier],
        mode: card.data["mode"] as Card["mode"],
        hidden: typeof card.data["hidden"] === "boolean" ? (card.data["hidden"] as boolean) : undefined,
        native: typeof card.data["native"] === "boolean" ? (card.data["native"] as boolean) : true,
        description: typeof card.data["description"] === "string" ? (card.data["description"] as string) : undefined,
        permissionConfig:
          typeof card.data["permission"] === "object" && card.data["permission"] !== null
            ? (card.data["permission"] as Record<string, unknown>)
            : undefined,
        prompt,
      }
    }
  }

  function resolveAgentPromptDir(sourceRoot: string): string {
    return sourceRoot
  }

  function resolveSharedPromptDir(sourceRoot: string): string {
    return path.join(resolveAgentPromptDir(sourceRoot), "_shared")
  }

  /** Read all _shared/<name>.md ## System prompt sections into a map. */
  async function loadSharedBlocks(sourceRoot: string): Promise<{
    bodies: Record<string, string>
    available: Set<string>
  }> {
    const dir = resolveSharedPromptDir(sourceRoot)
    const bodies: Record<string, string> = {}
    const available = new Set<string>()
    let entries: string[] = []
    try {
      entries = await fs.readdir(dir)
    } catch {
      return { bodies, available }
    }
    for (const f of entries) {
      if (!f.endsWith(".md")) continue
      const name = f.slice(0, -3)
      try {
        const md = await ConfigMarkdown.parse(path.join(dir, f))
        const body = extractSection(md.content, "System prompt")
        if (body && body.length > 0) {
          bodies[name] = body
          available.add(name)
        }
      } catch (err) {
        log.warn("failed to parse shared block", { file: f, err: (err as Error).message })
      }
    }
    return { bodies, available }
  }

  function loadEmbeddedSharedBlocks(embedded: Record<string, string>) {
    const bodies: Record<string, string> = {}
    const available = new Set<string>()

    for (const [rel, content] of Object.entries(embedded)) {
      if (!rel.startsWith("_shared/") || !rel.endsWith(".md")) continue
      const name = path.basename(rel, ".md")
      const section = extractSection(content, "System prompt")
      if (section) {
        bodies[name] = section.trim()
        available.add(name)
      }
    }

    return { bodies, available }
  }

  function recordPendingCard(opts: {
    pending: PendingCard[]
    errors: ValidationError[]
    tiers: LoadResult["tiers"]
    sharedBlocks: Set<string>
    seenTier0: { name: string } | null
    rejectLogMessage: string
    file: string
    base: string
    data: Record<string, unknown>
    body: string
  }) {
    const err = validate({
      file: opts.file,
      name: opts.base,
      data: opts.data,
      body: opts.body,
      seenTier0: opts.seenTier0,
      sharedBlocks: opts.sharedBlocks,
    })
    if (err) {
      log.warn(opts.rejectLogMessage, { file: opts.file, code: err.code, message: err.message })
      opts.errors.push(err)
      return opts.seenTier0
    }

    const tier = String(opts.data["tier"]) as "0" | "1" | "2"
    opts.tiers[tier].add(opts.base)
    opts.pending.push({ file: opts.file, base: opts.base, data: opts.data, body: opts.body, tier })
    return tier === "0" ? { name: opts.base } : opts.seenTier0
  }

  function parseEmbeddedCard(rel: string, content: string, errors: ValidationError[]) {
    try {
      const result = matter(content)
      return { data: (result.data ?? {}) as Record<string, unknown>, body: result.content ?? "" }
    } catch (err) {
      errors.push({ file: rel, code: "parse_error", message: `frontmatter parse failed: ${(err as Error).message}` })
      return undefined
    }
  }

  function collectEmbeddedPendingCards(opts: {
    embedded: Record<string, string>
    errors: ValidationError[]
    tiers: LoadResult["tiers"]
    sharedBlocks: Set<string>
  }) {
    const pending: PendingCard[] = []
    let seenTier0: { name: string } | null = null

    for (const [rel, content] of Object.entries(opts.embedded)) {
      if (rel.startsWith("_shared/") || !rel.endsWith(".md")) continue
      const base = path.basename(rel, ".md")
      if (base.startsWith("_")) continue

      const parsed = parseEmbeddedCard(rel, content, opts.errors)
      if (!parsed) continue
      seenTier0 = recordPendingCard({
        pending,
        errors: opts.errors,
        tiers: opts.tiers,
        sharedBlocks: opts.sharedBlocks,
        seenTier0,
        rejectLogMessage: "embedded agent card rejected",
        file: rel,
        base,
        data: parsed.data,
        body: parsed.body,
      })
    }

    return pending
  }

  async function collectFilePendingCards(opts: {
    files: string[]
    errors: ValidationError[]
    tiers: LoadResult["tiers"]
    sharedBlocks: Set<string>
  }) {
    const pending: PendingCard[] = []
    let seenTier0: { name: string } | null = null

    for (const file of opts.files) {
      const base = path.basename(file, ".md")
      if (base.startsWith("_")) continue

      let parsed: Awaited<ReturnType<typeof ConfigMarkdown.parse>>
      try {
        parsed = await ConfigMarkdown.parse(file)
      } catch (err) {
        opts.errors.push({ file, code: "parse_error", message: `frontmatter parse failed: ${(err as Error).message}` })
        continue
      }

      seenTier0 = recordPendingCard({
        pending,
        errors: opts.errors,
        tiers: opts.tiers,
        sharedBlocks: opts.sharedBlocks,
        seenTier0,
        rejectLogMessage: "agent card rejected",
        file,
        base,
        data: (parsed.data ?? {}) as Record<string, unknown>,
        body: parsed.content ?? "",
      })
    }

    return pending
  }

  /** Fallback: load agent cards from the build-time embedded prompt map. */
  async function loadAgentCardsFromEmbedded(
    errors: ValidationError[],
    tiers: { "0": Set<string>; "1": Set<string>; "2": Set<string> },
  ): Promise<LoadResult> {
    const cards: Record<string, Card> = {}
    const embedded = EMBEDDED_AGENT_PROMPTS ?? {}

    if (Object.keys(embedded).length === 0) return { cards, errors, tiers }

    // Build shared blocks from embedded _shared/*.md.
    const { bodies: sharedBodies, available: sharedBlocks } = loadEmbeddedSharedBlocks(embedded)

    // Pass 1: parse + validate top-level cards.
    const pending = collectEmbeddedPendingCards({ embedded, errors, tiers, sharedBlocks })

    // Pass 2: Rule 5 (illegal_spawn) against dynamic tier catalogs.
    const survivors = validatePendingCardsPassTwo({
      pending,
      errors,
      tiers,
      sharedBlocks,
      logMessage: "embedded agent card rejected (pass 2)",
    })

    // Materialise surviving cards.
    materializeCards(cards, survivors, sharedBodies)

    return { cards, errors, tiers }
  }

  /**
   * Load all agent cards from the bundled prompt map by default.
   * Tests and prompt tooling may pass a prompt directory with the same flat layout.
   *
   * Two-pass load (per design choice "Two-pass strict"):
   *   pass 1 — parse + run all per-card rules EXCEPT Rule 5 (illegal_spawn);
   *            collect tier-2 names into the dynamic catalog.
   *   pass 2 — re-validate Rule 5 only for tier-1 cards against the catalog.
   *
   * Why two passes: Rule 5 needs the full set of tier-2 cards before it can
   * decide whether a tier-1 card's spawn target exists. A single forward-only
   * pass would falsely reject tier-1 cards whose tier-2 dependency happens to
   * sit later in directory order. Two passes also cleanly remove the need for
   * a hardcoded TIER2_CATALOG: the catalog IS whatever the prompt cards declare.
   */
  export async function loadAgentCards(sourceRoot?: string): Promise<LoadResult> {
    const cards: Record<string, Card> = {}
    const errors: ValidationError[] = []
    const tiers = {
      "0": new Set<string>(),
      "1": new Set<string>(),
      "2": new Set<string>(),
    }

    if (sourceRoot === undefined) return await loadAgentCardsFromEmbedded(errors, tiers)

    const cardDir = resolveAgentPromptDir(sourceRoot)
    let cardExists = true
    try {
      await fs.access(cardDir)
    } catch {
      cardExists = false
    }
    if (!cardExists) return { cards, errors, tiers }

    const { bodies: sharedBodies, available: sharedBlocks } = await loadSharedBlocks(sourceRoot)

    let files: string[] = []
    try {
      files = await Glob.scan("*.md", { cwd: cardDir, absolute: true, include: "file" })
    } catch (err) {
      log.warn("agent card scan failed", { dir: cardDir, err: (err as Error).message })
      return { cards, errors, tiers }
    }

    // ── Pass 1: parse + validate (Rules 1-12 except Rule 5). ───────────────
    const pending = await collectFilePendingCards({ files, errors, tiers, sharedBlocks })

    // ── Pass 2: Rule 5 (illegal_spawn) against the dynamic tier catalogs. ───
    const survivors = validatePendingCardsPassTwo({
      pending,
      errors,
      tiers,
      sharedBlocks,
      logMessage: "agent card rejected (pass 2)",
    })

    // ── Materialise surviving cards. ───────────────────────────────────────
    materializeCards(cards, survivors, sharedBodies)

    return { cards, errors, tiers }
  }

  export function validateRegistryHealth(
    result: Pick<LoadResult, "cards" | "errors">,
    required = REQUIRED_AGENT_NAMES,
  ): RegistryHealthIssue[] {
    const issues: RegistryHealthIssue[] = []
    for (const err of result.errors) {
      issues.push({ code: "loader_error", file: err.file, message: `${err.code}: ${err.message}` })
    }
    for (const name of required) {
      if (!result.cards[name]) {
        issues.push({
          code: "missing_required_agent",
          agent: name,
          message: `required agent "${name}" was not loaded from local agent prompts`,
        })
      }
    }
    return issues
  }

  export function logRegistryHealthIssues(issues: RegistryHealthIssue[]): void {
    for (const issue of issues) log.warn("agent.registry.health", issue)
  }

  /** Diagnostic: prompt source has zero cards; runtime cannot resolve agent prompts. */
  export function logPromptSourceEmpty(promptRoot: string): void {
    log.error("agent.source.bundled_empty", {
      promptRoot,
      reason: "no agent cards in the bundled prompt map",
      action: "regenerate src/agent/agent-prompts.gen.ts from source prompts with bun run build",
    })
  }

  /** Diagnostic: cfg.agent[name].disable tried to remove a protected tier-0 agent. */
  export function logProtectedAgentDisableIgnored(name: string): void {
    log.warn("agent.config.disable_ignored", {
      name,
      reason: "tier-0 orchestrator is required and cannot be disabled",
      action: "route work through orchestrator; customize its presentation/permissions instead of disabling it",
    })
  }

  /** Diagnostic: cfg.agent[name] references an agent absent from bundled prompts. */
  export function logUnknownConfigAgent(name: string): void {
    log.error("agent.config.unknown", {
      name,
      reason: "cfg.agent[<name>] is modifier-only — bundled prompts must define the agent first",
      action: `add src/agent/prompts/${name}.md and regenerate src/agent/agent-prompts.gen.ts`,
    })
  }
}
