// util/sleep.ts
//
// Abort-responsive sleep + timeout race wrapper (parity gap-26).
//
// PROVENANCE: cp'd from `instructkr-claude-code/src/utils/sleep.ts`
// then adapted to opencode:
//
//   * wrapped in a `Sleep` namespace following opencode convention
//     (Hash, Binary, Token, SecretScan, UnicodeSanitize, …).
//   * renamed `sleep()` → `Sleep.until()` to disambiguate from the
//     loose `sleep` symbol that already exists as a private helper
//     in `util/flock.ts:62` and `tool/notes/file-lock.ts:105`.
//     The original `sleep` name is kept as an alias on the namespace
//     so direct cp from Claude code still resolves.
//   * `withTimeout` kept verbatim — already a clean signature.
//
// MIGRATION TARGETS (future iterations):
//   * `util/flock.ts:62` private `sleep` → `Sleep.until` (matches the
//     existing throw-on-abort behaviour).
//   * `tool/notes/file-lock.ts:105` private `sleep` → `Sleep.until`
//     (currently has no abort support — gain it for free).
//
// Both migrations are mechanical drop-ins; left for follow-up
// iterations to keep this commit small and verifiably regression-
// free.

export namespace Sleep {
  /**
   * Abort-responsive sleep. Resolves after `ms` milliseconds, or
   * immediately when `signal` aborts (so backoff loops don't block
   * shutdown).
   *
   * By default, abort resolves SILENTLY; the caller should check
   * `signal.aborted` after the await. Pass `throwOnAbort: true` to
   * have abort reject — useful when the sleep is deep inside a retry
   * loop and you want the rejection to bubble up and cancel the
   * whole operation.
   *
   * Pass `abortError` to customize the rejection error (implies
   * `throwOnAbort: true`). Useful for retry loops that catch a
   * specific error class.
   *
   * Pass `unref: true` to call `.unref()` on the timer so it doesn't
   * block process exit.
   */
  export function until(
    ms: number,
    signal?: AbortSignal,
    opts?: { throwOnAbort?: boolean; abortError?: () => Error; unref?: boolean },
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // Check aborted state BEFORE setting up the timer. If we defined
      // onAbort first and called it synchronously here, it would
      // reference `timer` while still in the Temporal Dead Zone.
      if (signal?.aborted) {
        if (opts?.throwOnAbort || opts?.abortError) {
          void reject(opts.abortError?.() ?? new Error("aborted"))
        } else {
          void resolve()
        }
        return
      }
      const timer = setTimeout(
        (signal: AbortSignal | undefined, onAbort: () => void, resolve: () => void) => {
          signal?.removeEventListener("abort", onAbort)
          void resolve()
        },
        ms,
        signal,
        onAbort,
        resolve,
      )
      function onAbort(): void {
        clearTimeout(timer)
        if (opts?.throwOnAbort || opts?.abortError) {
          void reject(opts.abortError?.() ?? new Error("aborted"))
        } else {
          void resolve()
        }
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      if (opts?.unref) {
        timer.unref()
      }
    })
  }

  /**
   * Race a promise against a timeout. Rejects with `Error(message)`
   * if the promise doesn't settle within `ms`. The timeout timer is
   * cleared when the promise settles (no dangling timer) and unref'd
   * so it doesn't block process exit.
   *
   * Note: this DOES NOT cancel the underlying work — if the promise
   * is backed by a runaway async operation, that keeps running. This
   * just returns control to the caller.
   */
  export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(rejectWithTimeout, ms, reject, message)
      if (typeof timer === "object") timer.unref?.()
    })
    return Promise.race([promise, timeoutPromise]).finally(() => {
      if (timer !== undefined) clearTimeout(timer)
    })
  }

  // Alias matching the upstream Claude function name. Kept for parity
  // searches and to make porting Claude code easier.
  export const sleep = until
}

function rejectWithTimeout(reject: (e: Error) => void, message: string): void {
  reject(new Error(message))
}
