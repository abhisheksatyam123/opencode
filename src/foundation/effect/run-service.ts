import { Effect, Layer, ManagedRuntime } from "effect"
import * as ServiceMap from "effect/ServiceMap"
import { InstanceContextStorage } from "./instance-context"
import { Context } from "./context"
import { InstanceRef } from "./instance-ref"

// ── Contract ─────────────────────────────────────────────────────────────────
// makeRuntime() returns a runtime that shares ONE module-level memoMap with
// every other call — dependent layers are built once globally, so singleton
// services (Bus, Permission) yield the same instance no matter which runtime
// resolved them. This is load-bearing: Bus.Service must be a true singleton
// so events published via Permission's runtime reach subscribers registered
// via Bus's module-level runtime.
//
// The sharing is layer-graph only. Per-instance state (directory-keyed via
// InstanceState) is still isolated naturally because each Instance has its
// own directory key — no test pollution risk.
//
// Invariants:
//   - makeRuntime(svc, L) across N calls yields N runtimes, ONE L build
//   - resetAllRuntimes() clears each runtime's cached ManagedRuntime so the
//     next call re-creates one (still reusing the shared memoMap — that's
//     correct: the Layer graph is immutable, instances are what get recycled)
//   - passing `{ isolatedMemoMap: true }` opts OUT of sharing — used by the
//     few tests that need genuinely independent layer state
// Verified by test/effect/run-service.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

/** Shared memoMap — every `makeRuntime()` uses this by default so singleton
 *  layers (Bus, Permission, Config) build once and stay shared. */
export const memoMap = Layer.makeMemoMapUnsafe()

// Lazy registry stored on globalThis to survive circular-import TDZ.
// makeRuntime may be called before this module's own const declarations are
// initialized (project.ts → instance.ts → run-service.ts circular chain).
function getRegistry(): Array<{ reset: () => void }> {
  const g = globalThis as any // as any: globalThis has no index signature; __ocRuntimeRegistry is a private runtime slot
  if (!g.__ocRuntimeRegistry) g.__ocRuntimeRegistry = []
  return g.__ocRuntimeRegistry
}

/** Reset every runtime's cached ManagedRuntime. The shared memoMap is kept
 *  (layers are immutable); only the instance-holding runtime references are
 *  dropped so the next call constructs a fresh ManagedRuntime reusing the
 *  same layer cache. Use in test setup between test files. */
export function resetAllRuntimes() {
  for (const entry of getRegistry()) entry.reset()
}

function attach<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  try {
    const ctx = InstanceContextStorage.current
    return Effect.provideService(effect, InstanceRef, ctx)
  } catch (err) {
    if (!(err instanceof Context.NotFound)) throw err
  }
  return effect
}

export function makeRuntime<I, S, E>(
  service: ServiceMap.Service<I, S>,
  layer: Layer.Layer<I, E>,
  options?: { isolatedMemoMap?: boolean },
) {
  let rt: ManagedRuntime.ManagedRuntime<I, E> | undefined

  const getRuntime = () => {
    if (options?.isolatedMemoMap) {
      // Opt-out: fresh runtime with a fresh memoMap every call. Used by the
      // few tests that need genuinely independent layer state.
      return ManagedRuntime.make(layer)
    }
    // Default: shared module-level memoMap — singleton layers stay singleton.
    return (rt ??= ManagedRuntime.make(layer, { memoMap }))
  }

  // Register so resetAllRuntimes() can drop this runtime's cached reference
  // between test files. The shared memoMap is preserved — layers are immutable.
  getRegistry().push({
    reset: () => {
      rt = undefined
    },
  })

  return {
    runSync: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>) => getRuntime().runSync(attach(service.use(fn))),
    runPromiseExit: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>, options?: Effect.RunOptions) =>
      getRuntime().runPromiseExit(attach(service.use(fn)), options),
    runPromise: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>, options?: Effect.RunOptions) =>
      getRuntime().runPromise(attach(service.use(fn)), options),
    runFork: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>) => getRuntime().runFork(attach(service.use(fn))),
    runCallback: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>) =>
      getRuntime().runCallback(attach(service.use(fn))),
  }
}
