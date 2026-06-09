// tool/concurrency-lock.ts
//
// Per-session readers-writers lock for tool dispatch (gap-3-followup-2a).
//
// PROVENANCE: the model comes from
// `instructkr-claude-code/src/services/tools/StreamingToolExecutor.ts`
// where the executor's `canExecuteTool(isConcurrencySafe)` rule is:
//
//   "A tool may execute if either no tools are currently running, OR
//    every currently-executing tool is concurrency-safe AND this tool
//    is also concurrency-safe."
//
// opencode dispatches tools through the Vercel AI SDK's `streamText`,
// which already calls `execute()` for sibling tool_use blocks in
// parallel. Without coordination, an unsafe tool (`edit`, `bash`,
// `task op=note`, …) could run concurrently with a sibling read or
// search, racing on the same file or shared state.
//
// This module's `Lock` class is the smallest primitive that enforces
// the StreamingToolExecutor rule on top of the AI SDK's parallel
// dispatch: each tool acquires the lock before running and releases
// it after. Safe tools can hold the lock concurrently; unsafe tools
// require exclusive access. Acquisition is FIFO over the waiter
// queue, so unsafe tools cannot be starved by a steady stream of
// incoming safe tools.
//
// SCOPE OF THIS PORT:
//   - The Lock primitive itself (this file)
//   - Wiring in `session/prompt.ts` `resolveTools` so each tool's
//     execute wrapper acquires the appropriate ticket
//   - Tests for the lock under stress
//
// NOT in scope (deferred to gap-3-followup-2b):
//   - Sibling-error cascade — when one tool in a parallel batch
//     errors, abort the others. This requires hooking the AI SDK's
//     step boundaries, which is a bigger surface change.
//   - Re-entrancy / lock inheritance for nested tool dispatch
//     (the task tool spawning subagent tools). The current code
//     acquires a fresh lock per `resolveTools` call, so subagents
//     get their own lock and don't inherit the parent's.

export namespace ConcurrencyLock {
  type Waiter = {
    safe: boolean
    resolve: (release: () => void) => void
  }

  /**
   * Per-session readers-writers lock. Safe tools are "readers" — many
   * may hold the lock at once. Unsafe tools are "writers" — they
   * require exclusive access (no other safe or unsafe tool active).
   *
   * Fairness: waiters are admitted in FIFO order. An unsafe waiter at
   * the head of the queue blocks all subsequent waiters until it has
   * been admitted, preventing writer starvation.
   */
  export class Lock {
    private activeSafe = 0
    private activeUnsafe = 0
    private waiters: Waiter[] = []

    /**
     * Acquire a ticket. The returned promise resolves once the caller
     * is allowed to proceed; the resolved value is a `release()`
     * function the caller MUST invoke (typically in a `try/finally`)
     * once the protected work is done.
     */
    acquire(safe: boolean): Promise<() => void> {
      return new Promise((resolve) => {
        const waiter: Waiter = { safe, resolve }
        this.waiters.push(waiter)
        this.drain()
      })
    }

    /**
     * Convenience wrapper: acquire the lock, run `fn`, release.
     * Always releases even if `fn` throws.
     */
    async run<T>(safe: boolean, fn: () => Promise<T>): Promise<T> {
      const release = await this.acquire(safe)
      try {
        return await fn()
      } finally {
        release()
      }
    }

    /**
     * Snapshot of the lock state. Useful for tests and debugging.
     * Not part of the dispatch path.
     */
    state(): { activeSafe: number; activeUnsafe: number; queued: number } {
      return {
        activeSafe: this.activeSafe,
        activeUnsafe: this.activeUnsafe,
        queued: this.waiters.length,
      }
    }

    private canAdmit(safe: boolean): boolean {
      // No tool can run while an unsafe tool holds the lock.
      if (this.activeUnsafe > 0) return false
      // An unsafe tool can only enter when the lock is fully idle.
      if (!safe && this.activeSafe > 0) return false
      return true
    }

    private release(safe: boolean): void {
      if (safe) {
        this.activeSafe = Math.max(0, this.activeSafe - 1)
      } else {
        this.activeUnsafe = Math.max(0, this.activeUnsafe - 1)
      }
      this.drain()
    }

    /**
     * Walk the waiter queue head-to-tail and admit as many as the
     * current lock state allows. Stops at the first waiter that
     * cannot be admitted (preserving FIFO fairness — a blocked
     * unsafe waiter is a barrier for everything behind it).
     */
    private drain(): void {
      while (this.waiters.length > 0) {
        const next = this.waiters[0]!
        if (!this.canAdmit(next.safe)) break
        this.waiters.shift()
        if (next.safe) {
          this.activeSafe += 1
        } else {
          this.activeUnsafe += 1
        }
        const safe = next.safe
        next.resolve(() => this.release(safe))
        // After admitting an unsafe writer the lock is fully held,
        // so no further admissions are possible until the writer
        // releases. Break out to avoid wasted iterations.
        if (!safe) break
      }
    }
  }
}
