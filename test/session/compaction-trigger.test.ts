import { describe, it, expect } from "vitest"
import { TokenEstimate } from "@/process/session/token-estimate"
import { isOverflow } from "@/process/session/overflow"
import { contextWindowStats } from "@/process/session/stats"

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
    const system = ["system prompt content"]
    const messages = [{ role: "user" as const, content: "hello" }]
    
    const estimateBelow = TokenEstimate.wouldOverflow({
      system,
      messages,
      tools: {},
      model: mockModel,
    })
    expect(estimateBelow.overflow).toBe(false)
    expect(estimateBelow.usable).toBe(195904)

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

    const largeContent = "a".repeat(500)
    const largeMessages = Array(1000).fill({ role: "user" as const, content: largeContent })
    const estimateLarge = TokenEstimate.wouldOverflow({
      system,
      messages: largeMessages,
      tools: {},
      model: mockModel,
      triggerTokens: 100000,
    })
    expect(estimateLarge.overflow).toBe(true)

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

describe("Context Window Stats used calculation", () => {
  const mockProviders = {
    "test-provider": {
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          limit: {
            context: 200000,
            output: 4096,
          },
        },
      },
    },
  } as any

  it("should calculate used as estimatedTotal when no assistant message exists", async () => {
    const messages = [
      {
        info: {
          id: "msg-1",
          role: "user",
          time: { created: 1000 },
          model: { providerID: "test-provider", modelID: "test-model" },
        },
        parts: [{ type: "text", text: "a".repeat(400) }], // 400 chars -> 100 tokens
      },
    ] as any

    const stats = await contextWindowStats({ messages, providers: mockProviders })
    expect(stats.used).toBe(stats.estimatedTotal)
  })

  it("should calculate used exactly based on latestAssistant tokens and add estimatedNew for user additions", async () => {
    const messages = [
      {
        info: {
          id: "msg-1",
          role: "user",
          time: { created: 1000 },
          model: { providerID: "test-provider", modelID: "test-model" },
        },
        parts: [{ type: "text", text: "a".repeat(400) }], // 400 chars -> 100 tokens
      },
      {
        info: {
          id: "msg-2",
          role: "assistant",
          time: { created: 2000 },
          providerID: "test-provider",
          modelID: "test-model",
          tokens: {
            input: 110,
            output: 40,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
        parts: [{ type: "text", text: "a".repeat(160) }], // 160 chars -> 40 tokens
      },
    ] as any

    // Initial state after assistant replied
    const stats1 = await contextWindowStats({ messages, providers: mockProviders })
    // exactBase = input (110) + output (40) = 150 tokens.
    // estimatedNew = 0 (no messages after assistant)
    expect(stats1.used).toBe(150)

    // State after user appends a new message (e.g. 800 chars -> 200 tokens)
    const messages2 = [
      ...messages,
      {
        info: {
          id: "msg-3",
          role: "user",
          time: { created: 3000 },
          model: { providerID: "test-provider", modelID: "test-model" },
        },
        parts: [{ type: "text", text: "a".repeat(800) }],
      },
    ] as any

    const stats2 = await contextWindowStats({ messages: messages2, providers: mockProviders })
    // exactBase is still 150
    // estimatedNew should be around 200 tokens
    expect(stats2.used).toBeGreaterThan(340)
    expect(stats2.used).toBeLessThan(360)
  })
})
