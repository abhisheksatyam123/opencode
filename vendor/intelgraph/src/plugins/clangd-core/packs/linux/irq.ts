/**
 * packs/linux/irq.ts — Linux hardware interrupt registration.
 *
 * Patterns for the request_irq family. The IRQ chip / domain ops style
 * (where handlers are placed in struct fields like irq_chip.irq_ack) is
 * handled by the GENERIC struct-field-callback fallback in
 * detector.ts:classifyGenericStructFieldCallback — no per-field hardcoding
 * is needed here.
 */

import type { CallPattern } from "../types.js"

const irqPatterns: readonly CallPattern[] = [
  {
    name: "request_irq",
    registrationApi: "request_irq",
    connectionKind: "hw_interrupt",
    keyArgIndex: 0,
    keyDescription: "IRQ number",
  },
  {
    name: "request_threaded_irq",
    registrationApi: "request_threaded_irq",
    connectionKind: "hw_interrupt",
    keyArgIndex: 0,
    keyDescription: "IRQ number",
  },
  {
    name: "devm_request_irq",
    registrationApi: "devm_request_irq",
    connectionKind: "hw_interrupt",
    keyArgIndex: 1,
    keyDescription: "IRQ number (devm-managed)",
  },
  {
    name: "devm_request_threaded_irq",
    registrationApi: "devm_request_threaded_irq",
    connectionKind: "hw_interrupt",
    keyArgIndex: 1,
    keyDescription: "IRQ number (devm-managed, threaded)",
  },
]

export default irqPatterns
