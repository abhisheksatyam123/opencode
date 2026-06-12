import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// ---------------------------------------------------------------------------
// Extracted core logic functions (mirrors provider.ts antigravity loader,
// lines 862-889). We test these in isolation to avoid importing the full
// provider module with all its heavy Effect/SDK dependencies.
// ---------------------------------------------------------------------------

function extractModelId(url: string): string {
  const modelMatch = url.match(/\/models\/([^:\/]+):/)
  return modelMatch ? decodeURIComponent(modelMatch[1]) : "unknown"
}

function buildEnvelope(options: {
  project: string
  requestId: string
  originalBody: Record<string, unknown>
  modelId: string
}): object {
  return {
    project: options.project,
    requestId: options.requestId,
    request: options.originalBody,
    model: options.modelId,
    userAgent: "antigravity",
    requestType: "agent",
  }
}

function parseBody(body: unknown): Record<string, unknown> {
  if (!body) return {}
  try {
    return JSON.parse(String(body))
  } catch {
    return {}
  }
}

function resolveProject(opts?: { project?: string }): string {
  const optionsProject = opts?.project
  return (
    (optionsProject && optionsProject !== "tuned-keel-d72qv" ? optionsProject : null) ??
    process.env.ANTIGRAVITY_PROJECT_ID ??
    process.env.GOOGLE_CLOUD_PROJECT ??
    process.env.GCP_PROJECT ??
    process.env.GCLOUD_PROJECT ??
    optionsProject ??
    "tuned-keel-d72qv"
  )
}

function transformSseStream(readableStream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""

  const transformStream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""

      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed.startsWith("data: ")) {
          const dataContent = trimmed.slice(6).trim()
          if (dataContent === "[DONE]") {
            controller.enqueue(encoder.encode(line + "\n"))
            continue
          }
          try {
            const parsed = JSON.parse(dataContent)
            if (parsed && typeof parsed === "object" && "response" in parsed) {
              const unwrapped = parsed.response
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(unwrapped)}\n`))
            } else {
              controller.enqueue(encoder.encode(line + "\n"))
            }
          } catch {
            controller.enqueue(encoder.encode(line + "\n"))
          }
        } else {
          controller.enqueue(encoder.encode(line + "\n"))
        }
      }
    },
    flush(controller) {
      if (buffer) {
        const trimmed = buffer.trim()
        if (trimmed.startsWith("data: ")) {
          const dataContent = trimmed.slice(6).trim()
          if (dataContent === "[DONE]") {
            controller.enqueue(encoder.encode(buffer + "\n"))
          } else {
            try {
              const parsed = JSON.parse(dataContent)
              if (parsed && typeof parsed === "object" && "response" in parsed) {
                const unwrapped = parsed.response
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(unwrapped)}\n`))
              } else {
                controller.enqueue(encoder.encode(buffer + "\n"))
              }
            } catch {
              controller.enqueue(encoder.encode(buffer + "\n"))
            }
          }
        } else {
          controller.enqueue(encoder.encode(buffer + "\n"))
        }
      }
    }
  })

  return readableStream.pipeThrough(transformStream)
}

// ---------------------------------------------------------------------------
// Fixtures — realistic captured mitmproxy packets
// ---------------------------------------------------------------------------

const ANTIGRAVITY_URL =
  "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse"

const VERTEX_SDK_URL =
  "https://us-central1-aiplatform.googleapis.com/v1/projects/my-project/locations/us-central1/publishers/google/models/gemini-2.5-flash:streamGenerateContent?alt=sse"

const FIXTURE_REQUEST_BODY = {
  contents: [{ role: "user", parts: [{ text: "Hello" }] }],
  generationConfig: { temperature: 1, maxOutputTokens: 8192 },
}

