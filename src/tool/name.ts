const AZURE_FUNCTION_NAME = /^[a-zA-Z0-9_-]+$/

const PROVIDER_PREFIXES = ["default_api:", "functions."] as const

export function normalizeProviderQualifiedToolName(raw: string, available: Iterable<string>): string {
  const availableSet = new Set(available)
  if (availableSet.has(raw)) return raw

  for (const prefix of PROVIDER_PREFIXES) {
    if (!raw.startsWith(prefix)) continue
    const candidate = raw.slice(prefix.length)
    if (availableSet.has(candidate)) return candidate
  }

  const colon = raw.lastIndexOf(":")
  if (colon >= 0) {
    const candidate = raw.slice(colon + 1)
    if (availableSet.has(candidate)) return candidate
  }

  return raw
}

export function stripProviderToolPrefix(raw: string): string {
  for (const prefix of PROVIDER_PREFIXES) {
    if (raw.startsWith(prefix)) return raw.slice(prefix.length)
  }
  const colon = raw.lastIndexOf(":")
  if (colon >= 0) return raw.slice(colon + 1)
  return raw
}

export function sanitizeToolNameForModel(raw: string): string {
  const stripped = stripProviderToolPrefix(raw)
  if (AZURE_FUNCTION_NAME.test(stripped)) return stripped
  const sanitized = stripped.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+|_+$/g, "")
  return sanitized || "tool"
}
