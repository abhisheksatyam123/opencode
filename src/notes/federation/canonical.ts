/**
 * canonical.ts — RFC 8785 JSON Canonicalization Scheme (JCS) implementation.
 *
 * Used by federation manifest verifier to compute a stable byte sequence over
 * the manifest body before ed25519 signature verification. RFC 8785 mandates:
 *
 *   - object keys sorted lexicographically (UTF-16 code-unit order)
 *   - no insignificant whitespace
 *   - numbers encoded per ECMAScript ToString(Number) (NaN/Infinity → error)
 *   - strings encoded per RFC 8259 with minimal escapes
 *
 * We DO NOT depend on `json-canonicalize` or `canonicalize` npm packages; the
 * implementation is small enough to keep in-tree, removes a dependency hop on
 * the security-critical signature path, and matches the federation-manifest
 * §signature-verification contract verbatim.
 *
 * Reference: https://datatracker.ietf.org/doc/html/rfc8785
 */
export namespace Canonical {
  /** Stringify a JSON value per RFC 8785 (deterministic byte output). */
  export function stringify(value: unknown): string {
    if (value === null) return "null"
    if (typeof value === "boolean") return value ? "true" : "false"
    if (typeof value === "number") return numberToString(value)
    if (typeof value === "string") return stringToJSON(value)
    if (Array.isArray(value)) {
      const parts = value.map((v) => stringify(v ?? null))
      return "[" + parts.join(",") + "]"
    }
    if (typeof value === "object") {
      const obj = value as Record<string, unknown>
      const keys = Object.keys(obj).filter((k) => obj[k] !== undefined)
      // RFC 8785 §3.2.3: sort by UTF-16 code units. Default JS string compare
      // is exactly that (lexicographic by char code) per ECMAScript spec.
      keys.sort()
      const parts = keys.map((k) => stringToJSON(k) + ":" + stringify(obj[k]))
      return "{" + parts.join(",") + "}"
    }
    throw new Error("canonical.stringify: unsupported value type " + typeof value)
  }

  /** Buffer view of canonical bytes — what gets signed/verified. */
  export function bytes(value: unknown): Uint8Array {
    return new TextEncoder().encode(stringify(value))
  }

  function numberToString(n: number): string {
    if (!Number.isFinite(n)) throw new Error("canonical.stringify: non-finite number rejected per RFC 8785")
    // RFC 8785 §3.2.2.3 mandates ECMAScript ToString(Number); JavaScript's
    // built-in `String(n)` IS that algorithm, with one carve-out: the spec
    // treats -0 and 0 identically (both stringify to "0").
    if (Object.is(n, -0)) return "0"
    return String(n)
  }

  function stringToJSON(s: string): string {
    // RFC 8259 §7 minimal escapes. Manual loop avoids JSON.stringify's
    // permissive escape table (e.g. JSON.stringify always escapes U+2028).
    let out = '"'
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i)
      if (c === 0x22) out += '\\"'
      else if (c === 0x5c) out += "\\\\"
      else if (c === 0x08) out += "\\b"
      else if (c === 0x09) out += "\\t"
      else if (c === 0x0a) out += "\\n"
      else if (c === 0x0c) out += "\\f"
      else if (c === 0x0d) out += "\\r"
      else if (c < 0x20) out += "\\u" + c.toString(16).padStart(4, "0")
      else out += s[i]
    }
    return out + '"'
  }
}