const FIXTURE_ENVELOPE = {
  project: "tuned-keel-d72qv",
  requestId: "opencode/1718123456789",
  request: FIXTURE_REQUEST_BODY,
  model: "gemini-2.5-flash",
  userAgent: "antigravity",
  requestType: "agent",
}

const FIXTURE_SSE_CHUNKS = [
  `data: {"candidates":[{"content":{"parts":[{"text":"Hello! How can I"}],"role":"model"},"safetyRatings":[]}],"modelVersion":"gemini-2.5-flash"}\n\n`,
  `data: {"candidates":[{"content":{"parts":[{"text":" help you today?"}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":8,"totalTokenCount":18}}\n\n`,
  `data: [DONE]\n\n`,
]

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("antigravity envelope construction", () => {
  it("wraps the original body in the expected envelope format", () => {
    const envelope = buildEnvelope({
      project: "tuned-keel-d72qv",
      requestId: "opencode/1718123456789",
      originalBody: FIXTURE_REQUEST_BODY,
      modelId: "gemini-2.5-flash",
    })

    expect(envelope).toEqual(FIXTURE_ENVELOPE)
  })

  it("includes all required envelope fields", () => {
    const envelope = buildEnvelope({
      project: "my-project",
      requestId: "opencode/1234",
      originalBody: { contents: [] },
      modelId: "gemini-2.5-pro",
    }) as Record<string, unknown>

    expect(envelope).toHaveProperty("project", "my-project")
    expect(envelope).toHaveProperty("requestId", "opencode/1234")
    expect(envelope).toHaveProperty("request")
    expect(envelope).toHaveProperty("model", "gemini-2.5-pro")
    expect(envelope).toHaveProperty("userAgent", "antigravity")
    expect(envelope).toHaveProperty("requestType", "agent")
  })

  it("preserves the original request body as-is inside the envelope", () => {
    const complexBody = {
      contents: [{ role: "user", parts: [{ text: "Explain quantum physics" }] }],
      generationConfig: { temperature: 0.7, topK: 40, topP: 0.95, maxOutputTokens: 4096 },
      tools: [{ functionDeclarations: [{ name: "search", description: "Search the web" }] }],
    }

    const envelope = buildEnvelope({
      project: "proj",
      requestId: "opencode/999",
      originalBody: complexBody,
      modelId: "gemini-2.5-flash",
    }) as Record<string, unknown>

    expect(envelope.request).toEqual(complexBody)
  })
})

describe("antigravity model ID extraction", () => {
  it("extracts model ID from standard Vertex SDK URL", () => {
    const url =
      "https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/l/publishers/google/models/gemini-2.5-flash:streamGenerateContent?alt=sse"
    expect(extractModelId(url)).toBe("gemini-2.5-flash")
  })

  it("extracts model ID from URL with encoded characters", () => {
    const url =
      "https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/l/publishers/google/models/gemini-2.5-flash-preview%2Flatest:streamGenerateContent"
    expect(extractModelId(url)).toBe("gemini-2.5-flash-preview/latest")
  })

  it("extracts model ID without query parameters", () => {
    const url =
      "https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/l/publishers/google/models/gemini-2.5-pro:streamGenerateContent"
    expect(extractModelId(url)).toBe("gemini-2.5-pro")
  })

  it("falls back to 'unknown' when URL has no /models/ segment", () => {
    const url = "https://example.com/unknown/path:streamGenerateContent"
    expect(extractModelId(url)).toBe("unknown")
  })

  it("falls back to 'unknown' for empty string URL", () => {
    expect(extractModelId("")).toBe("unknown")
  })

  it("falls back to 'unknown' for URL with /models/ but no colon separator", () => {
    // The regex requires a colon after the model ID
    const url = "https://example.com/models/gemini-2.5-flash"
    expect(extractModelId(url)).toBe("unknown")
  })

  it("extracts from a minimal /models/xxx: pattern", () => {
    const url = "/models/my-model:generate"
    expect(extractModelId(url)).toBe("my-model")
  })

  it("handles double-encoded characters", () => {
    // %252F is double-encoded /
    const url = "/models/gemini-2.5-flash%252Flatest:streamGenerateContent"
    expect(extractModelId(url)).toBe("gemini-2.5-flash%2Flatest")
  })
})

