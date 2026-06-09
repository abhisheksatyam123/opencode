import z from "zod"
import { makeRuntime } from "@/foundation/effect/run-service"
import { Bus as BusTag, type BusEventDefinition } from "@/bus/contract/port"
import { BusAdapterLayer } from "@/bus/impl/adapter"

export const BusServiceTag = BusTag.Service
export const BusLayer = BusAdapterLayer

const { runPromise, runSync } = makeRuntime(BusServiceTag, BusLayer)

export function publish<D extends BusEventDefinition>(def: D, properties: z.output<D["properties"]>) {
  return runPromise((svc) => svc.publish(def, properties))
}

export function subscribe<D extends BusEventDefinition>(
  def: D,
  callback: (event: { type: D["type"]; properties: z.infer<D["properties"]> }) => unknown,
) {
  return runSync((svc) => svc.subscribeCallback(def, callback))
}

export function subscribeAll(callback: (event: any) => unknown) {
  return runSync((svc) => svc.subscribeAllCallback(callback))
}
