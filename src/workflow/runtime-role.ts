// src/workflow/runtime-role.ts — RuntimeRole L3 registry (Stage 1, leaf I1.6).
// -------------------------------------------------------------------------
// Authoritative contract: project/software/opencode/specification/contract/
//   l3-registry.md — `Source<T>` + `Registry<T>` 6-method API,
//                    7-step lifecycle, 10 invariants.
// Card schema: ad-hoc (no formal schema note yet); fields mirror seeded
//   cards under `<vault>/atomic/runtime-role/`:
//     required: role, default_agent, consumer, invocation, override_path
//     optional: description, tags, min_engine, aliases
//
// Mirrors `src/workflow/phase.ts` (I1.4 template) + `RuntimeRoles` legacy
// shape (`src/agent/runtime-roles.ts:52 DEFAULT_BINDINGS`). Registry shape
// is identical to Phase's; only the record schema differs.
// -------------------------------------------------------------------------

import path from "path"
import { existsSync } from "fs"
import fs from "fs/promises"
import z from "zod"
import { ConfigMarkdown } from "@/config/markdown"
import { Log } from "@/foundation/util/log"
import { vaultPath } from "@/notes/root"
import { Bus, WatchManager } from "@/bus"
import { RegistryEvent } from "@/bus/registry-events"
import { RuntimeRoles } from "@/permission/policy/runtime-roles"

export namespace RuntimeRole {
  const log = Log.create({ service: "runtime-role-registry" })

  // ── Types ────────────────────────────────────────────────────────────

  /** Invocation pattern of the consumer call site. */
  export const Invocation = z.enum(["sync", "async", "effect-async"])
  export type Invocation = z.infer<typeof Invocation>

  export const Info = z.object({
    /** Closed enum of role keys (kebab-case). MUST equal filename stem. */
    role: z.string().regex(/^[a-z][a-z0-9-]*$/),
    /** Agent name bound by default. Override via cfg.runtime_roles[role]. */
    default_agent: z.string().min(1),
    /** File path of the consumer that invokes this role. */
    consumer: z.string().min(1),
    invocation: Invocation,
    /** cfg key path used to override the binding. */
    override_path: z.string().min(1),

    description: z.string().optional(),
    aliases: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    min_engine: z.string().optional(),

    /** Provenance — populated by registry, never present in source. */
    _source: z.string().optional(),
  })
  export type Info = z.infer<typeof Info>

  export interface LoadError {
    source: string
    path?: string
    name?: string
    reason: "schema.invalid" | "ref.unresolved" | "duplicate" | "engine.too-old" | "io.read" | "frontmatter.parse"
    detail: string
  }

  // ── Built-in fallback (mirrors RuntimeRoles.DEFAULT_BINDINGS) ─────────

  /**
   * In-code fallback per L3 §empty-vault. Default runtime bindings. Most hidden roles map to same-name helpers; adviser maps to adviser. Mirrors
   * `src/agent/runtime-roles.ts:52 DEFAULT_BINDINGS`.
   */
  export const DEFAULT_RUNTIME_ROLE_BINDINGS: Record<string, string> = Object.freeze({
    compaction: "compaction",
    "user-proxy": "user-proxy",
    "halt-auditor": "halt-auditor",
    title: "title",
    adviser: "adviser",
  }) as Record<string, string>

  // ── Internal state ───────────────────────────────────────────────────

  type Snapshot = {
    byName: ReadonlyMap<string, Info>
    list: ReadonlyArray<Info>
    errors: ReadonlyArray<LoadError>
  }

  let snapshot: Snapshot = {
    byName: new Map(),
    list: Object.freeze([]),
    errors: Object.freeze([]),
  }
  let warnedEmpty = false
  const subscribers = new Set<() => void>()

  function vaultDir(): string {
    return vaultPath.atomic("runtime-role")
  }

  function validateRecord(rec: Info, filenameStem: string): { reason: LoadError["reason"]; detail: string } | null {
    if (rec.role !== filenameStem) {
      return {
        reason: "schema.invalid",
        detail: `role field "${rec.role}" must equal filename stem "${filenameStem}"`,
      }
    }
    return null
  }

