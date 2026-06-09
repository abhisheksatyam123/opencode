export interface BackgroundTaskParsedResult {
  readonly structured?: boolean
  readonly empty?: boolean
  readonly [key: string]: unknown
}

export type BackgroundTaskResult = {
  output: string
  sessionId: string
  error?: string
  /** Structured error classification — set when error is a known failure kind. */
  error_kind?: "rate_limit" | "abort" | "subagent_error"
  /** Model that was used (or attempted) when the error occurred. */
  model?: string
  parsed?: BackgroundTaskParsedResult
}

type CompletedTaskEntry = BackgroundTaskResult & { completedAt: number }

export type BackgroundTaskRunningEntry = {
  id: string
  sessionId: string
  startedAt: number
  label: string
  agent?: string
  model?: string
}

class BackgroundTaskSlotStore {
  readonly #backgroundTasks = new Map<string, Promise<BackgroundTaskResult>>()
  readonly #runningTaskMetadata = new Map<string, BackgroundTaskRunningEntry>()
  readonly #bgTaskBySession = new Map<string, string>()
  readonly #completedTaskCache = new Map<string, CompletedTaskEntry>()

  #lastCompletedAt = 0
  #lastDeliveredAt = 0

  lookupTask(id: string): Promise<BackgroundTaskResult> | undefined {
    return this.#backgroundTasks.get(id)
  }

  setTask(id: string, task: Promise<BackgroundTaskResult>, metadata?: Omit<BackgroundTaskRunningEntry, "id">): void {
    this.#backgroundTasks.set(id, task)
    this.#runningTaskMetadata.set(id, {
      id,
      sessionId: metadata?.sessionId ?? (id.startsWith("bg_") ? id.slice(3) : id),
      startedAt: metadata?.startedAt ?? Date.now(),
      label: metadata?.label ?? id,
      agent: metadata?.agent,
      model: metadata?.model,
    })
  }

  deleteTask(id: string): boolean {
    this.#runningTaskMetadata.delete(id)
    return this.#backgroundTasks.delete(id)
  }

  hasTask(id: string): boolean {
    return this.#backgroundTasks.has(id)
  }

  lookupTaskIdForSession(sessionID: string): string | undefined {
    return this.#bgTaskBySession.get(sessionID)
  }

  setTaskIdForSession(sessionID: string, bgID: string): void {
    this.#bgTaskBySession.set(sessionID, bgID)
  }

  deleteTaskIdForSession(sessionID: string): boolean {
    return this.#bgTaskBySession.delete(sessionID)
  }

  killSlotForSession(sessionID: string): { killed: boolean; bgID: string } {
    const bgID = this.#bgTaskBySession.get(sessionID) ?? `bg_${sessionID}`
    const killed = this.#backgroundTasks.delete(bgID)
    this.#runningTaskMetadata.delete(bgID)
    this.#bgTaskBySession.delete(sessionID)
    this.#completedTaskCache.delete(bgID)
    return { killed, bgID }
  }

  listRunning(): BackgroundTaskRunningEntry[] {
    const out: BackgroundTaskRunningEntry[] = []
    for (const id of this.#backgroundTasks.keys()) {
      if (!this.#completedTaskCache.has(id)) {
        const metadata = this.#runningTaskMetadata.get(id)
        out.push(
          metadata ?? {
            id,
            sessionId: id.startsWith("bg_") ? id.slice(3) : id,
            startedAt: Date.now(),
            label: id,
          },
        )
      }
    }
    return out.sort((a, b) => a.startedAt - b.startedAt)
  }

  lookupCompletedTask(id: string): BackgroundTaskResult | undefined {
    return this.#completedTaskCache.get(id)
  }

  storeCompletedTask(id: string, result: BackgroundTaskResult): void {
    const now = Math.max(Date.now(), this.#lastCompletedAt + 1)
    this.#lastCompletedAt = now
    this.#completedTaskCache.set(id, { ...result, completedAt: now })
    setTimeout(() => this.#completedTaskCache.delete(id), 5 * 60 * 1000)
  }

  deleteCompletedTask(id: string): boolean {
    return this.#completedTaskCache.delete(id)
  }

  completedSince(ts: number): Array<{ id: string; result: BackgroundTaskResult; completedAt: number }> {
    const out: Array<{ id: string; result: BackgroundTaskResult; completedAt: number }> = []
    for (const [id, v] of this.#completedTaskCache.entries()) {
      if (v.completedAt > ts) out.push({ id, result: v, completedAt: v.completedAt })
    }
    return out.sort((a, b) => a.completedAt - b.completedAt)
  }

  getLastDeliveredAt(): number {
    return this.#lastDeliveredAt
  }

  markDelivered(ids: string[]): void {
    let max = this.#lastDeliveredAt
    for (const id of ids) {
      const v = this.#completedTaskCache.get(id)
      if (v && v.completedAt > max) max = v.completedAt
    }
    if (max > this.#lastDeliveredAt) this.#lastDeliveredAt = max
  }

  resetCursor(): void {
    this.#lastDeliveredAt = 0
    this.#lastCompletedAt = 0
    this.#completedTaskCache.clear()
    this.#runningTaskMetadata.clear()
  }

  hasKnownTaskId(id: string): boolean {
    if (!id) return false
    if (this.#backgroundTasks.has(id)) return true
    if (this.#completedTaskCache.has(id)) return true
    return /^(ses|bg_ses)_/.test(id)
  }
}

export const BackgroundTaskSlots = new BackgroundTaskSlotStore()
