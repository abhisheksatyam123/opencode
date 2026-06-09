// util/hash.ts
//
// Content-hash helpers.
//
// `Hash.fast` is the original opencode helper — sha1 digest used as a
// stable file-name suffix for cached models.dev responses, snapshots,
// and a handful of other content-addressed files. Do NOT change its
// algorithm — the output is persisted to disk and a change would
// invalidate every cached file.
//
// `Hash.djb2`, `Hash.content`, and `Hash.pair` are parity gap-20
// additions ported from
// `instructkr-claude-code/src/utils/hash.ts`. They cover the use cases
// `Hash.fast` is overkill for: in-memory cache invalidation, change
// detection between runs, and per-call cache keys.
//
// CHOICE OF HASH:
//   * `fast`    — sha1 hex (40 chars). Stable across runtimes. Use
//                 when the hash ends up in a path/URL persisted to
//                 disk and any future change would invalidate the
//                 caller's caches.
//   * `djb2`    — 32-bit signed int. Deterministic across runtimes.
//                 Use when you need a stable identifier but want a
//                 short numeric value (e.g. directory bucketing).
//   * `content` — Bun.hash (wyhash) on Bun, sha256 on Node. Output
//                 is NOT stable across runtimes. Use for IN-MEMORY
//                 cache keys and change detection only.
//   * `pair`    — two-string hash without allocating a concatenated
//                 temp string. Disambiguates `("ts","code")` from
//                 `("tsc","ode")` via seed-chaining (Bun) or NUL
//                 separator (Node).
//
// NONE OF THESE ARE CRYPTO-SAFE — they're collision-resistant enough
// for diff/cache use cases, NOT for signing or authentication.

import { createHash } from "crypto"
// gap-runtime-1: Runtime.isBun() centralizes the `typeof Bun !== "undefined"`
// check that was duplicated inline below. Same semantics, one source of truth.
import { Runtime } from "./runtime"

export namespace Hash {
  /**
   * Stable sha1 hex digest. Use for content-addressed file names that
   * are persisted to disk — changing this algorithm would invalidate
   * every cached file across every opencode install.
   */
  export function fast(input: string | Buffer): string {
    return createHash("sha1").update(input).digest("hex")
  }

  /**
   * djb2 string hash — fast non-cryptographic hash returning a signed
   * 32-bit int. Deterministic across runtimes (unlike `content` which
   * uses wyhash under Bun). Use as a fallback when Bun.hash isn't
   * available, or when you need on-disk-stable output (e.g. cache
   * directory names that must survive runtime upgrades).
   */
  export function djb2(str: string): number {
    let hash = 0
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
    }
    return hash
  }

  /**
   * Hash arbitrary content for change detection. Bun.hash is ~100×
   * faster than sha256 and collision-resistant enough for diff
   * detection (NOT crypto-safe). Falls back to Node's `crypto`
   * sha256 when running outside Bun.
   *
   * The output is a string for stable comparison, but the format
   * differs between runtimes (Bun returns a numeric string, Node
   * returns a hex digest). DO NOT persist these strings to disk —
   * use `Hash.fast()` if you need a runtime-stable identifier.
   */
  export function content(input: string): string {
    if (Runtime.isBun()) {
      return Bun.hash(input).toString()
    }
    return createHash("sha256").update(input).digest("hex")
  }

  /**
   * Hash two strings without allocating a concatenated temp string.
   *
   * Bun path: seed-chains wyhash (`hash(b, hash(a))`). Seed-chaining
   * naturally disambiguates `("ts","code")` from `("tsc","ode")` so
   * no separator is needed.
   *
   * Node path: incremental SHA-256 with a NUL byte separator between
   * the two strings to provide the same disambiguation guarantee.
   *
   * Use this when you want a single stable identifier from a pair of
   * inputs (e.g. `Hash.pair(toolID, JSON.stringify(args))` for a
   * per-call cache key).
   */
  export function pair(a: string, b: string): string {
    if (Runtime.isBun()) {
      return Bun.hash(b, Bun.hash(a)).toString()
    }
    return createHash("sha256").update(a).update("\0").update(b).digest("hex")
  }
}
