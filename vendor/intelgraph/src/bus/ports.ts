/**
 * Canonical bus-module ports.
 *
 * Consumers should `import from "@/bus/ports"` rather than reaching into
 * individual per-bus files. Each interface is defined in its home file
 * (request-bus.ts, event-bus.ts, stream-bus.ts, types.ts); this file
 * only re-exports them so every intelgraph module has a uniform
 * `<module>/ports.ts` entry point — the convention documented in
 * `specification/intelgraph-specification-index.md`.
 *
 * To add a new bus-layer port, put the interface in its home file and
 * add a re-export here.
 */

export type { Disposable, Command, BusEvent, StreamSink } from "./types.js"
export type { RequestBus } from "./request-bus.js"
export type { EventBus, EventBusOptions } from "./event-bus.js"
export type { StreamBus, StreamBusOptions, StreamBusReport } from "./stream-bus.js"
