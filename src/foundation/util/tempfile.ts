// util/tempfile.ts
//
// Temp file path generator with content-hashed variant (parity gap-58).
//
// PROVENANCE: ported from
// `instructkr-claude-code/src/utils/tempfile.ts` (31 LOC). Tiny but
// useful pattern — opencode currently has no tempfile helper, so
// callers reach for `os.tmpdir() + path.join(..., randomUUID())`
// inline at each call site. This consolidation gives us:
//   - One place to set the default prefix + extension
//   - The CONTENT-HASHED variant that's important for prompt-cache
//     stability (see "Why content hash" below)
//   - A namespace shape consistent with the other util/* modules
//
// USAGE
// =====
// ```ts
// import { TempFile } from "./util/tempfile"
//
// // Random UUID — fine for ephemeral one-shot files
// const out = TempFile.path("opencode-export", ".json")
// // → /tmp/opencode-export-<uuid>.json
//
// // Content-hashed — STABLE across process spawns for the same content
// const promptPath = TempFile.path("opencode-prompt", ".md", {
//   contentHash: "sandbox deny list:foo,bar,baz",
// })
// // → /tmp/opencode-prompt-<sha256-first-16-hex>.md
// // Same content → same path → prompt cache prefix stays stable.
// ```
//
// WHY CONTENT HASH?
// =================
// When opencode injects a temp file path into prompt content (e.g.
// a sandbox deny list passed to the model via a tool description),
// every subprocess spawn would emit a fresh random UUID — and the
// model's prompt cache would miss on every turn because the bytes
// of the system prompt differ.
//
// The content-hashed variant derives the filename from a SHA-256
// hash of a caller-supplied string (typically the file content
// itself, or a stable identifier of what the file represents).
// Same content → same filename → stable wire bytes → cache hits.
//
// This is the same insight behind the gap-102 canonical tool schema
// work in the qpilot/qgenie token efficiency arc: prompt content
// must be byte-stable across turns for caching to work, and any
// embedded random IDs are an instability source.
//
// SECURITY NOTE
// =============
// The content-hashed variant is NOT a security boundary. Two
// different processes hashing the same content will collide on
// the same path — by design (that's the whole point). Don't use it
// to store secrets. Use the random-UUID variant for anything that
// needs cross-process isolation.
//
// THIS IS NOT
// ===========
// Not a temp file MANAGER. Doesn't create the file, doesn't track
// cleanup, doesn't auto-delete on process exit. Just generates the
// path string. The caller is responsible for everything else.
//
// If you need cleanup, register the file with the gap-56
// CleanupRegistry: `CleanupRegistry.register(() => fs.unlink(path))`.

import { createHash, randomUUID } from "crypto"
import { join } from "path"
import { vaultPath } from "@/foundation/notes-root"

// vault-as-sole-filesystem migration (Stage 0.5, leaf I0.2):
// Temp files now land under <vault>/tmp/ instead of os.tmpdir(). This
// satisfies invariant I1 (vault is the only mount). Session-scoped
// subdirs (<vault>/tmp/<sessionId>/) are a follow-up enhancement; for
// now every caller shares <vault>/tmp/ as the unscoped tmp root.

export namespace TempFile {
  /**
   * Default prefix when none is specified. Identifies opencode-
   * generated temp files in /tmp listings.
   */
  export const DEFAULT_PREFIX = "opencode"

  /**
   * Default extension when none is specified. Markdown is the most
   * common opencode temp content (prompts, exports, snapshots).
   */
  export const DEFAULT_EXTENSION = ".md"

  /**
   * Length of the hex prefix derived from the content hash. 16 hex
   * chars = 64 bits of entropy, enough to avoid collisions in any
   * practical workload.
   */
  export const CONTENT_HASH_LENGTH = 16

  export interface Options {
    /**
     * When provided, the filename is derived from a SHA-256 hash of
     * this string (first 16 hex chars). Produces a path that is
     * stable across process boundaries — same content → same path.
     *
     * Use this when the path ends up in content sent to the model
     * (tool descriptions, system prompts, etc.) so a random UUID
     * doesn't invalidate the prompt cache prefix on every subprocess
     * spawn.
     */
    contentHash?: string
  }

  /**
   * Generate a temp file path. Defaults to a random-UUID filename;
   * pass `opts.contentHash` for a stable content-derived filename.
   *
   * @param prefix Optional filename prefix (default: "opencode")
   * @param extension Optional file extension (default: ".md")
   * @param opts Optional content-hash variant trigger
   * @returns Absolute path inside os.tmpdir()
   */
  export function path(prefix: string = DEFAULT_PREFIX, extension: string = DEFAULT_EXTENSION, opts?: Options): string {
    const id = opts?.contentHash
      ? createHash("sha256").update(opts.contentHash).digest("hex").slice(0, CONTENT_HASH_LENGTH)
      : randomUUID()
    return join(vaultPath.tmpRoot(), `${prefix}-${id}${extension}`)
  }

  /**
   * Generate a content-hashed temp file path. Convenience wrapper
   * around `path(prefix, extension, { contentHash })` for the
   * common case where the caller knows they want stability.
   */
  export function stable(
    content: string,
    prefix: string = DEFAULT_PREFIX,
    extension: string = DEFAULT_EXTENSION,
  ): string {
    return path(prefix, extension, { contentHash: content })
  }

  /**
   * Generate a random temp file path. Convenience wrapper around
   * `path(prefix, extension)` for the common case where the caller
   * knows they want a fresh path every time.
   */
  export function random(prefix: string = DEFAULT_PREFIX, extension: string = DEFAULT_EXTENSION): string {
    return path(prefix, extension)
  }
}
