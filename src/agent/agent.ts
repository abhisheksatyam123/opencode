import { Config } from "@/config/config"
import z from "zod"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { generateObject, streamObject, type ModelMessage } from "ai"
import { Truncate } from "@/tool/truncate"
import { Auth } from "@/init/auth"
import { ProviderTransform } from "@/provider/transform"
import { registerAgentCatalogBridge } from "@/permission/policy/agent-catalog"
import { Permission } from "@/permission"
import { mergeDeep, pipe, sortBy, values } from "remeda"
import path from "path"
import { AgentPromptLoader } from "@/agent/prompt-loader"
import { EMBEDDED_AGENT_PROMPTS } from "@/agent/agent-prompts.gen"
import { vaultPath } from "@/notes/root"
import { Effect, ServiceMap, Layer } from "effect"
import { InstanceState } from "@/foundation/effect/instance-state"
import { makeRuntime } from "@/foundation/effect/run-service"
import { Instance } from "@/config/project/instance"

export namespace Agent {
  async function loadGeneratePrompt(): Promise<string> {
    const content = EMBEDDED_AGENT_PROMPTS["_shared/generate.md"]
    const body = content ? AgentPromptLoader.extractSection(content, "System prompt")?.trim() : undefined
    if (!body) throw new Error("missing bundled agent prompt: _shared/generate.md ## System prompt")
    return body
  }

  export const Info = z
    .object({
      name: z.string(),
      description: z.string().optional(),
      mode: z.enum(["subagent", "primary", "all"]),
      native: z.boolean().optional(),
      hidden: z.boolean().optional(),
      tier: z
        .enum(["0", "1", "2"])
        .describe(
          "Delegation tier. 0=orchestrator (delegates only to tier-1), 1=goal agents (spawns tier-2), 2=skill agents (no spawning).",
        ),
      /**
       * Model capability tier for routing. Derived from the card's `tier` field.
       * Used by ModelRouter.select({ agentTier }) to pick candidates from
       * cfg.provider[providerID].models[modelID].tier.
       */
      modelTier: z
        .enum(["tier0", "tier1", "tier2"])
        .optional()
        .describe("Model routing tier. tier0=highest capability, tier1=delivery, tier2=cheap/fast."),
      topP: z.number().optional(),
      temperature: z.number().optional(),
      color: z.string().optional(),
      permission: z.lazy(() => Permission.Ruleset),
      model: z
        .object({
          modelID: ModelID.zod,
          providerID: ProviderID.zod,
        })
        .optional(),
      models: z
        .array(z.object({ modelID: ModelID.zod, providerID: ProviderID.zod }))
        .optional()
        .describe("Ordered fallback list; index 0 is primary"),
      variant: z.string().optional(),
      prompt: z.string().optional(),
      options: z.record(z.string(), z.any()),
      steps: z.number().int().positive().optional(),
    })
    .meta({
      ref: "Agent",
    })
  export type Info = z.infer<typeof Info>

  export interface Interface {
    readonly get: (agent: string) => Effect.Effect<Agent.Info>
    readonly list: () => Effect.Effect<Agent.Info[]>
    readonly defaultAgent: () => Effect.Effect<string>
    readonly generate: (input: {
      description: string
      model?: { providerID: ProviderID; modelID: ModelID }
    }) => Effect.Effect<{
      identifier: string
      whenToUse: string
      systemPrompt: string
    }>
  }

  type State = Omit<Interface, "generate">

