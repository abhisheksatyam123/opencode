// util/runtime.ts
//
// Bun runtime + bundled-mode detection (parity gap-runtime-1).
//
// PROVENANCE: cp'd from
// `instructkr-claude-code/src/utils/bundledMode.ts`, then adapted to
// opencode (wrapped in a `Runtime` namespace following opencode
// convention; renamed `isRunningWithBun` → `Runtime.isBun` and
// `isInBundledMode` → `Runtime.isBundled` to match the namespace
// vocabulary).
//
// WHY THIS EXISTS:
// opencode is distributed two ways:
//   1. As source via `bunx opencode` / `bun run` — `process.versions.bun`
//      is set, but `Bun.embeddedFiles` is empty.
//   2. As a Bun-compiled standalone executable (`dist/opencode-linux-x64/`
//      /bin/opencode) — `Bun.embeddedFiles` contains the bundled file
//      manifest.
//
// Several places need to know which mode they're running in:
//   * `util/hash.ts` — falls back from `Bun.hash` to `crypto.sha256`
//     when running outside Bun.
//   * `npm/index.ts` — picks an `import.meta.resolve` strategy that
//     differs between Bun and Node.
//   * Future: provider/provider.ts — chooses between bundled providers
//     and dynamic SDK imports.
//
// Centralizing the check here means:
//   1. ONE place to update if the detection signal changes.
//   2. Tests can mock `Runtime.isBun()` instead of mutating `globalThis.Bun`.
//   3. Discoverability — grepping for `Runtime.isBun` finds every
//      runtime-aware code path in one shot.

export namespace Runtime {
  /**
   * Detects if the current runtime is Bun (vs Node.js / Deno / etc).
   * Returns true when:
   *   - Running a JS file via the `bun` command
   *   - Running a Bun-compiled standalone executable
   *
   * Equivalent to the inline `typeof Bun !== "undefined"` checks
   * scattered across the codebase before this helper landed.
   * `process.versions.bun` cannot change at runtime, so callers can
   * cache the result if they want.
   *
   * Reference: https://bun.com/guides/util/detect-bun
   */
  export function isBun(): boolean {
    return process.versions.bun !== undefined
  }

  /**
   * Detects if running as a Bun-compiled standalone executable
   * (i.e. `bun build --compile`'d binary). Checks for embedded files
   * which are present ONLY in compiled binaries.
   *
   * Returns false when running source files via `bun` directly OR
   * when running outside Bun entirely (e.g. Node.js).
   *
   * Use for:
   *   - Distinguishing "downloaded standalone binary" from "installed
   *     via package manager" in upgrade-method detection.
   *   - Choosing different resource-loading strategies (bundled
   *     embedded files vs filesystem reads).
   *   - Telemetry/error reporting that wants to label crashes by
   *     install method.
   */
  export function isBundled(): boolean {
    return typeof Bun !== "undefined" && Array.isArray(Bun.embeddedFiles) && Bun.embeddedFiles.length > 0
  }
}