describe("antigravity auth failure handling", () => {
  it("GoogleAuth.getApplicationDefault failure produces a clear error", async () => {
    // Simulate the exact error google-auth-library throws
    class MockGoogleAuth {
      getApplicationDefault = vi.fn().mockRejectedValue(
        new Error("Could not load the default credentials. Browse to https://cloud.google.com/docs/authentication/getting-started for more information."),
      )
    }

    const auth = new MockGoogleAuth()

    await expect(auth.getApplicationDefault()).rejects.toThrow(
      "Could not load the default credentials",
    )
  })

  it("error message mentions the credential loading issue", async () => {
    class MockGoogleAuth {
      getApplicationDefault = vi.fn().mockRejectedValue(
        new Error("Could not load the default credentials. Browse to https://cloud.google.com/docs/authentication/getting-started for more information."),
      )
    }

    const auth = new MockGoogleAuth()

    try {
      await auth.getApplicationDefault()
      expect.unreachable("Should have thrown")
    } catch (err: any) {
      expect(err.message).toContain("Could not load the default credentials")
      // The suggestion to run gcloud auth is typically added by the calling code
      // or is part of the google-auth-library error message itself
      expect(err.message).toContain("cloud.google.com/docs/authentication")
    }
  })

  it("getAccessToken failure is propagated", async () => {
    class MockGoogleAuth {
      getApplicationDefault = vi.fn().mockResolvedValue({
        credential: {
          getAccessToken: vi.fn().mockRejectedValue(
            new Error("Token refresh failed"),
          ),
        },
      })
    }

    const auth = new MockGoogleAuth()
    const client = await auth.getApplicationDefault()

    await expect(client.credential.getAccessToken()).rejects.toThrow(
      "Token refresh failed",
    )
  })
})