  /**
   * Apply user-config modifiers (`cfg.agent[*]`) over local prompt cards.
   *
   * Mutates `agents` in place:
   *   - `disable: true`         → delete record
   *   - unknown name            → log + skip (modifier-only; local prompts define registry)
   *   - known name            → field-by-field overlay (presentation/runtime knobs + permission)
   *
   * Prompt/model/tier fields (prompt, model, models, model_tier, routing_profile, variant)
   * are intentionally NOT applied here — local prompt cards are the sole source of agent system prompts
   * and model policy.
   */
  function applyConfigOverlay(agents: Record<string, Info>, modifiers: Record<string, any>): void {
    for (const [key, value] of Object.entries(modifiers)) {
      if (value?.disable) {
        const item = agents[key]
        if (key === "orchestrator" || item?.tier === "0") {
          AgentPromptLoader.logProtectedAgentDisableIgnored(key)
          continue
        }
        delete agents[key]
        continue
      }
      const item = agents[key]
      if (!item) {
        AgentPromptLoader.logUnknownConfigAgent(key)
        continue
      }

      item.description = value.description ?? item.description
      item.temperature = value.temperature ?? item.temperature
      item.topP = value.top_p ?? item.topP
      item.mode = value.mode ?? item.mode
      item.color = value.color ?? item.color
      item.hidden = value.hidden ?? item.hidden
      item.name = value.name ?? item.name
      item.steps = value.steps ?? item.steps
      item.options = mergeDeep(item.options, value.options ?? {})
      item.permission = Permission.merge(item.permission, Permission.fromConfig(value.permission ?? {}))
    }
  }

