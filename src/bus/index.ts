/**
 * Bus L1 — Public barrel (backward-compatible)
 *
 * Exports the `Bus` namespace with the same API surface as the original index.ts.
 * Implementation lives in adapter.ts; port contract in port.ts.
 *
 * New code may import from "@/bus/contract/port" or "@/bus/wiring/layer" directly.
 */

import {
  SubagentPause as _SubagentPause,
  SubagentPaused as _SubagentPaused,
  SubagentResume as _SubagentResume,
  SubagentResumed as _SubagentResumed,
  SubagentModelChange as _SubagentModelChange,
  SubagentModelChanged as _SubagentModelChanged,
  InstanceDisposed as _InstanceDisposed,
} from "@/bus/impl/adapter"
import { Bus as _BusTag, type BusPort, type BusEventDefinition } from "@/bus/contract/port"
import {
  BusLayer,
  BusServiceTag,
  publish as publishRuntime,
  subscribe as subscribeRuntime,
  subscribeAll as subscribeAllRuntime,
} from "@/bus/impl/runtime"

// Re-export BusEvent helper + public concrete bus utilities
export { BusEvent } from "@/bus/bus-event"
export { GlobalBus } from "./impl/global"
export { WatchManager } from "./impl/registry-watch"

// Re-export port types for callers that need them
export type { BusPort, BusPayload, BusEventDefinition } from "@/bus/contract/port"

const BusEvents = {
  SubagentPause: _SubagentPause,
  SubagentPaused: _SubagentPaused,
  SubagentResume: _SubagentResume,
  SubagentResumed: _SubagentResumed,
  SubagentModelChange: _SubagentModelChange,
  SubagentModelChanged: _SubagentModelChanged,
  InstanceDisposed: _InstanceDisposed,
}

// ── Bus namespace (mirrors original API exactly) ───────────────────────────────

export namespace Bus {
  // Effect.Tag class — used both as value (`yield* Bus.Service`) and as type
  // (`Layer<..., Bus.Service>`). Re-exporting the class preserves both usages.
  export const Service = BusServiceTag
  // Instance type (used in Layer<..., Bus.Service> type annotations)
  export type Service = _BusTag.Service

  // Interface type alias — callers use `Bus.Interface` as the type of the bus value
  export type Interface = BusPort

  // Effect Layer (for composition root: `Layer.provide(Bus.layer)`)
  export const layer = BusLayer

  // Event definitions (previously defined inline in this file)
  export const SubagentPause = BusEvents.SubagentPause
  export const SubagentPaused = BusEvents.SubagentPaused
  export const SubagentResume = BusEvents.SubagentResume
  export const SubagentResumed = BusEvents.SubagentResumed
  export const SubagentModelChange = BusEvents.SubagentModelChange
  export const SubagentModelChanged = BusEvents.SubagentModelChanged
  export const InstanceDisposed = BusEvents.InstanceDisposed

  // Static async publish (fire-and-forget from non-Effect code)
  export const publish = publishRuntime

  // Static sync subscribe (returns unsubscribe fn)
  export const subscribe = subscribeRuntime

  // Static sync subscribeAll (returns unsubscribe fn)
  export const subscribeAll = subscribeAllRuntime
}
