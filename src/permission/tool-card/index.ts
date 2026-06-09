// src/tool-card/index.ts — base-prompt-only tool metadata pointers.
// -------------------------------------------------------------------------
// Canonical tool descriptions, schemas, and behavioral contracts live in
// src/agent/prompts/_shared/base.md. ToolCard intentionally does not read or
// seed vault cards: the vault must not become a second source of truth for tool
// definitions.
// -------------------------------------------------------------------------

import z from "zod"
import { Log } from "@/foundation/util/log"
import { Bus } from "@/bus"
import { RegistryEvent } from "@/bus/registry-events"

const BASE_PROMPT_SOURCE = "src/agent/prompts/_shared/base.md"
const BASE_TOOL_CONTRACT = `See ${BASE_PROMPT_SOURCE} for canonical tool description/schema.`

export namespace ToolCard {
  const log = Log.create({ service: "tool-card-registry" })

  export const Info = z.object({
    tool: z.string().regex(/^[a-z][a-z0-9-]*$/),
    description: z.string().min(1),
    aliases: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    category: z.string().optional(),
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
   * Minimal runtime pointers for registered tools. The shared base prompt is
   * the only place that may define tool descriptions, schemas, and behavior.
   */
  export const DEFAULT_TOOL_CARD_BINDINGS: Record<string, string> = Object.freeze({
    bash: BASE_TOOL_CONTRACT,
    task: BASE_TOOL_CONTRACT,
  }) as Record<string, string>

  type Snapshot = {
    byName: ReadonlyMap<string, Info>
    list: ReadonlyArray<Info>
    errors: ReadonlyArray<LoadError>
  }

  const subscribers = new Set<() => void>()

  function buildDefaultSnapshot(): Snapshot {
    const records = new Map<string, Info>()
    for (const [tool, description] of Object.entries(DEFAULT_TOOL_CARD_BINDINGS)) {
      records.set(
        tool,
        Object.freeze({
          tool,
          description,
          _source: "base-prompt",
        }) as Info,
      )
    }
    const list = Object.freeze([...records.values()].sort((a, b) => a.tool.localeCompare(b.tool)))
    return { byName: records, list, errors: Object.freeze([]) }
  }

  let snapshot: Snapshot = buildDefaultSnapshot()

  export async function load(): Promise<void> {
    const t0 = Date.now()
    const priorByName = snapshot.byName
    snapshot = buildDefaultSnapshot()

    for (const fn of subscribers) {
      try {
        fn()
      } catch (err) {
        log.warn("onChange.handler.threw", { err: err instanceof Error ? err.message : String(err) })
      }
    }

    const diff = RegistryEvent.computeDiff(priorByName.size === 0 ? null : priorByName, snapshot.byName)
    Bus.publish(RegistryEvent.Reloaded, {
      kind: "tool-card",
      count: snapshot.list.length,
      errors: 0,
      durationMs: Date.now() - t0,
      sourceIds: ["base-prompt"],
      added: diff.added,
      removed: diff.removed,
      changed: diff.changed,
    }).catch((err) => {
      if (RegistryEvent.isBusNotBootstrapped(err)) return
      log.warn("bus.publish.reloaded.failed", {
        kind: "tool-card",
        err: err instanceof Error ? err.message : String(err),
      })
    })
  }

  /** Tool definitions are base-prompt-only, so there is no vault subtree to watch. */
  export function startWatcher(): { dispose(): void } {
    return { dispose() {} }
  }

  /** Kept for API compatibility; no watcher is registered for tool cards. */
  export function stopWatcher(): void {}

  export function get(name: string): Info | undefined {
    return snapshot.byName.get(name)
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
    return [{ source: rec._source ?? "base-prompt", fields }]
  }

  /** @internal — reset for tests. */
  export function _resetForTest(): void {
    snapshot = buildDefaultSnapshot()
    subscribers.clear()
  }
}