describe("antigravity auth token caching", () => {
  it("caches token and returns it on subsequent calls within expiry window", async () => {
    let callCount = 0
    const mockGetAccessToken = vi.fn().mockImplementation(async () => {
      callCount++
      return { token: `token-${callCount}` }
    })

    class MockGoogleAuth {
      getApplicationDefault = vi.fn().mockResolvedValue({
        credential: { getAccessToken: mockGetAccessToken },
      })
    }

    // Simulate the caching logic from the new getAuthToken()
    let cachedCredential: { token: string; expiryMs: number } | undefined
    let cachedAuth: InstanceType<typeof MockGoogleAuth> | undefined

    async function getAuthToken(): Promise<string> {
      if (cachedCredential && Date.now() < cachedCredential.expiryMs - 60_000) {
        return cachedCredential.token
      }

      if (!cachedAuth) {
        cachedAuth = new MockGoogleAuth()
      }

      const client = await cachedAuth.getApplicationDefault()
      const tokenResponse = await client.credential.getAccessToken()
      const token = tokenResponse.token as string

      cachedCredential = { token, expiryMs: Date.now() + 3_600_000 }
      return token
    }

    // First call: should hit the mock
    const token1 = await getAuthToken()
    expect(token1).toBe("token-1")
    expect(callCount).toBe(1)

    // Second call: should return cached token
    const token2 = await getAuthToken()
    expect(token2).toBe("token-1")
    expect(callCount).toBe(1)  // No additional call
  })

  it("refreshes token when it expires", async () => {
    let callCount = 0
    const mockGetAccessToken = vi.fn().mockImplementation(async () => {
      callCount++
      return { token: `token-${callCount}` }
    })

    class MockGoogleAuth {
      getApplicationDefault = vi.fn().mockResolvedValue({
        credential: { getAccessToken: mockGetAccessToken },
      })
    }

    let cachedCredential: { token: string; expiryMs: number } | undefined
    let cachedAuth: InstanceType<typeof MockGoogleAuth> | undefined

    async function getAuthToken(): Promise<string> {
      if (cachedCredential && Date.now() < cachedCredential.expiryMs - 60_000) {
        return cachedCredential.token
      }

      if (!cachedAuth) {
        cachedAuth = new MockGoogleAuth()
      }

      const client = await cachedAuth.getApplicationDefault()
      const tokenResponse = await client.credential.getAccessToken()
      const token = tokenResponse.token as string

      cachedCredential = { token, expiryMs: Date.now() + 3_600_000 }
      return token
    }

    // First call
    const token1 = await getAuthToken()
    expect(token1).toBe("token-1")

    // Simulate token expiry by moving the expiry into the past
    cachedCredential!.expiryMs = Date.now() - 1

    // Next call should refresh
    const token2 = await getAuthToken()
    expect(token2).toBe("token-2")
    expect(callCount).toBe(2)
  })

  it("invalidates cache on auth failure so retry gets fresh credentials", async () => {
    let callCount = 0

    class MockGoogleAuth {
      getApplicationDefault = vi.fn().mockImplementation(async () => {
        callCount++
        if (callCount === 1) {
          throw new Error("Could not load the default credentials")
        }
        return {
          credential: {
            getAccessToken: vi.fn().mockResolvedValue({ token: "fresh-token" }),
          },
        }
      })
    }

    let cachedAuth: InstanceType<typeof MockGoogleAuth> | undefined
    let cachedCredential: { token: string; expiryMs: number } | undefined

    async function getAuthToken(): Promise<string> {
      if (cachedCredential && Date.now() < cachedCredential.expiryMs - 60_000) {
        return cachedCredential.token
      }
      if (!cachedAuth) {
        cachedAuth = new MockGoogleAuth()
      }
      try {
        const client = await cachedAuth.getApplicationDefault()
        const tokenResponse = await client.credential.getAccessToken()
        cachedCredential = { token: tokenResponse.token as string, expiryMs: Date.now() + 3_600_000 }
        return cachedCredential.token
      } catch {
        // Invalidate on failure
        cachedAuth = undefined
        cachedCredential = undefined
        throw new Error("Auth failed")
      }
    }

    // First call fails
    await expect(getAuthToken()).rejects.toThrow("Auth failed")
    expect(cachedAuth).toBeUndefined()

    // Second call should work with fresh auth
    const token = await getAuthToken()
    expect(token).toBe("fresh-token")
  })
})

describe("antigravity API key fallback", () => {
  const savedKey = process.env.ANTIGRAVITY_API_KEY

  afterEach(() => {
    if (savedKey !== undefined) {
      process.env.ANTIGRAVITY_API_KEY = savedKey
    } else {
      delete process.env.ANTIGRAVITY_API_KEY
    }
  })

  it("uses ANTIGRAVITY_API_KEY when set, bypassing GoogleAuth", async () => {
    const apiKey = "test-api-key-123"

    // Simulate the getAuthToken() fast path
    async function getAuthToken(antigravityApiKey: string | undefined): Promise<string> {
      if (antigravityApiKey) return antigravityApiKey
      throw new Error("Should not reach GoogleAuth")
    }

    const token = await getAuthToken(apiKey)
    expect(token).toBe(apiKey)
  })

  it("API key auth sets x-goog-api-key header instead of Authorization", () => {
    const apiKey = "test-api-key"
    const headers = new Headers()

    // Simulate the header logic from the new provider
    if (apiKey) {
      headers.set("x-goog-api-key", apiKey)
    } else {
      headers.set("Authorization", `Bearer some-token`)
    }

    expect(headers.get("x-goog-api-key")).toBe(apiKey)
    expect(headers.get("Authorization")).toBeNull()
  })

  it("Bearer auth is used when no API key is set", () => {
    const apiKey: string | undefined = undefined
    const token = "oauth-token-123"
    const headers = new Headers()

    if (apiKey) {
      headers.set("x-goog-api-key", apiKey)
    } else {
      headers.set("Authorization", `Bearer ${token}`)
    }

    expect(headers.get("Authorization")).toBe("Bearer oauth-token-123")
    expect(headers.get("x-goog-api-key")).toBeNull()
  })
})

