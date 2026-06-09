/**
 * Public API of the intelgraph bus layer.
 * Only interfaces, types, and errors are exported here.
 * Implementations live in src/bus/impl/ (not yet created — Phase 1 [2],[3],[4]).
 */

export type { Disposable, Command, BusEvent, StreamSink } from "./types.js"
export type { RequestBus } from "./request-bus.js"
export type { EventBus, EventBusOptions } from "./event-bus.js"
export type { StreamBus, StreamBusOptions, StreamBusReport } from "./stream-bus.js"
export {
  UnknownCommandError,
  DuplicateHandlerError,
  CircularCommandError,
  BusDisposedError,
  StreamBusValidationError,
  StreamBusClosedError,
} from "./errors.js"
