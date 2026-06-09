// src/workflow/dlq.ts — Stage 11 DLQ writer + sweep (I11.4 + I11.5).
// -------------------------------------------------------------------------
// Spec: project/software/opencode/specification/contract/message-type-registry
//       §DLQ layout (D.3) + §Sweep invariants (1-5) + §S.2 acceptance cell.
//
// DLQ path: <vault>/state/ipc/dlq/<thread>-<epoch_ms>.json
//
// writeDlqEntry(entry)  — atomically write a new DLQ JSON file.
// runSweep(opts?)       — read all unresolved *.json, re-deliver or exhaust.
// -------------------------------------------------------------------------

import path from "path"
import fs from "fs/promises"
import { existsSync } from "fs"
import z from "zod"
import { vaultPath } from "@/notes/root"
import { MessageType } from "@/workflow/message-type"
import { Log } from "@/foundation/util/log"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"

const log = Log.create({ service: "dlq" })

// ---------------------------------------------------------------------------
// Bus event — gap-found (emitted when retries exhausted)
// ---------------------------------------------------------------------------

/** Bus event emitted by runSweep when a DLQ entry's retries are exhausted. */
export const DlqGapFound = BusEvent.define(
  "dlq.gap_found",
  z.object({
    msg_id: z.string(),
    thread: z.string(),
    type: z.string(),
    dlq_reason: z.string(),
    retry_count: z.number().int().min(0),
    resolved_at: z.string().nullable(),
    dlq_path: z.string(),
  }),
)

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Reason a message was routed to the DLQ. */
export type DlqReason = "ttl_expired" | "retry_exhausted" | "malformed"

/** Shape of a DLQ entry on disk (D.3 JSON schema). */
export interface DlqEntry {
  msg_id: string
  thread: string
  type: string
  sender: string
  recipient: string
  timestamp: string
  body: string
  extra_fields: Record<string, unknown>
  dlq_reason: DlqReason
  retry_count: number
  routed_at: string
  resolved: boolean
  resolved_at: string | null
}

/** Options for runSweep. */
export interface SweepOptions {
  /**
   * Inject a custom re-delivery function.  Defaults to a no-op that logs the
   * re-delivery attempt.  In production this should write back to the task-note
   * ## Systems / ### Coordination subsection; injected here to keep the module pure and testable.
   */
  redeliver?: (entry: DlqEntry) => Promise<void>

  /**
   * Inject a gap-found emitter.  Defaults to Bus.publish (gap-found event).
   * Injected for testability — avoids Effect runtime in unit tests.
   */
  emitGapFound?: (entry: DlqEntry) => Promise<void>

  /**
   * Override the current time (epoch ms).  Used by tests with mock clocks.
   * Defaults to Date.now().
   */
  nowMs?: () => number
}