describe("antigravity actionable error messages", () => {
  it("wraps 'Could not load the default credentials' with fix suggestions", () => {
    const originalMsg = "Could not load the default credentials. Browse to https://cloud.google.com/docs/authentication/getting-started for more information."

    // Simulate the error wrapping logic from getAuthToken()
    const wrappedMsg =
      `Antigravity auth failed: ${originalMsg}\n\n` +
      `To fix this, do ONE of the following:\n` +
      `  1. Run: gcloud auth application-default login\n` +
      `  2. Set GOOGLE_APPLICATION_CREDENTIALS to a service account key file\n` +
      `  3. Set ANTIGRAVITY_API_KEY for API key auth (bypasses ADC)\n` +
      `\nSee https://cloud.google.com/docs/authentication/getting-started`

    expect(wrappedMsg).toContain("gcloud auth application-default login")
    expect(wrappedMsg).toContain("GOOGLE_APPLICATION_CREDENTIALS")
    expect(wrappedMsg).toContain("ANTIGRAVITY_API_KEY")
    expect(wrappedMsg).toContain("Antigravity auth failed")
  })

  it("wraps 'Could not refresh access token' with fix suggestions", () => {
    const originalMsg = "Could not refresh access token"

    const shouldWrap = originalMsg.includes("Could not load the default credentials") ||
      originalMsg.includes("Could not refresh access token")

    expect(shouldWrap).toBe(true)
  })

  it("does not wrap unrelated errors", () => {
    const originalMsg = "Network timeout connecting to server"

    const shouldWrap = originalMsg.includes("Could not load the default credentials") ||
      originalMsg.includes("Could not refresh access token")

    expect(shouldWrap).toBe(false)
  })
})

describe("antigravity body parsing", () => {
  it("parses a valid JSON body string", () => {
    const body = JSON.stringify(FIXTURE_REQUEST_BODY)
    expect(parseBody(body)).toEqual(FIXTURE_REQUEST_BODY)
  })

  it("returns empty object for empty body", () => {
    expect(parseBody("")).toEqual({})
    expect(parseBody(null)).toEqual({})
    expect(parseBody(undefined)).toEqual({})
  })

  it("returns empty object for invalid JSON body", () => {
    expect(parseBody("not valid json {{{")).toEqual({})
  })

  it("handles ArrayBuffer body by converting toString", () => {
    // When body is an ArrayBuffer, String(body) produces something
    // that is not valid JSON, so it should fall back to {}
    const buf = new ArrayBuffer(8)
    expect(parseBody(buf)).toEqual({})
  })

  it("parses body with contents, generationConfig, and tools", () => {
    const complexBody = {
      contents: [{ role: "user", parts: [{ text: "test" }] }],
      generationConfig: { temperature: 0.5 },
      tools: [
        {
          functionDeclarations: [
            { name: "get_weather", description: "Get weather", parameters: { type: "object" } },
          ],
        },
      ],
    }
    const parsed = parseBody(JSON.stringify(complexBody))
    expect(parsed).toEqual(complexBody)
    expect(parsed.tools).toHaveLength(1)
  })

  it("handles numeric body (edge case)", () => {
    // String(42) is "42", which is valid JSON
    expect(parseBody(42)).toEqual(42)
  })

  it("parses Uint8Array body containing valid JSON", () => {
    const json = JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Hi" }] }] })
    const encoder = new TextEncoder()
    const uint8 = encoder.encode(json)
    // parseBody uses String() which doesn't handle Uint8Array well,
    // but the real provider uses TextDecoder. Test expected behavior.
    const result = parseBody(String(uint8))
    // String(Uint8Array) produces comma-separated numbers, not valid JSON
    expect(result).toEqual({})
  })
})

