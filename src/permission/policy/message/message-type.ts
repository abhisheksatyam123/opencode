// src/workflow/message-type.ts — typed IPC message-type L3 registry (Stage 11).
// -------------------------------------------------------------------------
// Cards live under `<vault>/atomic/message-type/` and define the typed
// `## Systems / ### Coordination` envelope contract used for inter-agent handoffs.
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

export namespace MessageType {
  const log = Log.create({ service: "message-type-registry" })

  export const RetryPolicy = z.object({
    max: z.number().int().min(0),
    backoff_ms: z.number().int().min(0),
  })
  export type RetryPolicy = z.infer<typeof RetryPolicy>

  export const Info = z.object({
    /** Canonical message type (kebab-case). MUST equal filename stem. */
    name: z.string().regex(/^[a-z][a-z0-9-]*$/),
    /** Envelope/body fields that must be present for this message type. */
    required_fields: z.array(z.string().min(1)).min(1),
    /** Additional fields understood by consumers but not required. */
    optional_fields: z.array(z.string().min(1)).default([]),
    /** Milliseconds before an unacknowledged message is sweepable. 0 = no TTL. */
    ttl_ms: z.number().int().min(0),
    retry: RetryPolicy,
    ack_required: z.boolean(),

    description: z.string().optional(),
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

  const ENVELOPE_FIELDS = Object.freeze(["timestamp", "type", "thread", "body", "sender", "recipient"])

  export type DefaultMessageTypeInfo = Omit<Info, "name" | "_source">

  const DEFAULT_MESSAGE_TYPE_ENTRIES = {
    // Current coordination contract for inter-agent handoffs. These are not task-tool
    // spawn parameters: they are message body keys written under
    // `## Systems / ### Coordination` so receivers can identify the owning
    // task path, bounded leaf, and acceptance signal.
    handoff: {
      required_fields: [...ENVELOPE_FIELDS, "task_path", "leaf_description", "acceptance_signal"],
      optional_fields: ["evidence", "artifacts", "priority"],
      ttl_ms: 30 * 60 * 1000,
      retry: { max: 1, backoff_ms: 60 * 1000 },
      ack_required: true,
      description: "Parent/peer handoff carrying a bounded leaf and acceptance signal.",
      tags: ["ipc/core"],
    },
    "spec-ready": {
      required_fields: [...ENVELOPE_FIELDS, "acceptance_criteria", "artifacts"],
      optional_fields: ["risks", "open_questions"],
      ttl_ms: 30 * 60 * 1000,
      retry: { max: 1, backoff_ms: 60 * 1000 },
      ack_required: true,
      description: "Planner signal that implementation-ready contract and spec artifacts exist.",
      tags: ["ipc/core"],
    },
    blocker: {
      required_fields: [...ENVELOPE_FIELDS, "reason", "unblocking_action"],
      optional_fields: ["owner", "deadline", "alternatives"],
      ttl_ms: 0,
      retry: { max: 0, backoff_ms: 0 },
      ack_required: true,
      description: "Blocking condition requiring orchestrator or human action before progress continues.",
      tags: ["ipc/core"],
    },
    "decision-gate": {
      required_fields: [...ENVELOPE_FIELDS, "options", "criteria", "recommendation"],
      optional_fields: ["risk", "deadline", "context"],
      ttl_ms: 30 * 60 * 1000,
      retry: { max: 1, backoff_ms: 60 * 1000 },
      ack_required: true,
      description: "Choice point that needs orchestrator or owner decision before continuing.",
      tags: ["ipc/core"],
    },
    "retry-needed": {
      required_fields: [...ENVELOPE_FIELDS, "failure_evidence", "retry_count"],
      optional_fields: ["suggested_fix", "failed_command", "artifacts"],
      ttl_ms: 15 * 60 * 1000,
      retry: { max: 1, backoff_ms: 60 * 1000 },
      ack_required: true,
      description: "Runner or reviewer signal that the previous implementation pass must retry.",
      tags: ["ipc/core"],
    },
    "gap-found": {
      required_fields: [...ENVELOPE_FIELDS, "missing_artifact", "expected_location"],
      optional_fields: ["severity", "suggested_owner", "evidence"],
      ttl_ms: 60 * 60 * 1000,
      retry: { max: 0, backoff_ms: 0 },
      ack_required: false,
      description: "Validation signal that a required artifact or behavior is missing.",
      tags: ["ipc/core"],
    },
    ack: {
      required_fields: [...ENVELOPE_FIELDS, "referenced_thread", "outcome"],
      optional_fields: ["summary", "artifacts"],
      ttl_ms: 60 * 60 * 1000,
      retry: { max: 0, backoff_ms: 0 },
      ack_required: false,
      description: "Acknowledgement that a message thread was received and handled.",
      tags: ["ipc/core"],
    },
  } satisfies Record<string, DefaultMessageTypeInfo>

  export const DEFAULT_MESSAGE_TYPE_BINDINGS: Readonly<Record<string, DefaultMessageTypeInfo>> = Object.freeze(
    Object.fromEntries(
      Object.entries(DEFAULT_MESSAGE_TYPE_ENTRIES).map(([name, info]) => [
        name,
        Object.freeze({
          ...info,
          required_fields: Object.freeze([...info.required_fields]),
          optional_fields: Object.freeze([...info.optional_fields]),
          retry: Object.freeze({ ...info.retry }),
          tags: info.tags ? Object.freeze([...info.tags]) : undefined,
        }) as DefaultMessageTypeInfo,
      ]),
    ) as Record<string, DefaultMessageTypeInfo>,
  )

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
    return vaultPath.atomic("message-type")
  }

  function validateRecord(rec: Info, filenameStem: string): { reason: LoadError["reason"]; detail: string } | null {
    if (rec.name !== filenameStem) {
      return {
        reason: "schema.invalid",
        detail: `name field "${rec.name}" must equal filename stem "${filenameStem}"`,
      }
    }

    if (!rec.required_fields.includes("type")) {
      return { reason: "schema.invalid", detail: `required_fields must include envelope field "type"` }
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

      if (seen.has(rec.name)) {
        errors.push({
          source: "vault",
          path: filePath,
          name: stem,
          reason: "duplicate",
          detail: `message type "${rec.name}" already declared by another card; this card excluded`,
        })
        continue
      }
      seen.add(rec.name)

      const frozen = Object.freeze({ ...rec, optional_fields: Object.freeze([...rec.optional_fields]) }) as Info
      records.set(rec.name, frozen)
    }

    return { records, errors }
  }

  export async function load(): Promise<void> {
    const t0 = Date.now()
    const priorByName = snapshot.byName
    const { records, errors } = await loadFromVault()

    if (records.size === 0 && !warnedEmpty) {
      log.warn("registry.empty", {
        kind: "message-type",
        vault_dir: vaultDir(),
        fallback: "DEFAULT_MESSAGE_TYPE_BINDINGS (in-code)",
        message:
          "message-type registry empty — using built-in defaults. Populate <vault>/atomic/message-type/ to override.",
      })
      warnedEmpty = true
    }

    const list = Object.freeze([...records.values()].sort((a, b) => a.name.localeCompare(b.name)))
    snapshot = { byName: records, list, errors: Object.freeze(errors) }

    for (const fn of subscribers) {
      try {
        fn()
      } catch (err) {
        log.warn("onChange.handler.threw", { err: err instanceof Error ? err.message : String(err) })
      }
    }

    const diff = RegistryEvent.computeDiff(priorByName.size === 0 ? null : priorByName, records)
    Bus.publish(RegistryEvent.Reloaded, {
      kind: "message-type",
      count: list.length,
      errors: errors.length,
      durationMs: Date.now() - t0,
      sourceIds: ["vault"],
      added: diff.added,
      removed: diff.removed,
      changed: diff.changed,
    }).catch((err) => {
      if (RegistryEvent.isBusNotBootstrapped(err)) return
      log.warn("bus.publish.reloaded.failed", {
        kind: "message-type",
        err: err instanceof Error ? err.message : String(err),
      })
    })
  }

  export function startWatcher(opts?: { debounceMs?: number }): { dispose(): void } {
    return WatchManager.start({
      kind: "message-type",
      dir: vaultDir(),
      onChange: () => reload(),
      debounceMs: opts?.debounceMs,
    })
  }

  export function stopWatcher(): void {
    WatchManager.stop("message-type")
  }

  export function get(name: string): Info | undefined {
    const direct = snapshot.byName.get(name)
    if (direct) return direct

    if (snapshot.byName.size === 0 && Object.prototype.hasOwnProperty.call(DEFAULT_MESSAGE_TYPE_BINDINGS, name)) {
      const synthetic = Object.freeze({
        name,
        ...DEFAULT_MESSAGE_TYPE_BINDINGS[name],
        required_fields: Object.freeze([...DEFAULT_MESSAGE_TYPE_BINDINGS[name].required_fields]),
        optional_fields: Object.freeze([...DEFAULT_MESSAGE_TYPE_BINDINGS[name].optional_fields]),
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
