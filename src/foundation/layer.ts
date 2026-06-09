import { Layer } from "effect"

// Foundation Layer 0 — no dependencies, no Effect services to provide.
// Foundation exports concrete utilities directly; it does not use Effect
// service injection. This Layer is a no-op placeholder that satisfies the
// composition-root wiring contract (every module has a Layer entry).
export const FoundationLayer: Layer.Layer<never, never, never> = Layer.empty