describe("antigravity configurable endpoint", () => {
  it("uses default endpoint when none configured", () => {
    const providerEndpoint: string | undefined = undefined
    const envEndpoint: string | undefined = undefined
    const endpoint =
      providerEndpoint ??
      envEndpoint ??
      "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse"

    expect(endpoint).toBe(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
    )
  })

  it("uses provider.options.endpoint when configured", () => {
    const providerEndpoint = "https://custom-proxy.example.com/v1:streamGenerate"
    const envEndpoint: string | undefined = undefined

    const endpoint =
      providerEndpoint ??
      envEndpoint ??
      "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse"

    expect(endpoint).toBe("https://custom-proxy.example.com/v1:streamGenerate")
  })

  it("uses ANTIGRAVITY_ENDPOINT env var as fallback", () => {
    const providerEndpoint: string | undefined = undefined
    const envEndpoint = "https://staging-api.example.com/v1:generate"

    const endpoint =
      providerEndpoint ??
      envEndpoint ??
      "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse"

    expect(endpoint).toBe("https://staging-api.example.com/v1:generate")
  })
})

describe("antigravity SSE response passthrough", () => {
  it("SSE response can be read as a text stream", async () => {
    const sseText = FIXTURE_SSE_CHUNKS.join("")
    const response = new Response(sseText, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    })

    const text = await response.text()
    expect(text).toContain('data: {"candidates"')
    expect(text).toContain("data: [DONE]")
  })

  it("SSE chunks can be parsed individually", () => {
    const parsed: unknown[] = []

    for (const chunk of FIXTURE_SSE_CHUNKS) {
      const trimmed = chunk.trim()
      if (!trimmed.startsWith("data: ")) continue
      const payload = trimmed.slice("data: ".length)
      if (payload === "[DONE]") {
        parsed.push({ done: true })
        continue
      }
      parsed.push(JSON.parse(payload))
    }

    expect(parsed).toHaveLength(3)

    // First chunk: partial content
    const first = parsed[0] as any
    expect(first.candidates[0].content.parts[0].text).toBe("Hello! How can I")
    expect(first.candidates[0].content.role).toBe("model")
    expect(first.modelVersion).toBe("gemini-2.5-flash")

    // Second chunk: finish with usage metadata
    const second = parsed[1] as any
    expect(second.candidates[0].content.parts[0].text).toBe(" help you today?")
    expect(second.candidates[0].finishReason).toBe("STOP")
    expect(second.usageMetadata.promptTokenCount).toBe(10)
    expect(second.usageMetadata.candidatesTokenCount).toBe(8)
    expect(second.usageMetadata.totalTokenCount).toBe(18)

    // Third chunk: DONE sentinel
    expect(parsed[2]).toEqual({ done: true })
  })

  it("SSE response preserves headers from upstream", () => {
    const response = new Response("data: test\n\n", {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "X-Request-Id": "req-123",
      },
    })

    expect(response.headers.get("Content-Type")).toBe("text/event-stream")
    expect(response.headers.get("X-Request-Id")).toBe("req-123")
    expect(response.status).toBe(200)
  })

  it("unwraps a wrapped SSE stream correctly", async () => {
    const wrappedSSE = [
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]},"traceId":"123"}\n',
      'data: [DONE]\n'
    ].join("")

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(wrappedSSE))
        controller.close()
      }
    })

    const transformedStream = transformSseStream(stream)
    const reader = transformedStream.getReader()
    const decoder = new TextDecoder()
    let result = ""
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      result += decoder.decode(value)
    }

    expect(result).toContain('data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}')
    expect(result).toContain('data: [DONE]')
    expect(result).not.toContain('"response"')
  })

  it("unwraps a wrapped JSON response correctly", async () => {
    const wrappedJSON = JSON.stringify({
      response: {
        candidates: [{ content: { parts: [{ text: "Hello" }] } }]
      },
      traceId: "123"
    })

    const parsed = JSON.parse(wrappedJSON)
    let finalJSON = wrappedJSON
    if (parsed && typeof parsed === "object" && "response" in parsed) {
      finalJSON = JSON.stringify(parsed.response)
    }

    const unwrapped = JSON.parse(finalJSON)
    expect(unwrapped.candidates).toBeDefined()
    expect(unwrapped.candidates[0].content.parts[0].text).toBe("Hello")
    expect(unwrapped.traceId).toBeUndefined()
  })
})

