/**
 * Creates an AbortController that automatically aborts after a timeout.
 *
 * Uses bind() instead of arrow functions to avoid capturing the surrounding
 * scope in closures. Arrow functions like `() => controller.abort()` capture
 * request bodies and other large objects, preventing GC for the timer lifetime.
 *
 * @param ms Timeout in milliseconds
 * @returns Object with controller, signal, and clearTimeout function
 */
export function abortAfter(ms: number) {
  const controller = new AbortController()
  const id = setTimeout(controller.abort.bind(controller), ms)
  return {
    controller,
    signal: controller.signal,
    clearTimeout: () => globalThis.clearTimeout(id),
  }
}

/**
 * Combines multiple AbortSignals with a timeout.
 *
 * @param ms Timeout in milliseconds
 * @param signals Additional signals to combine
 * @returns Combined signal that aborts on timeout or when any input signal aborts
 */
export function abortAfterAny(ms: number, ...signals: AbortSignal[]) {
  const timeout = abortAfter(ms)
  const signal = AbortSignal.any([timeout.signal, ...signals])
  return {
    signal,
    clearTimeout: timeout.clearTimeout,
  }
}

// Default max listeners for an abort signal. Above this Node prints
// MaxListenersExceededWarning. opencode's long-running session loops
// can attach 10-30 abort listeners across nested tools + LSP clients
// + plugins, so the default of 50 is generous enough that the
// warning never fires for normal workloads but still bounds runaway
// listener accumulation.
const DEFAULT_ABORT_MAX_LISTENERS = 50

/**
 * Create an AbortController with a configured listener cap.
 *
 * Wraps `new AbortController()` + `setMaxListeners(n, controller.signal)`
 * so the controller's signal does not trip
 * `MaxListenersExceededWarning` when many concurrent operations
 * subscribe to it. opencode's session loop attaches a listener per
 * in-flight tool call, per LSP client, and per plugin hook — the
 * default of 50 is generous for typical workloads.
 *
 * PROVENANCE: ported from
 * `instructkr-claude-code/src/utils/abortController.ts:createAbortController`.
 *
 * @param maxListeners Maximum listeners on the signal (default 50)
 */
export function createAbortController(maxListeners: number = DEFAULT_ABORT_MAX_LISTENERS): AbortController {
  // Lazy import so the events module isn't loaded by every consumer
  // of util/abort.ts (e.g. browser-style targets that don't have
  // events available). require() falls through cleanly when
  // setMaxListeners isn't available.
   
  const events = require("events") as typeof import("events")
  const controller = new AbortController()
  if (typeof events.setMaxListeners === "function") {
    events.setMaxListeners(maxListeners, controller.signal)
  }
  return controller
}

// ---------------------------------------------------------------------------
// Child / parent abort propagation (parity gap-51)
// ---------------------------------------------------------------------------
//
// PROVENANCE: ported from
// `instructkr-claude-code/src/utils/abortController.ts:createChildAbortController`.
// The Claude reference uses WeakRef so a long-lived parent controller
// can have many short-lived children that GC normally even if they
// are dropped without being aborted. This is the right shape for
// opencode's session loops where the top-level session controller is
// a parent for many nested tool/subagent controllers.
//
// HOW THE WEAKREF PATTERN WORKS
// =============================
// Naive parent-tracks-child via a Set<AbortController> would prevent
// any child from being GC'd as long as the parent is alive — even
// after the caller has dropped all references to the child. WeakRef
// lets the parent track only a *weak* reference to the child, so the
// child can be GC'd while the parent's listener stays armed against
// a now-dead WeakRef. When the parent eventually aborts, the dead
// WeakRef.deref() returns undefined and the listener becomes a
// no-op.
//
// CLEANUP ON CHILD ABORT
// ======================
// When the child IS aborted (by any source — directly, via parent
// propagation, via a sibling), the listener is removed from the
// parent's signal so dead handlers don't accumulate over the parent's
// lifetime. Both parent and handler are weakly held in the cleanup
// path, so a GC'd parent or already-aborted parent makes the cleanup
// a harmless no-op.

/**
 * Internal: propagate abort from a parent (weakly held) to a child
 * (weakly held). Module-scope so the function isn't reallocated per
 * call — passed as `this` via .bind() inside createChildAbortController.
 */
function propagateAbortToChild(this: WeakRef<AbortController>, weakChild: WeakRef<AbortController>): void {
  const parent = this.deref()
  weakChild.deref()?.abort(parent?.signal.reason)
}

/**
 * Internal: remove an abort handler from a parent (weakly held).
 * Module-scope to avoid per-call closure allocation.
 */
function removeAbortHandlerFromParent(
  this: WeakRef<AbortController>,
  weakHandler: WeakRef<(...args: unknown[]) => void>,
): void {
  const parent = this.deref()
  const handler = weakHandler.deref()
  if (parent && handler) {
    parent.signal.removeEventListener("abort", handler)
  }
}

/**
 * Create a child AbortController that aborts when its parent aborts.
 * Aborting the child does NOT affect the parent.
 *
 * Memory-safe: uses WeakRef so the parent doesn't retain abandoned
 * children. If the child is dropped without being aborted, it can
 * still be GC'd. When the child IS aborted, the parent listener is
 * removed to prevent accumulation of dead handlers.
 *
 * Fast path: if the parent has already aborted, the child is created
 * pre-aborted (with the parent's reason) and no listener is set up.
 *
 * @param parent The parent AbortController whose abort propagates here
 * @param maxListeners Maximum listeners on the child signal (default 50)
 * @returns A child AbortController
 */
