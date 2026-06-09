export type ProviderRouteFamily = "openai-chat" | "openai-responses" | "anthropic"

export type ProviderRouteSource = "endpoint" | "npm" | "model-fallback" | "default"

export type ProviderRouteInput = {
  endpoint?: string
  npm?: string
  modelID?: string
}

export type ProviderRouteOutput = {
  family: ProviderRouteFamily
  normalizedEndpoint?: string
  source: ProviderRouteSource
}

function withEndpoint(
  normalizedEndpoint: string | undefined,
  family: ProviderRouteFamily,
  source: ProviderRouteSource,
): ProviderRouteOutput {
  return {
    family,
    source,
    ...(normalizedEndpoint ? { normalizedEndpoint } : {}),
  }
}

function normalizeEndpoint(endpoint?: string) {
  const rawEndpoint = endpoint?.trim()
  if (!rawEndpoint) return undefined

  try {
    return new URL(rawEndpoint).pathname.toLowerCase().replace(/\/+$/, "")
  } catch {
    return rawEndpoint.toLowerCase().replace(/\/+$/, "")
  }
}

export function resolveProviderRouteFamily(input: ProviderRouteInput): ProviderRouteOutput {
  const normalizedEndpoint = normalizeEndpoint(input.endpoint)
  if (normalizedEndpoint) {
    if (normalizedEndpoint.endsWith("/responses")) {
      return withEndpoint(normalizedEndpoint, "openai-responses", "endpoint")
    }
    if (normalizedEndpoint.endsWith("/messages")) {
      return withEndpoint(normalizedEndpoint, "anthropic", "endpoint")
    }
    if (normalizedEndpoint.endsWith("/chat/completions")) {
      return withEndpoint(normalizedEndpoint, "openai-chat", "endpoint")
    }
  }

  const npm = input.npm?.trim()
  if (npm === "@ai-sdk/anthropic") {
    return withEndpoint(normalizedEndpoint, "anthropic", "npm")
  }
  if (npm === "@ai-sdk/openai-compatible") {
    return withEndpoint(normalizedEndpoint, "openai-chat", "npm")
  }

  const id = input.modelID?.toLowerCase() ?? ""
  if (
    id.startsWith("azure::") ||
    id.startsWith("azure/") ||
    id.startsWith("openai::") ||
    id.startsWith("openai/") ||
    id.includes("gpt-") ||
    id.includes("codex") ||
    id.includes("o1") ||
    id.includes("o3")
  ) {
    return withEndpoint(normalizedEndpoint, "openai-responses", "model-fallback")
  }

  if (id.startsWith("anthropic::") || id.includes("claude") || id.includes("anthropic")) {
    return withEndpoint(normalizedEndpoint, "anthropic", "model-fallback")
  }

  return withEndpoint(normalizedEndpoint, "openai-chat", "default")
}