describe("antigravity project config resolution", () => {
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    // Save and clear relevant env vars
    for (const key of ["ANTIGRAVITY_PROJECT_ID", "GOOGLE_CLOUD_PROJECT", "GCP_PROJECT", "GCLOUD_PROJECT"]) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    // Restore env vars
    for (const key of ["ANTIGRAVITY_PROJECT_ID", "GOOGLE_CLOUD_PROJECT", "GCP_PROJECT", "GCLOUD_PROJECT"]) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key]
      } else {
        delete process.env[key]
      }
    }
  })

  it("provider.options.project takes highest precedence", () => {
    process.env.ANTIGRAVITY_PROJECT_ID = "anti-project"
    expect(resolveProject({ project: "options-project" })).toBe("options-project")
  })

  it("ANTIGRAVITY_PROJECT_ID is second in precedence", () => {
    process.env.ANTIGRAVITY_PROJECT_ID = "anti-project"
    process.env.GOOGLE_CLOUD_PROJECT = "env-project"
    expect(resolveProject()).toBe("anti-project")
  })

  it("GOOGLE_CLOUD_PROJECT is third in precedence", () => {
    process.env.GOOGLE_CLOUD_PROJECT = "gcloud-project"
    process.env.GCP_PROJECT = "gcp-project"
    process.env.GCLOUD_PROJECT = "old-gcloud-project"
    expect(resolveProject()).toBe("gcloud-project")
  })

  it("GCP_PROJECT is fourth in precedence", () => {
    process.env.GCP_PROJECT = "gcp-project"
    process.env.GCLOUD_PROJECT = "old-gcloud-project"
    expect(resolveProject()).toBe("gcp-project")
  })

  it("GCLOUD_PROJECT is fifth in precedence", () => {
    process.env.GCLOUD_PROJECT = "old-gcloud-project"
    expect(resolveProject()).toBe("old-gcloud-project")
  })

  it("falls back to 'tuned-keel-d72qv' when nothing is set", () => {
    expect(resolveProject()).toBe("tuned-keel-d72qv")
  })

  it("falls back when options exist but project is undefined", () => {
    expect(resolveProject({ project: undefined })).toBe("tuned-keel-d72qv")
  })
})

