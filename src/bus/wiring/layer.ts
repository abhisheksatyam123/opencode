/**
 * Bus L1 — Effect Layer
 *
 * BusLayer is the single entry point for wiring the Bus module.
 * Import this at the composition root (src/index.ts or src/node.ts).
 *
 * Provides: Bus.Service
 * Requires: nothing (InstanceState is self-contained in Foundation L0)
 */

export { BusAdapterLayer as BusLayer } from "@/bus/impl"
export { Bus } from "@/bus/contract/port"
