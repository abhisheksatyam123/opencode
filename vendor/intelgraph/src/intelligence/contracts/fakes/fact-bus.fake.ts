import type { FactBusReport, IFactBus } from "../fact-bus.js"
import type { Fact, FactKind } from "../../extraction/facts.js"
import { canonicalKey, mergeFacts, validateFact } from "../../extraction/facts.js"

/**
 * In-memory IFactBus. Buffers accepted facts in a dedup map keyed by
 * `canonicalKey(fact)` — canonical keys already namespace by kind, so
 * one map suffices where the real impl splits by kind for flush speed.
 *
 * Suitable for:
 *   - port-contract suites (runs the same invariants against real + fake)
 *   - consumer unit tests needing an IFactBus without a real
 *     GraphWriteSink or snapshot id
 *
 * NOT suitable for: production. No batch serialization, no sink wiring.
 */
export class FakeFactBus implements IFactBus {
  private readonly buffer = new Map<string, Fact>()
  private readonly flushed: Fact[] = []
  private totalAccepted = 0
  private totalEmits = 0
  private readonly byKind: Record<FactKind, number> = {
    symbol: 0,
    type: 0,
    "aggregate-field": 0,
    edge: 0,
    evidence: 0,
    observation: 0,
  }
  private readonly byExtractor: Record<string, number> = {}
  private flushCount = 0
  private closedFlag = false

  async emit(fact: Fact): Promise<Fact> {
    if (this.closedFlag) {
      throw new Error("[fake-fact-bus] cannot emit on a closed bus")
    }

    validateFact(fact)
    this.totalEmits++

    const key = canonicalKey(fact)
    const existing = this.buffer.get(key)

    if (existing) {
      const merged = mergeFacts(existing, fact)
      this.buffer.set(key, merged)
      return merged
    }

    this.buffer.set(key, fact)
    this.totalAccepted++
    this.byKind[fact.kind]++
    for (const producer of fact.producedBy) {
      this.byExtractor[producer] = (this.byExtractor[producer] ?? 0) + 1
    }
    return fact
  }

  async flush(): Promise<void> {
    if (this.buffer.size === 0) return
    this.flushed.push(...this.buffer.values())
    this.buffer.clear()
    this.flushCount++
  }

  async close(): Promise<void> {
    if (this.closedFlag) return
    await this.flush()
    this.closedFlag = true
  }

  report(): FactBusReport {
    return {
      totalAccepted: this.totalAccepted,
      totalEmits: this.totalEmits,
      byKind: { ...this.byKind },
      byExtractor: { ...this.byExtractor },
      flushCount: this.flushCount,
      closed: this.closedFlag,
    }
  }

  // ---- Test hooks (not part of IFactBus) ----

  /** All facts currently buffered (not yet flushed). */
  buffered(): ReadonlyArray<Fact> {
    return Array.from(this.buffer.values())
  }

  /** All facts ever flushed to the sink, in flush order. */
  flushedFacts(): ReadonlyArray<Fact> {
    return this.flushed
  }
}