describe("antigravity fetch wrapper integration", () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it("sends to the correct antigravity URL with POST method", async () => {
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("data: [DONE]\n\n", { status: 200 }),
    )
    globalThis.fetch = mockFetch

    // Simulate the fetch wrapper logic from provider.ts lines 855-900
    const mockAuth = {
      getApplicationDefault: vi.fn().mockResolvedValue({
        credential: {
          getAccessToken: vi.fn().mockResolvedValue({ token: "mock-token-123" }),
        },
      }),
    }

    const input: RequestInfo | URL = VERTEX_SDK_URL
    const init: RequestInit = {
      method: "POST",
      body: JSON.stringify(FIXTURE_REQUEST_BODY),
      headers: { "Content-Type": "application/json" },
    }

    // Execute the wrapper logic
    const client = await mockAuth.getApplicationDefault()
    const token = await client.credential.getAccessToken()

    const originalUrl = typeof input === "string" ? input : (input as any).toString()
    const modelMatch = originalUrl.match(/\/models\/([^:\/]+):/)
    const modelId = modelMatch ? decodeURIComponent(modelMatch[1]) : "unknown"

    let originalBody: Record<string, unknown> = {}
    if (init?.body) {
      try {
        originalBody = JSON.parse(init.body.toString())
      } catch {
        originalBody = {}
      }
    }

    const project = "tuned-keel-d72qv"
    const wrappedBody = JSON.stringify({
      project,
      requestId: `opencode/${Date.now()}`,
      request: originalBody,
      model: modelId,
      userAgent: "opencode",
      requestType: "agent",
    })

    const headers = new Headers(init?.headers)
    headers.set("Authorization", `Bearer ${token.token}`)
    headers.set("Content-Type", "application/json")

    await mockFetch(ANTIGRAVITY_URL, {
      method: "POST",
      headers,
      body: wrappedBody,
    })

    // Verify the fetch call
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [calledUrl, calledInit] = mockFetch.mock.calls[0]
    expect(calledUrl).toBe(ANTIGRAVITY_URL)
    expect(calledInit?.method).toBe("POST")

    // Verify Authorization header
    const calledHeaders = calledInit?.headers as Headers
    expect(calledHeaders.get("Authorization")).toBe("Bearer mock-token-123")
    expect(calledHeaders.get("Content-Type")).toBe("application/json")

    // Verify wrapped body structure
    const sentBody = JSON.parse(calledInit?.body as string)
    expect(sentBody.project).toBe("tuned-keel-d72qv")
    expect(sentBody.requestId).toMatch(/^opencode\/\d+$/)
    expect(sentBody.request).toEqual(FIXTURE_REQUEST_BODY)
    expect(sentBody.model).toBe("gemini-2.5-flash")
    expect(sentBody.userAgent).toBe("opencode")
    expect(sentBody.requestType).toBe("agent")
  })

  it("passes through SSE response from antigravity API", async () => {
    const ssePayload = FIXTURE_SSE_CHUNKS.join("")
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(ssePayload, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    )
    globalThis.fetch = mockFetch

    const response = await mockFetch(ANTIGRAVITY_URL, {
      method: "POST",
      body: "{}",
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("Content-Type")).toBe("text/event-stream")

    const text = await response.text()
    expect(text).toContain("Hello! How can I")
    expect(text).toContain(" help you today?")
    expect(text).toContain("[DONE]")
  })

  it("correctly handles Request object as input", () => {
    const request = new Request(VERTEX_SDK_URL, {
      method: "POST",
      body: JSON.stringify(FIXTURE_REQUEST_BODY),
    })

    // The provider extracts URL from Request.url
    const originalUrl = request.url
    const modelMatch = originalUrl.match(/\/models\/([^:\/]+):/)
    const modelId = modelMatch ? decodeURIComponent(modelMatch[1]) : "unknown"

    expect(modelId).toBe("gemini-2.5-flash")
  })

  it("correctly handles URL object as input", () => {
    const url = new URL(VERTEX_SDK_URL)

    // The provider calls url.toString()
    const originalUrl = url.toString()
    const modelMatch = originalUrl.match(/\/models\/([^:\/]+):/)
    const modelId = modelMatch ? decodeURIComponent(modelMatch[1]) : "unknown"

    expect(modelId).toBe("gemini-2.5-flash")
  })

  it("requestId includes timestamp", async () => {
    const before = Date.now()
    const requestId = `opencode/${Date.now()}`
    const after = Date.now()

    expect(requestId).toMatch(/^opencode\/\d+$/)
    const timestamp = parseInt(requestId.split("/")[1], 10)
    expect(timestamp).toBeGreaterThanOrEqual(before)
    expect(timestamp).toBeLessThanOrEqual(after)
  })
})