  async function loadFromVault(): Promise<{
    records: Map<string, Info>
    errors: LoadError[]
  }> {
    const records = new Map<string, Info>()
    const errors: LoadError[] = []
    const dir = vaultDir()

    if (!existsSync(dir)) return { records, errors }

    let dirents: string[]
    try {
      dirents = await fs.readdir(dir)
    } catch (err) {
      errors.push({
        source: "vault",
        path: dir,
        reason: "io.read",
        detail: `failed to read directory: ${err instanceof Error ? err.message : String(err)}`,
      })
      return { records, errors }
    }

    const seenRole = new Set<string>()
    for (const filename of dirents.filter((n) => n.endsWith(".md"))) {
      const stem = filename.replace(/\.md$/, "")
      const filePath = path.join(dir, filename)

      let parsed: { data: unknown; content: string }
      try {
        parsed = await ConfigMarkdown.parse(filePath)
      } catch (err) {
        errors.push({
          source: "vault",
          path: filePath,
          name: stem,
          reason: "frontmatter.parse",
          detail: err instanceof Error ? err.message : String(err),
        })
        continue
      }

      const result = Info.safeParse(parsed.data)
      if (!result.success) {
        errors.push({
          source: "vault",
          path: filePath,
          name: stem,
          reason: "schema.invalid",
          detail: result.error.issues.map((i) => `${i.path.join("@/workflow") || "<root>"}: ${i.message}`).join("; "),
        })
        continue
      }

      const rec = { ...result.data, _source: "vault" }
      const validation = validateRecord(rec, stem)
      if (validation) {
        errors.push({ source: "vault", path: filePath, name: stem, ...validation })
        continue
      }

      if (seenRole.has(rec.role)) {
        errors.push({
          source: "vault",
          path: filePath,
          name: stem,
          reason: "duplicate",
          detail: `role "${rec.role}" already declared by another card; this card excluded`,
        })
        continue
      }
      seenRole.add(rec.role)

      const frozen = Object.freeze(rec) as Info
      records.set(rec.role, frozen)
      for (const alias of rec.aliases ?? []) {
        if (!records.has(alias)) records.set(alias, frozen)
      }
    }

    return { records, errors }
  }

  // ── Public API (L3 contract) ─────────────────────────────────────────

  export async function load(): Promise<void> {
    const t0 = Date.now()
    const priorByName = snapshot.byName // Diff reload output against the previous snapshot.
    const { records, errors } = await loadFromVault()

    if (records.size === 0 && !warnedEmpty) {
      log.warn("registry.empty", {
        kind: "runtime-role",
        vault_dir: vaultDir(),
        fallback: "DEFAULT_RUNTIME_ROLE_BINDINGS (in-code)",
        message:
          "runtime-role registry empty — using built-in defaults. Populate <vault>/atomic/runtime-role/ to override.",
      })
      warnedEmpty = true
    }

    const unique = new Set<Info>()
    for (const r of records.values()) unique.add(r)
    const list = Object.freeze([...unique].sort((a, b) => a.role.localeCompare(b.role)))

    snapshot = { byName: records, list, errors: Object.freeze(errors) }

    for (const fn of subscribers) {
      try {
        fn()
      } catch (err) {
        log.warn("onChange.handler.threw", { err: err instanceof Error ? err.message : String(err) })
      }
    }

    // Publish `registry.reloaded` so registry consumers can react to runtime role changes.
    // Append added/removed/changed canonical names to the reload event.
    const diff = RegistryEvent.computeDiff(priorByName.size === 0 ? null : priorByName, records)
    Bus.publish(RegistryEvent.Reloaded, {
      kind: "runtime-role",
      count: unique.size,
      errors: errors.length,
      durationMs: Date.now() - t0,
      sourceIds: ["vault"],
      added: diff.added,
      removed: diff.removed,
      changed: diff.changed,
    }).catch((err) => {
      if (RegistryEvent.isBusNotBootstrapped(err)) return
      log.warn("bus.publish.reloaded.failed", {
        kind: "runtime-role",
        err: err instanceof Error ? err.message : String(err),
      })
    })
  }

  /** Stage 7 (I7.1): start fs.watch on the runtime-role vault subtree. */
  export function startWatcher(opts?: { debounceMs?: number }): { dispose(): void } {
    return WatchManager.start({
      kind: "runtime-role",
      dir: vaultDir(),
      onChange: () => reload(),
      debounceMs: opts?.debounceMs,
    })
  }

  /** Stop the runtime-role watcher. Idempotent. */
  export function stopWatcher(): void {
    WatchManager.stop("runtime-role")
  }

  export function get(name: string): Info | undefined {
    const direct = snapshot.byName.get(name)
    if (direct) return direct

    if (snapshot.byName.size === 0 && Object.prototype.hasOwnProperty.call(DEFAULT_RUNTIME_ROLE_BINDINGS, name)) {
      const synthetic = Object.freeze({
        role: name,
        default_agent: DEFAULT_RUNTIME_ROLE_BINDINGS[name],
        consumer: "<degraded>",
        invocation: "async" as Invocation,
        override_path: `cfg.runtime_roles["${name}"]`,
        _source: "default-binding",
      }) as Info
      return synthetic
    }
    return undefined
  }

  export function all(): ReadonlyArray<Info> {
    return snapshot.list
  }

  export function errors(): ReadonlyArray<LoadError> {
    return snapshot.errors
  }

  export async function reload(): Promise<void> {
    await load()
  }

  export function onChange(fn: () => void): { dispose(): void } {
    subscribers.add(fn)
    return {
      dispose() {
        subscribers.delete(fn)
      },
    }
  }

  export function provenance(name: string): Array<{ source: string; fields: string[] }> {
    const rec = snapshot.byName.get(name)
    if (!rec) return []
    const fields = Object.keys(rec).filter((k) => k !== "_source")
    return [{ source: rec._source ?? "vault", fields }]
  }

  /** @internal — reset for tests. */
  export function _resetForTest(): void {
    snapshot = { byName: new Map(), list: Object.freeze([]), errors: Object.freeze([]) }
    warnedEmpty = false
    subscribers.clear()
  }
}

RuntimeRoles.registerRegistryBridge({
  defaultAgent: (role) => RuntimeRole.get(role)?.default_agent,
})
