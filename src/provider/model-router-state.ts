// provider/model-router-state.ts
//
// Persistent local JSON state for ModelRouter.
//
// Stores per-model usage records (success/failure counts, cumulative latency)
// in `<Global.Path.state>/model-router.json`. Atomic write via tmp-rename.
//
// Schema is intentionally flat and append-friendly: each call to `append()`
// adds one record; `read()` returns the full state; `snapshot()` returns a
// summary keyed by model string ("providerID/modelID").
//
// MEMORY BOUNDS
// =============
// Records are capped at MAX_RECORDS (default 10 000). When exceeded, the
// oldest records are dropped (FIFO). Each record is ~100 bytes, so 10 000
// records ≈ 1 MB on disk — acceptable for a local state file.

import * as fs from "fs/promises"
import path from "path"
import z from "zod"
import { Global } from "@/filesystem/global"
import { Log } from "@/foundation/util/log"

const log = Log.create({ service: "model-router-state" })

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const ModelUsageRecord = z.object({
  /** "providerID/modelID" composite key */
  model: z.string(),
  /** ISO 8601 timestamp of the call */
  at: z.string(),
  /** Whether the LLM call succeeded */
  success: z.boolean(),
  /** Wall-clock latency in milliseconds (first-token or full-response) */
  latencyMs: z.number().int().nonnegative(),
  /** Time-to-first-token in milliseconds */
  ttftMs: z.number().int().nonnegative().optional(),
  /** Specific error code (e.g. server_error, rate_limit) */
  errorCode: z.string().optional(),
  /** Total input tokens */
  inputTokens: z.number().int().nonnegative().optional(),
  /** Task type category (from benchmark taxonomy) */
  taskType: z.string().optional(),
})
export type ModelUsageRecord = z.infer<typeof ModelUsageRecord>

export const ModelRouterStateFile = z.object({
  version: z.literal("1.0"),
  records: z.array(ModelUsageRecord),
})
export type ModelRouterStateFile = z.infer<typeof ModelRouterStateFile>

/** Per-model aggregated stats returned by `snapshot()`. */
export interface ModelStats {
  model: string
  calls: number
  successes: number
  failures: number
  /** Failure rate in [0, 1]. 0 when calls === 0. */
  failureRate: number
  /** Mean latency in ms across all recorded calls. 0 when calls === 0. */
  meanLatencyMs: number
  /** Failure rate over the last 20 calls. */
  recentFailureRate?: number
  /** Number of consecutive errors leading up to the present. */
  consecutiveErrors?: number
  /** Mean time-to-first-token in milliseconds. */
  meanTtftMs?: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_RECORDS = 10_000

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function statePath(): string {
  return path.join(Global.Path.state, "model-router.json")
}

async function readRaw(): Promise<ModelRouterStateFile> {
  try {
    const raw = await fs.readFile(statePath(), "utf-8")
    const parsed = ModelRouterStateFile.safeParse(JSON.parse(raw))
    if (!parsed.success) {
      log.warn("model-router-state.read.invalid", { error: parsed.error.message })
      return { version: "1.0", records: [] }
    }
    return parsed.data
  } catch {
    return { version: "1.0", records: [] }
  }
}

async function writeRaw(state: ModelRouterStateFile): Promise<void> {
  const p = statePath()
  const tmp = `${p}.tmp`
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(tmp, JSON.stringify(state, null, 2))
  await fs.rename(tmp, p)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export namespace ModelRouterState {
  /**
   * Read the full state file from disk.
   * Returns an empty state if the file is missing or schema-invalid.
   */
  export async function read(): Promise<ModelRouterStateFile> {
    return readRaw()
  }

  /**
   * Append one usage record to the state file.
   * Enforces MAX_RECORDS cap (FIFO eviction of oldest records).
   */
  export async function append(record: ModelUsageRecord): Promise<void> {
    const state = await readRaw()
    state.records.push(record)
    if (state.records.length > MAX_RECORDS) {
      state.records = state.records.slice(state.records.length - MAX_RECORDS)
    }
    await writeRaw(state)
    log.info("model-router-state.appended", {
      model: record.model,
      success: record.success,
      latencyMs: record.latencyMs,
    })
  }

  /**
   * Return aggregated per-model stats from the current state file.
   * Keyed by "providerID/modelID" composite string.
   */
  export async function snapshot(): Promise<Record<string, ModelStats>> {
    const state = await readRaw()
    const out: Record<string, ModelStats> = {}
    const modelRecords: Record<string, ModelUsageRecord[]> = {}

    for (const rec of state.records) {
      if (!modelRecords[rec.model]) {
        modelRecords[rec.model] = []
      }
      modelRecords[rec.model].push(rec)

      let s = out[rec.model]
      if (!s) {
        s = {
          model: rec.model,
          calls: 0,
          successes: 0,
          failures: 0,
          failureRate: 0,
          meanLatencyMs: 0,
          recentFailureRate: 0,
          consecutiveErrors: 0,
          meanTtftMs: 0,
        }
        out[rec.model] = s
      }
      s.calls++
      if (rec.success) s.successes++
      else s.failures++
      s.meanLatencyMs = s.meanLatencyMs + (rec.latencyMs - s.meanLatencyMs) / s.calls
    }

    for (const [model, records] of Object.entries(modelRecords)) {
      const s = out[model]
      if (!s) continue

      s.failureRate = s.calls > 0 ? s.failures / s.calls : 0

      // 1. Recent failure rate (last 20 calls)
      const recentWindow = records.slice(-20)
      const recentFailures = recentWindow.filter((r) => !r.success).length
      s.recentFailureRate = recentWindow.length > 0 ? recentFailures / recentWindow.length : 0

      // 2. Consecutive errors (count backward from the end)
      let consecutive = 0
      for (let i = records.length - 1; i >= 0; i--) {
        if (!records[i].success) {
          consecutive++
        } else {
          break
        }
      }
      s.consecutiveErrors = consecutive

      // 3. Mean TTFT
      const ttftRecords = records.filter((r) => r.ttftMs !== undefined && r.ttftMs !== null)
      if (ttftRecords.length > 0) {
        const sum = ttftRecords.reduce((acc, r) => acc + (r.ttftMs ?? 0), 0)
        s.meanTtftMs = sum / ttftRecords.length
      } else {
        s.meanTtftMs = undefined
      }
    }

    return out
  }

  /**
   * Clear all records (used in tests / debug commands).
   */
  export async function clear(): Promise<void> {
    await writeRaw({ version: "1.0", records: [] })
    log.info("model-router-state.cleared")
  }
}
