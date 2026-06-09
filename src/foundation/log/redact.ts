import { SecretScan } from "@/foundation/util/secret-scan"

const HEADER_BLOCKLIST = new Set([
  "authorization",
  "x-api-key",
  "x-goog-api-key",
  "x-anthropic-api-key",
  "openai-api-key",
  "cookie",
  "set-cookie",
  "proxy-authorization",
])

export namespace Redact {
  export function headers(h: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(h)) {
      out[k] = HEADER_BLOCKLIST.has(k.toLowerCase()) ? "[REDACTED]" : v
    }
    return out
  }

  export function body(s: string | null): string | null {
    if (s == null) return null
    if (process.env["OPENCODE_HTTP_LOG_RAW"] === "1") return s
    return SecretScan.redactSecrets(s)
  }

  export function parseBodyJson(raw: string | null): unknown | null {
    if (!raw) return null
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }
}
