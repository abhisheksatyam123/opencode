/**
 * Bus L1 — Concrete adapter
 *
 * Implements BusPort using Effect PubSub + InstanceState (Foundation L0).
 * Wired into the Effect Layer in wiring/layer.ts.
 *
 * Depends only on:
 *   - Foundation L0: util/log, effect/instance-state, effect/run-service
 *   - Bus-internal: contract/schema.ts, impl/global.ts, contract/port.ts
 *   - Effect ecosystem: effect (PubSub, Stream, Scope, etc.)
 *
 * NO peer L1 imports (no storage, no filesystem).
 */

import z from "zod"
import { Effect, Exit, Layer, PubSub, Scope, Stream } from "effect"
import { Log } from "@/foundation/util/log"
import { BusEvent } from "@/bus/contract/schema"
import { GlobalBus } from "./global"
import { InstanceState } from "@/foundation/effect/instance-state"
import { Bus, type BusPayload, type BusEventDefinition } from "@/bus/contract/port"

const log = Log.create({ service: "bus" })

// ── Event definitions (re-exported for callers) ───────────────────────────────

export const SubagentPause = BusEvent.define("subagent.pause", z.object({ sessionID: z.string() }))

export const SubagentPaused = BusEvent.define(
  "subagent.paused",
  z.object({ sessionID: z.string(), reason: z.string().optional() }),
)

export const SubagentResume = BusEvent.define(
  "subagent.resume",
  z.object({
    sessionID: z.string(),
    modified_prompt: z.string().optional(),
  }),
)

export const SubagentResumed = BusEvent.define("subagent.resumed", z.object({ sessionID: z.string() }))

export const SubagentModelChange = BusEvent.define(
  "subagent.model.change",
  z.object({
    sessionID: z.string(),
    model: z.string(),
  }),
)

export const SubagentModelChanged = BusEvent.define(
  "subagent.model.changed",
  z.object({
    sessionID: z.string(),
    model: z.string(),
    previous_model: z.string(),
  }),
)

export const InstanceDisposed = BusEvent.define(
  "server.instance.disposed",
  z.object({
    directory: z.string(),
  }),
)

// ── Internal state ────────────────────────────────────────────────────────────

type State = {
  wildcard: PubSub.PubSub<BusPayload>
  typed: Map<string, PubSub.PubSub<BusPayload>>
}

// ── Adapter factory ───────────────────────────────────────────────────────────

/**
 * makeBusAdapter — builds the concrete BusPort implementation.
 * Called once inside BusLayer (wiring/layer.ts).
 */
export const makeBusAdapter = Effect.gen(function* () {
  const state = yield* InstanceState.make<State>(
    Effect.fn("Bus.state")(function* (ctx) {
      const wildcard = yield* PubSub.unbounded<BusPayload>()
      const typed = new Map<string, PubSub.PubSub<BusPayload>>()

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          // Publish InstanceDisposed before shutting down so subscribers see it
          yield* PubSub.publish(wildcard, {
            type: InstanceDisposed.type,
            properties: { directory: ctx.directory },
          })
          yield* PubSub.shutdown(wildcard)
          for (const ps of typed.values()) {
            yield* PubSub.shutdown(ps)
          }
        }),
      )

      return { wildcard, typed }
    }),
  )

  function getOrCreate<D extends BusEventDefinition>(s: State, def: D) {
    return Effect.gen(function* () {
      let ps = s.typed.get(def.type)
      if (!ps) {
        ps = yield* PubSub.unbounded<BusPayload>()
        s.typed.set(def.type, ps)
      }
      return ps as unknown as PubSub.PubSub<BusPayload<D>>
    })
  }

  function publish<D extends BusEventDefinition>(def: D, properties: z.output<D["properties"]>) {
    return Effect.gen(function* () {
      const s = yield* InstanceState.get(state)
      const payload: BusPayload = { type: def.type, properties }
      log.info("publishing", { type: def.type })

      const ps = s.typed.get(def.type)
      if (ps) yield* PubSub.publish(ps, payload)
      yield* PubSub.publish(s.wildcard, payload)

      const dir = yield* InstanceState.directory
      GlobalBus.emit("event", {
        directory: dir,
        payload,
      })
    })
  }

  function subscribe<D extends BusEventDefinition>(def: D): Stream.Stream<BusPayload<D>> {
    log.info("subscribing", { type: def.type })
    return Stream.unwrap(
      Effect.gen(function* () {
        const s = yield* InstanceState.get(state)
        const ps = yield* getOrCreate(s, def)
        return Stream.fromPubSub(ps)
      }),
    ).pipe(Stream.ensuring(Effect.sync(() => log.info("unsubscribing", { type: def.type }))))
  }

  function subscribeAll(): Stream.Stream<BusPayload> {
    log.info("subscribing", { type: "*" })
    return Stream.unwrap(
      Effect.gen(function* () {
        const s = yield* InstanceState.get(state)
        return Stream.fromPubSub(s.wildcard)
      }),
    ).pipe(Stream.ensuring(Effect.sync(() => log.info("unsubscribing", { type: "*" }))))
  }

  function on<T>(pubsub: PubSub.PubSub<T>, type: string, callback: (event: T) => unknown) {
    return Effect.gen(function* () {
      log.info("subscribing", { type })
      const scope = yield* Scope.make()
      const subscription = yield* Scope.provide(scope)(PubSub.subscribe(pubsub))

      yield* Scope.provide(scope)(
        Stream.fromSubscription(subscription).pipe(
          Stream.runForEach((msg) =>
            Effect.tryPromise({
              try: () => Promise.resolve().then(() => callback(msg)),
              catch: (cause) => {
                log.error("subscriber failed", { type, cause })
              },
            }).pipe(Effect.ignore),
          ),
          Effect.forkScoped,
        ),
      )

      return () => {
        log.info("unsubscribing", { type })
        Effect.runFork(Scope.close(scope, Exit.void))
      }
    })
  }

  const subscribeCallback = Effect.fn("Bus.subscribeCallback")(function* <D extends BusEventDefinition>(
    def: D,
    callback: (event: BusPayload<D>) => unknown,
  ) {
    const s = yield* InstanceState.get(state)
    const ps = yield* getOrCreate(s, def)
    return yield* on(ps, def.type, callback)
  })

  const subscribeAllCallback = Effect.fn("Bus.subscribeAllCallback")(function* (
    callback: (event: BusPayload) => unknown,
  ) {
    const s = yield* InstanceState.get(state)
    return yield* on(s.wildcard, "*", callback)
  })

  return Bus.Service.of({ publish, subscribe, subscribeAll, subscribeCallback, subscribeAllCallback })
})

/**
 * BusAdapterLayer — Effect Layer providing Bus.Service via the concrete adapter.
 * Import this in wiring/layer.ts to compose the full BusLayer.
 */
export const BusAdapterLayer = Layer.effect(Bus.Service, makeBusAdapter)
