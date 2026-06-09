import { Effect } from "effect"
import type { ShellCommandImpl, Signal, ShellExitInfo } from "@/tool/bash/ShellCommand"
import type { TaskOutput } from "@/tool/bash/TaskOutput"

export interface BackgroundEntry {
  readonly id: string
  readonly pid: number
  readonly command: string
  readonly cwd: string
  readonly startedAt: number
  readonly completedAt?: number
  readonly outputPath: string
  readonly shellCommand: ShellCommandImpl
  readonly output: TaskOutput
  readonly exitInfo?: ShellExitInfo
  readonly status: "running" | "exited" | "killed" | "error"
}

export class BackgroundRegistryError extends Error {
  readonly _tag = "BackgroundRegistryError"
  readonly kind: "not-found" | "duplicate" | "invariant"
  readonly id?: string

  constructor(kind: "not-found" | "duplicate" | "invariant", id?: string) {
    super(id ? `${kind}: ${id}` : kind)
    this.kind = kind
    this.id = id
  }
}

type MutableEntry = Omit<BackgroundEntry, "status" | "exitInfo" | "completedAt"> & {
  status: BackgroundEntry["status"]
  exitInfo?: ShellExitInfo
  completedAt?: number
}

export class BackgroundRegistry {
  #map = new Map<string, MutableEntry>()
  #lastDeliveredAt = 0
  #lastCompletedAt = 0

  get lastDeliveredAt(): number {
    return this.#lastDeliveredAt
  }

  completedSince(ts: number): BackgroundEntry[] {
    const results: BackgroundEntry[] = []
    for (const entry of this.#map.values()) {
      if (entry.completedAt != null && entry.completedAt > ts) {
        results.push(entry)
      }
    }
    return results.sort((a, b) => a.completedAt! - b.completedAt!)
  }

  markDelivered(ids: string[]): void {
    let max = this.#lastDeliveredAt
    for (const id of ids) {
      const entry = this.#map.get(id)
      if (entry?.completedAt != null && entry.completedAt > max) {
        max = entry.completedAt
      }
    }
    if (max > this.#lastDeliveredAt) {
      this.#lastDeliveredAt = max
    }
  }

  resetCursor(): void {
    this.#lastDeliveredAt = 0
    this.#lastCompletedAt = 0
  }

  register(entry: Omit<BackgroundEntry, "status" | "exitInfo">): BackgroundEntry {
    if (this.#map.has(entry.id)) {
      throw new BackgroundRegistryError("duplicate", entry.id)
    }
    const value: MutableEntry = { ...entry, status: "running" }
    this.#map.set(entry.id, value)
    return value
  }

  lookup(id: string): BackgroundEntry | undefined {
    return this.#map.get(id)
  }

  list(): readonly BackgroundEntry[] {
    return Array.from(this.#map.values())
  }

  markExited(id: string, info: ShellExitInfo): void {
    const entry = this.#map.get(id)
    if (!entry) return
    entry.exitInfo = info
    const now = Math.max(Date.now(), this.#lastCompletedAt + 1)
    entry.completedAt = now
    this.#lastCompletedAt = now
    entry.status = info.reason === "abort" ? "killed" : info.reason === "exit" ? "exited" : "error"
  }

  async kill(id: string, signal: Signal): Promise<void> {
    const entry = this.#map.get(id)
    if (!entry) throw new BackgroundRegistryError("not-found", id)
    await Effect.runPromise(entry.shellCommand.kill(signal))
    entry.status = "killed"
  }

  async remove(id: string): Promise<void> {
    const entry = this.#map.get(id)
    if (!entry) return
    await Effect.runPromise(entry.shellCommand.cleanup())
    this.#map.delete(id)
  }

  async cleanupExited(maxAgeMs: number): Promise<number> {
    const now = Date.now()
    let removed = 0
    for (const [id, entry] of this.#map.entries()) {
      if (entry.status === "running") continue
      if (!entry.exitInfo) continue
      const age = now - entry.startedAt
      if (age < maxAgeMs) continue
      await Effect.runPromise(entry.shellCommand.cleanup())
      this.#map.delete(id)
      removed++
    }
    return removed
  }
}

export const backgroundRegistry = new BackgroundRegistry()

export function listBackgroundTasks(): string[] {
  return backgroundRegistry.list().map((x) => x.id)
}

export function listBackgroundTaskDetails(): Array<{
  id: string
  command: string
  cwd: string
  startTime: number
  endTime?: number
  pid?: number
  status: "running" | "completed" | "failed" | "killed" | "timeout"
  exitCode?: number | null
  outputPath?: string
}> {
  return backgroundRegistry.list().map((entry) => {
    const status =
      entry.status === "running"
        ? "running"
        : entry.status === "killed"
          ? "killed"
          : entry.status === "exited"
            ? "completed"
            : "failed"
    return {
      id: entry.id,
      command: entry.command,
      cwd: entry.cwd,
      startTime: entry.startedAt,
      endTime: entry.exitInfo ? Date.now() : undefined,
      pid: entry.pid,
      status,
      exitCode: entry.exitInfo?.code,
      outputPath: entry.outputPath,
    }
  })
}

export function getBackgroundTask(id: string) {
  const entry = backgroundRegistry.lookup(id)
  if (!entry) return undefined
  const status =
    entry.status === "running"
      ? "running"
      : entry.status === "killed"
        ? "killed"
        : entry.status === "exited"
          ? "completed"
          : "failed"
  return {
    id: entry.id,
    command: entry.command,
    cwd: entry.cwd,
    startTime: entry.startedAt,
    endTime: entry.exitInfo ? Date.now() : undefined,
    pid: entry.pid,
    status,
    exitCode: entry.exitInfo?.code,
    outputPath: entry.outputPath,
  }
}

export function removeBackgroundTask(id: string): boolean {
  const has = backgroundRegistry.lookup(id)
  if (!has) return false
  Effect.runFork(Effect.promise(() => backgroundRegistry.remove(id)))
  return true
}

export async function killBackgroundTask(id: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await backgroundRegistry.kill(id, "SIGTERM")
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function cleanupBackgroundTasks(maxAgeMs = 3600000): { removed: number; kept: number } {
  const before = backgroundRegistry.list().length
  Effect.runFork(Effect.promise(() => backgroundRegistry.cleanupExited(maxAgeMs)))
  const after = backgroundRegistry.list().length
  return { removed: Math.max(0, before - after), kept: after }
}
