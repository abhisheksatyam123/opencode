import { describe, it, expect } from "vitest"
import { TokenEstimate } from "@/process/session/token-estimate"
import { isOverflow } from "@/process/session/overflow"

describe("Compaction Trigger Alignment", () => {
  const mockModel = {
    id: "test-model",
    providerID: "test-provider",
    api: { id: "test-model" },
    limit: {
      context: 200000,
      output: 4096,
    },
    options: {},
    headers: {},
  } as any

  it("should match isOverflow and wouldOverflow when no trigger_tokens is set", async () => {
    // Model limit is 200k. Output reserve is min(20k, maxOutput) = 4096.
    // Usable is 200k - 4096 = 195904.
    const system = ["system prompt content"]
    const messages = [{ role: "user" as const, content: "hello" }]
    
    // Check below threshold
    const estimateBelow = TokenEstimate.wouldOverflow({
      system,
      messages,
      tools: {},
      model: mockModel,
    })
    expect(estimateBelow.overflow).toBe(false)
    expect(estimateBelow.usable).toBe(195904)

    // isOverflow check below
    const overflowBelow = await isOverflow({
      cfg: { compaction: {} } as any,
      tokens: {
        total: 100000,
        input: 90000,
        output: 10000,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      model: mockModel,
    })
    expect(overflowBelow).toBe(false)

    // isOverflow check above
    const overflowAbove = await isOverflow({
      cfg: { compaction: {} } as any,
      tokens: {
        total: 200000,
        input: 190000,
        output: 10000,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      model: mockModel,
    })
    expect(overflowAbove).toBe(true)
  })

  it("should match isOverflow and wouldOverflow when trigger_tokens is set", async () => {
    // Trigger tokens = 100k (smaller than usable 195904)
    const system = ["system prompt content"]
    const messages = [{ role: "user" as const, content: "hello" }]

    const estimateAboveTrigger = TokenEstimate.wouldOverflow({
      system,
      messages,
      tools: {},
      model: mockModel,
      triggerTokens: 100000,
    })
    expect(estimateAboveTrigger.usable).toBe(100000)

    // Create a large estimation by adding large messages
    const largeContent = "a".repeat(500) // ~125 tokens per message
    const largeMessages = Array(1000).fill({ role: "user" as const, content: largeContent })
    const estimateLarge = TokenEstimate.wouldOverflow({
      system,
      messages: largeMessages,
      tools: {},
      model: mockModel,
      triggerTokens: 100000,
    })
    expect(estimateLarge.overflow).toBe(true)

    // isOverflow above 100k
    const overflowAboveTrigger = await isOverflow({
      cfg: { compaction: { trigger_tokens: 100000 } } as any,
      tokens: {
        total: 120000,
        input: 110000,
        output: 10000,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      model: mockModel,
    })
    expect(overflowAboveTrigger).toBe(true)

    // isOverflow below 100k
    const overflowBelowTrigger = await isOverflow({
      cfg: { compaction: { trigger_tokens: 100000 } } as any,
      tokens: {
        total: 80000,
        input: 70000,
        output: 10000,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      model: mockModel,
    })
    expect(overflowBelowTrigger).toBe(false)
  })
})
