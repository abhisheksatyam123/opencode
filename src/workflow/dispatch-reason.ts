// src/workflow/dispatch-reason.ts — DispatchReason L3 registry (Stage 1, I1.6).
// -------------------------------------------------------------------------
// Authoritative contract: project/software/opencode/specification/contract/
//   l3-registry.md — full L3 contract.
// Card schema mirrors seeded cards under `<vault>/atomic/workflow/dispatch-reason/`:
//   required: reason, default_handler, trigger, override_path
//   optional: description, tags, min_engine, aliases
//
// Mirrors `src/workflow/phase.ts` template + `DispatchRoles.REASON_DEFAULTS`
// legacy shape (`src/agent/dispatch-roles.ts:109`).
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
import { DispatchRoles } from "@/permission/policy/dispatch-roles"

export namespace DispatchReason {
  const log = Log.create({ service: "dispatch-reason-registry" })

  export const Info = z.object({
    reason: z.string().regex(/^[a-z][a-z0-9-]*$/),
    default_handler: z.string().min(1),
    /** Predicate semantics — describes when reconcile engine fires this reason. */
    trigger: z.string().min(1),
    override_path: z.string().min(1),

    description: z.string().optional(),
    aliases: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    min_engine: z.string().optional(),

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

  /**
   * Mirrors `src/agent/dispatch-roles.ts:109 REASON_DEFAULTS`. In-code
   * fallback per L3 §empty-vault.
   */
  export const DEFAULT_REASON_BINDINGS: Record<string, string> = Object.freeze({
    "default-fallback": "planner",
    "missing-discovery": "searcher",
    "pending-dispatch": "planner",
    "failed-progress": "planner",
    "open-questions": "planner",
    "notes-empty": "planner",
    "phase-gate-verify": "implementer",
  }) as Record<string, string>

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
    return vaultPath.atomic("workflow", "dispatch-reason")
  }

  function validateRecord(rec: Info, filenameStem: string): { reason: LoadError["reason"]; detail: string } | null {
    if (rec.reason !== filenameStem) {
      return {
        reason: "schema.invalid",
        detail: `reason field "${rec.reason}" must equal filename stem "${filenameStem}"`,
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

    const seen = new Set<string>()
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

      if (seen.has(rec.reason)) {
        errors.push({
          source: "vault",
          path: filePath,
          name: stem,
          reason: "duplicate",
          detail: `reason "${rec.reason}" already declared by another card; this card excluded`,
        })
        continue
      }
      seen.add(rec.reason)

      const frozen = Object.freeze(rec) as Info
      records.set(rec.reason, frozen)
      for (const alias of rec.aliases ?? []) {
        if (!records.has(alias)) records.set(alias, frozen)
      }
    }

    return { records, errors }
  }

  export async function load(): Promise<void> {
    const t0 = Date.now()
    const priorByName = snapshot.byName // Diff reload output against the previous snapshot.
    const { records, errors } = await loadFromVault()

    if (records.size === 0 && !warnedEmpty) {
      log.warn("registry.empty", {
        kind: "dispatch-reason",
        vault_dir: vaultDir(),
        fallback: "DEFAULT_REASON_BINDINGS (in-code)",
        message:
          "dispatch-reason registry empty — using built-in defaults. Populate <vault>/atomic/workflow/dispatch-reason/ to override.",
      })
      warnedEmpty = true
    }

    const unique = new Set<Info>()
    for (const r of records.values()) unique.add(r)
    const list = Object.freeze([...unique].sort((a, b) => a.reason.localeCompare(b.reason)))

    snapshot = { byName: records, list, errors: Object.freeze(errors) }

    for (const fn of subscribers) {
      try {
        fn()
      } catch (err) {
        log.warn("onChange.handler.threw", { err: err instanceof Error ? err.message : String(err) })
      }
    }

    // Publish `registry.reloaded` so registry consumers can react to dispatch reason changes.
    // Append added/removed/changed fields to the reload event.
    const diff = RegistryEvent.computeDiff(priorByName.size === 0 ? null : priorByName, records)
    Bus.publish(RegistryEvent.Reloaded, {
      kind: "dispatch-reason",
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
        kind: "dispatch-reason",
        err: err instanceof Error ? err.message : String(err),
      })
    })
  }

  /** Stage 7 (I7.1): start fs.watch on the dispatch-reason vault subtree. */
  export function startWatcher(opts?: { debounceMs?: number }): { dispose(): void } {
    return WatchManager.start({
      kind: "dispatch-reason",
      dir: vaultDir(),
      onChange: () => reload(),
      debounceMs: opts?.debounceMs,
    })
  }

  /** Stop the dispatch-reason watcher. Idempotent. */
  export function stopWatcher(): void {
    WatchManager.stop("dispatch-reason")
  }

  export function get(name: string): Info | undefined {
    const direct = snapshot.byName.get(name)
    if (direct) return direct

    if (snapshot.byName.size === 0 && Object.prototype.hasOwnProperty.call(DEFAULT_REASON_BINDINGS, name)) {
      const synthetic = Object.freeze({
        reason: name,
        default_handler: DEFAULT_REASON_BINDINGS[name],
        trigger: "<degraded>",
        override_path: `cfg.dispatch_roles.reason["${name}"]`,
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

DispatchRoles.registerReasonRegistryBridge({
  defaultHandler: (reason) => DispatchReason.get(reason)?.default_handler,
})