  function cloneAgent(base: Info, name: string): Info {
    return {
      ...base,
      name,
      model: base.model
        ? {
            providerID: base.model.providerID,
            modelID: base.model.modelID,
          }
        : undefined,
      models: base.models?.map((m) => ({
        providerID: m.providerID,
        modelID: m.modelID,
      })),
      permission: [...base.permission],
      options: { ...(base.options ?? {}) },
    }
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/Agent") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const config = yield* Config.Service
      const auth = yield* Auth.Service
      const provider = yield* Provider.Service

      const state = yield* InstanceState.make<State>(
        Effect.fn("Agent.state")(function* (ctx) {
          const cfg = yield* config.get()
          const whitelistedDirs = [Truncate.GLOB]

          const defaults = Permission.fromConfig({
            "*": "allow",
            doom_loop: "ask",
            external_directory: {
              "*": "ask",
              ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
            },
          })

          // ── Kernel-subtree write protection (vault-as-sole-filesystem §I4 + §P4) ──
          // Default-deny userland writes/edits into engine-only vault subtrees:
          //   <root>/etc/    config (engine + first-run migration only)
          //   <root>/cache/  regenerable downloads (engine only)
          //   <root>/state/  runtime-derived (session DB, durable-note ledger)
          //   <root>/log/    append-only logs (engine only)
          //   <root>/tmp/    engine scratch (auto-cleaned)
          // Patterns use single-`*` because Wildcard.match maps `*` → `.*` (matches
          // across path separators). Vault-knowledge subtrees (atomic/, project/,
          // scratchpad/) are NOT denied — agents reach those via `write`.
          //
          // PRECEDENCE: Permission.evaluate uses `findLast` over the flattened
          // ruleset, so the merge order below dictates effective precedence.
          // We want:
          //   defaults  → cardPerm  → kernelDenies  → user
          // so kernel denies override card-level `*: allow` blanket rules
          // (otherwise an agent card with blanket write allow would defeat
          // the deny), while still letting the user-config layer reinstate access
          // with a more-specific or matching glob — escape hatch preserved.
          const kernelSubtrees = {
            [path.join(vaultPath.etc(), "*")]: "deny",
            [path.join(vaultPath.root(), "cache", "*")]: "deny",
            [path.join(vaultPath.root(), "state", "*")]: "deny",
            [path.join(vaultPath.root(), "log", "*")]: "deny",
            [path.join(vaultPath.tmpRoot(), "*")]: "deny",
          } as const
          const kernelDenies = Permission.fromConfig({
            // Per-kernel-subtree deny for internal write permissions.
            write: kernelSubtrees,
          })

          const user = Permission.fromConfig(cfg.permission ?? {})

          const agents: Record<string, Info> = {}

          // ── Bundled agent prompts are the runtime source of truth. ─────────
          // Markdown prompt files are build inputs only; runtime uses the
          // generated prompt map and does not depend on external prompt files.
          const loaded = yield* Effect.promise(() =>
            AgentPromptLoader.loadAgentCards().catch((err) => {
              throw new Error(`failed to load bundled agent cards: ${(err as Error).message}`)
            }),
          )
          if (Object.keys(loaded.cards).length === 0) {
            AgentPromptLoader.logPromptSourceEmpty("embedded agent prompt map")
          }
          AgentPromptLoader.logRegistryHealthIssues(AgentPromptLoader.validateRegistryHealth(loaded))
          for (const [name, card] of Object.entries(loaded.cards)) {
            const cardPerm = card.permissionConfig ? Permission.fromConfig(card.permissionConfig as never) : []
            agents[name] = {
              name,
              description: card.description,
              prompt: card.prompt,
              permission: Permission.merge(defaults, cardPerm, kernelDenies, user),
              options: {},
              mode: card.mode,
              native: card.native ?? false,
              hidden: card.hidden,
              tier: card.tier,
              modelTier: card.modelTier,
            }
          }

          const agentModifiers = cfg.agent ?? {}
          const buildModifier = agentModifiers.build
          const modifiersSansBuild = { ...agentModifiers }
          delete modifiersSansBuild.build

          // Apply user-config modifiers (cfg.agent[*]) over local prompt cards.
          // Modifier-only: unknown names are rejected (local prompt must define first),
          // except legacy "build" alias handled below.
          applyConfigOverlay(agents, modifiersSansBuild)

          const legacyAliases: Record<string, Info> = {}
          if (!agents.build) {
            const primary =
              Object.values(agents).find((a) => a.tier === "0" && a.mode !== "subagent" && a.hidden !== true) ??
              agents.orchestrator ??
              Object.values(agents).find((a) => a.mode !== "subagent" && a.hidden !== true)
            if (primary) {
              legacyAliases.build = cloneAgent(primary, "build")
            }
          }
          if (buildModifier) {
            if (agents.build) {
              applyConfigOverlay(agents, { build: buildModifier })
            } else if (legacyAliases.build) {
              applyConfigOverlay(legacyAliases, { build: buildModifier })
            } else {
              AgentPromptLoader.logUnknownConfigAgent("build")
            }
          }

          // Ensure Truncate.GLOB is allowed unless explicitly configured
          for (const name in agents) {
            const agent = agents[name]
            const explicit = agent.permission.some((r) => {
              if (r.permission !== "external_directory") return false
              if (r.action !== "deny") return false
              return r.pattern === Truncate.GLOB
            })
            if (explicit) continue

            agents[name].permission = Permission.merge(
              agents[name].permission,
              Permission.fromConfig({ external_directory: { [Truncate.GLOB]: "allow" } }),
            )
          }

          const get = Effect.fnUntraced(function* (agent: string) {
            return agents[agent] ?? legacyAliases[agent]
          })

          // Helper: which agent should sort first / serve as fallback default?
          // Previously hardcoded to "orchestrator"; now derived from the
          // local prompt tier index — the unique tier-0 card (if any) is the
          // canonical primary, regardless of its name.
          const tier0Name = (): string | null => {
            for (const a of Object.values(agents)) if (a.tier === "0") return a.name
            return null
          }

          const list = Effect.fnUntraced(function* () {
            const fallback = tier0Name()
            return pipe(
              agents,
              values(),
              sortBy([(x) => fallback !== null && x.name === fallback, "desc"], [(x) => x.name, "asc"]),
            )
          })

          const defaultAgent = Effect.fnUntraced(function* () {
            // Prefer the tier-0 card (local-prompt-declared canonical primary). If the
            // local prompts have no tier-0, fall back to the first visible primary.
            const t0 = tier0Name()
            if (t0) {
              const a = agents[t0]
              if (a && a.mode !== "subagent" && a.hidden !== true) return a.name
            }
            const planner = agents.planner
            if (planner && planner.mode !== "subagent" && planner.hidden !== true) return planner.name
            const visible = Object.values(agents).find((a) => a.mode !== "subagent" && a.hidden !== true)
            if (!visible) throw new Error("no primary visible agent found")
            return visible.name
          })

          return {
            get,
            list,
            defaultAgent,
          } satisfies State
        }),
      )

      return Service.of({
        get: Effect.fn("Agent.get")(function* (agent: string) {
          return yield* InstanceState.useEffect(state, (s) => s.get(agent))
        }),
        list: Effect.fn("Agent.list")(function* () {
          return yield* InstanceState.useEffect(state, (s) => s.list())
        }),
        defaultAgent: Effect.fn("Agent.defaultAgent")(function* () {
          return yield* InstanceState.useEffect(state, (s) => s.defaultAgent())
        }),
        generate: Effect.fn("Agent.generate")(function* (input: {
          description: string
          model?: { providerID: ProviderID; modelID: ModelID }
        }) {
          const cfg = yield* config.get()
          const model = input.model ?? (yield* provider.defaultModel())
          const resolved = yield* provider.getModel(model.providerID, model.modelID)
          const language = yield* provider.getLanguage(resolved)

          const system = [yield* Effect.promise(() => loadGeneratePrompt())]
          const existing = yield* InstanceState.useEffect(state, (s) => s.list())

          const params = {
            experimental_telemetry: {
              isEnabled: cfg.experimental?.openTelemetry,
              metadata: {
                userId: cfg.username ?? "unknown",
              },
            },
            temperature: 0.3,
            allowSystemInMessages: true,
            messages: [
              ...system.map(
                (item): ModelMessage => ({
                  role: "system",
                  content: item,
                }),
              ),
              {
                role: "user",
                content: `Create an agent configuration based on this request: \"${input.description}\".\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existing.map((i) => i.name).join(", ")}\n  Return ONLY the JSON object, no other text, do not wrap in backticks`,
              },
            ],
            model: language,
            schema: z.object({
              identifier: z.string(),
              whenToUse: z.string(),
              systemPrompt: z.string(),
            }),
          } satisfies Parameters<typeof generateObject>[0]

          // ARCH-DEBT: OpenAI OAuth requires streamObject instead of generateObject.
          // Provider-specific dispatch logic should live in a provider capability hook,
          // not inline here. Tracked: move to ProviderTransform or a dedicated
          // generateObject wrapper that handles OAuth providers transparently.
          const authInfo = yield* auth.get(model.providerID).pipe(Effect.orDie)
          if (model.providerID === "openai" && authInfo?.type === "oauth") {
            return yield* Effect.promise(async () => {
              const result = streamObject({
                ...params,
                providerOptions: ProviderTransform.providerOptions(resolved, {
                  store: false,
                }),
                onError: () => {},
              })
              for await (const part of result.fullStream) {
                if (part.type === "error") throw part.error
              }
              return result.object
            })
          }

          return yield* Effect.promise(() => generateObject(params).then((r) => r.object))
        }),
      })
    }),
  )

  export const defaultLayer = Layer.suspend(() =>
    layer.pipe(
      Layer.provide(Provider.defaultLayer),
      Layer.provide(Auth.defaultLayer),
      Layer.provide(Config.defaultLayer),
    ),
  )

  const { runPromise } = makeRuntime(Service, defaultLayer)

  export async function get(agent: string) {
    return runPromise((svc) => svc.get(agent))
  }

  export async function list() {
    return runPromise((svc) => svc.list())
  }

  export async function defaultAgent() {
    return runPromise((svc) => svc.defaultAgent())
  }

  export async function generate(input: { description: string; model?: { providerID: ProviderID; modelID: ModelID } }) {
    return runPromise((svc) => svc.generate(input))
  }
}

registerAgentCatalogBridge({
  get: (name) =>
    Agent.get(name)
      .then((agent) => agent as any)
      .catch(() => undefined),
  list: () => Agent.list().then((agents) => agents as any),
})
