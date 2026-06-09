/**
 * Bus L1 — Port contract
 *
 * Exposes:
 *   - BusEventDefinitionSchema / BusEventDefinition  — typed event descriptor
 *   - BusPayloadSchema / BusPayload                  — wire payload shape
 *   - BusPort interface                              — publish/subscribe surface
 *   - Bus.Service Effect.Tag                         — DI tag for Effect Layer
 *
 * Depends only on Foundation L0 (zod, effect). No peer L1 imports.
 */

import z from "zod"
import { Effect, ServiceMap, Stream } from "effect"
import type { ZodType } from "zod"
export * from "@/bus/contract/version"
export * from "@/bus/contract/identity"
export * from "@/bus/contract/error"
export * from "@/bus/contract/event"
export * from "@/bus/contract/conformance"
export * from "@/bus/contract/schema"

// ── Event definition ──────────────────────────────────────────────────────────

/**
 * Schema for a bus event definition descriptor.
 * Concrete definitions are created via BusEvent.define() in contract/schema.ts.
 */
export const BusEventDefinitionSchema = z.object({
  type: z.string().min(1),
  properties: z.custom<ZodType>((v) => v != null && typeof (v as any).parse === "function"), // as any: z.custom validator receives unknown; duck-typing .parse is intentional
})
export type BusEventDefinition = z.infer<typeof BusEventDefinitionSchema>

// ── Payload ───────────────────────────────────────────────────────────────────

/**
 * A typed bus payload: the event type discriminant + validated properties.
 *
 * AC-5 exception: `properties` is `z.record(z.string(), z.unknown())` because
 * payload shape is per-event-definition. Concrete shapes are declared by each
 * `BusEventDefinition.properties` schema and validated at publish-site (see
 * `Bus.publish`/`subscribe` in `index.ts`, both narrow via
 * `z.infer<D["properties"]>`). Constraining the envelope here would force a
 * generic type parameter on `BusPayloadSchema` itself, which Zod cannot
 * express cleanly without runtime-erased discriminated unions. Static type
 * safety is preserved by the generic `BusPayload<D>` type below.
 */
export const BusPayloadSchema = z.object({
  type: z.string().min(1),
  properties: z.record(z.string(), z.unknown()),
})
export type BusPayload<D extends BusEventDefinition = BusEventDefinition> = {
  type: D["type"]
  properties: z.infer<D["properties"]>
}

// ── Port interface ────────────────────────────────────────────────────────────

/**
 * BusPort — abstract interface for the in-process pub/sub backbone.
 *
 * All cross-module event emission and subscription routes through this port.
 * Concrete adapter lives in impl/adapter.ts; wired via wiring/layer.ts.
 */
export interface BusPort {
  /**
   * Publish a typed event. Delivers to both typed and wildcard subscribers.
   */
  readonly publish: <D extends BusEventDefinition>(def: D, properties: z.output<D["properties"]>) => Effect.Effect<void>

  /**
   * Subscribe to a specific event type. Returns a Stream of typed payloads.
   */
  readonly subscribe: <D extends BusEventDefinition>(def: D) => Stream.Stream<BusPayload<D>>

  /**
   * Subscribe to all events (wildcard). Returns a Stream of untyped payloads.
   */
  readonly subscribeAll: () => Stream.Stream<BusPayload>

  /**
   * Subscribe to a specific event type via callback. Returns an unsubscribe fn.
   * The Effect is synchronous-safe (no async steps in the subscription chain).
   */
  readonly subscribeCallback: <D extends BusEventDefinition>(
    def: D,
    callback: (event: BusPayload<D>) => unknown,
  ) => Effect.Effect<() => void>

  /**
   * Subscribe to all events via callback. Returns an unsubscribe fn.
   */
  readonly subscribeAllCallback: (callback: (event: BusPayload) => unknown) => Effect.Effect<() => void>
}

// ── Effect.Tag (DI service) ───────────────────────────────────────────────────

export namespace Bus {
  /**
   * Effect.Tag for the Bus service. Concrete impl provided by BusLayer in wiring/layer.ts.
   * Callers: `yield* Bus.Service` to access the BusPort.
   */
  export class Service extends ServiceMap.Service<Service, BusPort>()("@opencode/Bus") {}
}
