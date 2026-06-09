/**
 * Error types for the intelgraph bus layer.
 * All errors are exported from this file so callers can import them directly
 * without depending on any specific bus implementation.
 */

// ── RequestBus errors ─────────────────────────────────────────────────────────

export class UnknownCommandError extends Error {
  readonly kind: string
  constructor(kind: string) {
    super(`No handler registered for command '${kind}'`)
    this.name = "UnknownCommandError"
    this.kind = kind
  }
}

export class DuplicateHandlerError extends Error {
  readonly kind: string
  constructor(kind: string) {
    super(`Handler already registered for command '${kind}'`)
    this.name = "DuplicateHandlerError"
    this.kind = kind
  }
}

export class CircularCommandError extends Error {
  readonly trace: readonly string[]
  constructor(trace: string[]) {
    super(`Circular command detected: ${trace.join(" → ")}`)
    this.name = "CircularCommandError"
    this.trace = trace
  }
}

export class BusDisposedError extends Error {
  constructor() {
    super("RequestBus has been disposed")
    this.name = "BusDisposedError"
  }
}

// ── StreamBus errors ──────────────────────────────────────────────────────────

export class StreamBusValidationError extends Error {
  readonly item: unknown
  constructor(message: string, item: unknown) {
    super(message)
    this.name = "StreamBusValidationError"
    this.item = item
  }
}

export class StreamBusClosedError extends Error {
  constructor() {
    super("StreamBus has been closed")
    this.name = "StreamBusClosedError"
  }
}