export function createChildAbortController(
  parent: AbortController,
  maxListeners?: number,
): AbortController {
  const child = createAbortController(maxListeners)

  // Fast path: parent already aborted → propagate immediately, no listener.
  if (parent.signal.aborted) {
    child.abort(parent.signal.reason)
    return child
  }

  // WeakRef prevents the parent from keeping an abandoned child alive.
  // If all strong references to the child are dropped without aborting
  // it, the child can still be GC'd — the parent only holds a dead
  // WeakRef.
  const weakChild = new WeakRef(child)
  const weakParent = new WeakRef(parent)
  const handler = propagateAbortToChild.bind(weakParent, weakChild)

  parent.signal.addEventListener("abort", handler, { once: true })

  // Auto-cleanup: remove the parent listener when the child aborts
  // (from any source). Both parent and handler are weakly held — if
  // either has been GC'd or the parent already aborted ({once: true}
  // already removed it), the cleanup is a harmless no-op.
  child.signal.addEventListener(
    "abort",
    removeAbortHandlerFromParent.bind(weakParent, new WeakRef(handler)),
    { once: true },
  )

  return child
}

// ---------------------------------------------------------------------------
// Combined abort signal (parity gap-53)
// ---------------------------------------------------------------------------
//
// PROVENANCE: ported from
// `instructkr-claude-code/src/utils/combinedAbortSignal.ts` (47 LOC).
// Sister helper to createChildAbortController (gap-51): combines an
// input signal + optional second signal + optional timeout into one
// signal that aborts when ANY of the three fire. Returns an explicit
// `cleanup` function that removes ALL attached listeners + clears
// the timeout timer.
//
// WHY THE EXPLICIT CLEANUP MATTERS
// ================================
// opencode's existing `abortAfterAny()` returns `{signal, clearTimeout}`
// — only the timeout timer can be cleared. The abort listeners
// attached to the input signals stay registered until the input
// signals are GC'd. In a long-running session that creates many
// short-lived combined signals (one per request, one per LSP call,
// one per tool execution), these listeners accumulate on the
// long-lived parent signal and the parent eventually trips
// MaxListenersExceededWarning OR holds memory the listeners
// reference. The explicit cleanup function lets the caller release
// the listeners when the combined signal is no longer needed.
//
// WHY NOT USE AbortSignal.timeout(ms) FOR THE TIMEOUT
// ====================================================
// Under Bun, AbortSignal.timeout timers are finalized lazily and
// accumulate in native memory until they fire (~2.4KB/call held for
// the full timeout duration). For a session with 1000 short-lived
// 30-second timeouts, that's ~2.4MB of native memory pinned for
// 30s after each call. Using `setTimeout` + `clearTimeout` releases
// the timer immediately when cleanup() is called or when one of the
// input signals aborts first.

export interface CombinedSignalOptions {
  signalB?: AbortSignal
  timeoutMs?: number
}

export interface CombinedSignal {
  signal: AbortSignal
  cleanup: () => void
}

/**
 * Create a combined AbortSignal that aborts when:
 *   - the input `signal` aborts, OR
 *   - the optional `signalB` aborts, OR
 *   - the optional `timeoutMs` elapses
 *
 * Returns the combined signal AND an explicit `cleanup` function
 * that removes all attached abort listeners + clears the internal
 * timeout timer. ALWAYS call cleanup() when the combined signal is
 * no longer needed — failing to call it leaks listeners on the
 * input signals (which is the most common cause of
 * MaxListenersExceededWarning in long sessions).
 *
 * Fast path: if `signal` or `signalB` has already aborted at call
 * time, the combined signal is created pre-aborted and the returned
 * cleanup is a no-op (no listeners attached).
 *
 * @param signal The primary input signal (may be undefined)
 * @param opts Optional second signal + optional timeout
 * @returns { signal, cleanup } — caller must call cleanup() when done
 */
export function createCombinedAbortSignal(
  signal: AbortSignal | undefined,
  opts?: CombinedSignalOptions,
): CombinedSignal {
  const signalB = opts?.signalB
  const timeoutMs = opts?.timeoutMs
  const combined = createAbortController()

  // Fast path: either input is already aborted → pre-abort the
  // combined signal and return a no-op cleanup. No listeners
  // attached, no timer started.
  if (signal?.aborted || signalB?.aborted) {
    combined.abort()
    return {
      signal: combined.signal,
      cleanup: () => {
        // intentional no-op — no resources to release
      },
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined

  // The single handler triggers the combined controller AND clears
  // the pending timer (if any) so resources are released as soon as
  // possible — even before cleanup() is called explicitly.
  const abortCombined = () => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    combined.abort()
  }

  if (timeoutMs !== undefined) {
    timer = setTimeout(abortCombined, timeoutMs)
    // Don't keep the process alive just for this timer.
    timer.unref?.()
  }
  signal?.addEventListener("abort", abortCombined)
  signalB?.addEventListener("abort", abortCombined)

  const cleanup = () => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    signal?.removeEventListener("abort", abortCombined)
    signalB?.removeEventListener("abort", abortCombined)
  }

  return { signal: combined.signal, cleanup }
}