/** Result returned by runSweep. */
export interface SweepResult {
  /** Number of DLQ files examined. */
  examined: number
  /** Number of entries that were re-delivered (retry_count incremented). */
  redelivered: number
  /** Number of entries that were resolved (retries exhausted → gap-found). */
  resolved: number
  /** Number of entries that were already resolved (no-op). */
  skipped: number
  /** Errors encountered while processing individual entries. */
  errors: Array<{ file: string; reason: string }>
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Absolute path to the DLQ directory: <vault>/state/ipc/dlq/ */
export function dlqDir(): string {
  return vaultPath.state("ipc", "dlq")
}

/** Absolute path for a DLQ entry file: <vault>/state/ipc/dlq/<msg_id>.json */
export function dlqFilePath(msgId: string): string {
  return path.join(dlqDir(), `${msgId}.json`)
}

// ---------------------------------------------------------------------------
// writeDlqEntry
// ---------------------------------------------------------------------------

/**
 * Write a DLQ entry to disk.
 *
 * Creates `<vault>/state/ipc/dlq/<entry.msg_id>.json` atomically (write to
 * tmp then rename).  The directory is created if absent.
 *
 * Throws on I/O failure — callers should catch and log.
 */
export async function writeDlqEntry(entry: DlqEntry): Promise<void> {
  const dir = dlqDir()
  await fs.mkdir(dir, { recursive: true })

  const filePath = dlqFilePath(entry.msg_id)
  const tmpPath = `${filePath}.tmp`

  const json = JSON.stringify(entry, null, 2)
  await fs.writeFile(tmpPath, json, "utf8")
  await fs.rename(tmpPath, filePath)

  log.info("dlq.entry.written", { msg_id: entry.msg_id, type: entry.type, dlq_reason: entry.dlq_reason })
}

// ---------------------------------------------------------------------------
// runSweep  (I11.5 retry replay)
// ---------------------------------------------------------------------------

/**
 * Sweep all unresolved DLQ entries.
 *
 * Invariants (per D.3 §Sweep invariants):
 *   1. Reads all *.json under <vault>/state/ipc/dlq/ where resolved = false.
 *   2. For each: if retry_count < card.retry.max → re-deliver + increment retry_count.
 *   3. If retry_count >= card.retry.max → resolved=true, resolved_at=now, emit gap-found.
 *   4. Idempotent: already-resolved entries are skipped (no-op).
 *   5. Per-entry errors are isolated; sweep continues with remaining entries.
 */
export async function runSweep(opts: SweepOptions = {}): Promise<SweepResult> {
  const nowMs = opts.nowMs ?? (() => Date.now())
  const redeliver = opts.redeliver ?? defaultRedeliver
  const emitGapFound = opts.emitGapFound ?? defaultEmitGapFound

  const result: SweepResult = {
    examined: 0,
    redelivered: 0,
    resolved: 0,
    skipped: 0,
    errors: [],
  }

  const dir = dlqDir()
  if (!existsSync(dir)) {
    log.info("dlq.sweep.dir-absent", { dir })
    return result
  }

  let filenames: string[]
  try {
    filenames = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"))
  } catch (err) {
    log.warn("dlq.sweep.readdir-failed", { dir, err: String(err) })
    result.errors.push({ file: dir, reason: `readdir failed: ${String(err)}` })
    return result
  }

  for (const filename of filenames) {
    const filePath = path.join(dir, filename)
    result.examined++

    let entry: DlqEntry
    try {
      const raw = await fs.readFile(filePath, "utf8")
      entry = JSON.parse(raw) as DlqEntry
    } catch (err) {
      log.warn("dlq.sweep.parse-failed", { file: filePath, err: String(err) })
      result.errors.push({ file: filePath, reason: `parse failed: ${String(err)}` })
      continue
    }

    // Invariant 4: already resolved → skip (idempotent).
    if (entry.resolved) {
      result.skipped++
      continue
    }

    // Look up retry policy from MessageType registry.
    const card = MessageType.get(entry.type)
    const retryMax = card?.retry.max ?? 0

    try {
      if (entry.retry_count < retryMax) {
        // Re-deliver: write back to Messages section, increment retry_count.
        await redeliver(entry)
        entry.retry_count++
        await writeEntryUpdate(filePath, entry)
        result.redelivered++
        log.info("dlq.sweep.redelivered", {
          msg_id: entry.msg_id,
          type: entry.type,
          retry_count: entry.retry_count,
        })
      } else {
        // Retries exhausted: mark resolved, emit gap-found.
        entry.resolved = true
        entry.resolved_at = new Date(nowMs()).toISOString()
        await writeEntryUpdate(filePath, entry)
        await emitGapFound(entry)
        result.resolved++
        log.info("dlq.sweep.resolved", {
          msg_id: entry.msg_id,
          type: entry.type,
          retry_count: entry.retry_count,
        })
      }
    } catch (err) {
      log.warn("dlq.sweep.entry-error", { file: filePath, err: String(err) })
      result.errors.push({ file: filePath, reason: String(err) })
    }
  }

  log.info("dlq.sweep.complete", {
    examined: result.examined,
    redelivered: result.redelivered,
    resolved: result.resolved,
    skipped: result.skipped,
    errors: result.errors.length,
  })

  return result
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Atomically overwrite an existing DLQ entry file. */
async function writeEntryUpdate(filePath: string, entry: DlqEntry): Promise<void> {
  const tmpPath = `${filePath}.tmp`
  await fs.writeFile(tmpPath, JSON.stringify(entry, null, 2), "utf8")
  await fs.rename(tmpPath, filePath)
}

/** Default re-delivery: log only (production should inject a real writer). */
async function defaultRedeliver(entry: DlqEntry): Promise<void> {
  log.info("dlq.redeliver.default", {
    msg_id: entry.msg_id,
    type: entry.type,
    note: "no redeliver injected — log-only",
  })
}

/**
 * Default gap-found emitter: publish DlqGapFound via Bus.
 * Silently swallows Bus-not-bootstrapped errors (test/CLI contexts).
 */
async function defaultEmitGapFound(entry: DlqEntry): Promise<void> {
  try {
    await Bus.publish(DlqGapFound, {
      msg_id: entry.msg_id,
      thread: entry.thread,
      type: entry.type,
      dlq_reason: entry.dlq_reason,
      retry_count: entry.retry_count,
      resolved_at: entry.resolved_at,
      dlq_path: dlqFilePath(entry.msg_id),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Bus not bootstrapped in test/CLI contexts — log only.
    if (msg.includes("No context found for instance") || msg.includes("InstanceState")) {
      log.info("dlq.gap-found.bus-unavailable", { msg_id: entry.msg_id, type: entry.type })
      return
    }
    log.warn("dlq.gap-found.publish-failed", { msg_id: entry.msg_id, type: entry.type, err: msg })
  }
}
