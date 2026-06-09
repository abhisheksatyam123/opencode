// util/dangerous-mode.ts
//
// Dangerous mode: --dangerously-skip-permissions equivalent (parity gap-57).
//
// PROVENANCE: design ported from
// `instructkr-claude-code/src/main.tsx:976` (`--dangerously-skip-permissions`
// CLI flag) + the consumer logic in `main.tsx:2511-2655`. The Claude
// reference uses Commander.js + a Statsig gate; opencode uses yargs and
// has no Statsig analogue, so the port is a small self-contained helper
// that combines an env var + an argv flag check (via `CliArgs` from
// gap-54).
//
// THE PROBLEM
// ===========
// opencode has a permission system (`permission/index.ts`) that asks
// the user before running tools. For sandboxed automation runs (CI,
// containers, scratch VMs), interactive prompts are unwanted — the
// caller has already accepted the risk and just wants the agent to
// proceed without interrogation.
//
// Today, users CAN configure this via opencode.json:
//   { "permission": "allow" }
// but that requires editing the project config, which is awkward
// for one-off invocations and dangerous to leave in version control.
//
// Claude Code solved this with a `--dangerously-skip-permissions`
// CLI flag. opencode adopts the same pattern (matching the verbose
// flag name verbatim for parity).
//
// THE FIX
// =======
// `DangerousMode.isEnabled()` returns true when EITHER:
//   - the `--dangerously-skip-permissions` argv flag is present, OR
//   - the `OPENCODE_DANGEROUSLY_SKIP_PERMISSIONS` env var is truthy
//
// On the FIRST call that returns true, the helper prints a prominent
// stderr warning so the user can't miss that the safety net is off.
// Subsequent calls don't re-print (the flag is checked many times
// per session — once per permission ask).
//
// `permission/index.ts:Permission.ask` consults this helper at the
// top of the function and short-circuits to "allow" when dangerous
// mode is on. That single insertion is the entire wiring.
//
// USAGE
// =====
// Programmatic (tests + cli init):
//   import { DangerousMode } from "./util/dangerous-mode"
//   if (DangerousMode.isEnabled()) {
//     // skip the permission check
//   }
//
// User-side:
//   $ opencode run --dangerously-skip-permissions ...
//   $ OPENCODE_DANGEROUSLY_SKIP_PERMISSIONS=1 opencode run ...
//
// THIS IS NOT
// ===========
// Not a security control. The flag is intentionally dangerous —
// turning it on disables ALL permission gates including the
// dangerous-command bash blocker, file write protection, network
// access, etc. Use only in sandboxes where the entire process is
// already isolated.
//
// Not auditable. The warning prints to stderr but does not log to
// disk. Auditing dangerous-mode usage is the caller's responsibility
// (e.g. CI logs).

import { CliArgs } from "./cli-args"

export namespace DangerousMode {
  /**
   * The CLI flag the user types. Matches Claude Code verbatim for
   * parity — users coming from Claude can use the same flag.
   */
  export const FLAG = "--dangerously-skip-permissions"

  /**
   * The env var alternative. Useful for CI / dockerfiles where
   * adding a flag to every invocation is inconvenient.
   */
  export const ENV_VAR = "OPENCODE_DANGEROUSLY_SKIP_PERMISSIONS"

  /**
   * Programmatic enable bit. Defaults to undefined (means: read
   * from argv + env). Tests can flip this to true/false to test
   * the consumer logic without manipulating process.argv.
   */
  let programmaticState: boolean | undefined = undefined

  /**
   * Has the warning already been printed in this process?
   * isEnabled() prints the warning on the first call that returns
   * true; subsequent calls don't re-print (the consumer calls
   * isEnabled() once per permission ask, which can be hundreds
   * per session).
   */
  let warningPrinted = false

  /**
   * Check whether dangerous mode is enabled. Runs on every call —
   * the result reflects the current argv + env state, NOT a
   * one-time bootstrap snapshot. This is intentional: tests can
   * flip programmaticState mid-test and the next call sees the
   * change.
   *
   * On the FIRST call that returns true, prints a prominent
   * stderr warning. Subsequent true returns are silent.
   */
  export function isEnabled(): boolean {
    const enabled = computeEnabled()
    if (enabled && !warningPrinted) {
      printWarning()
      warningPrinted = true
    }
    return enabled
  }

  /**
   * Compute enabled state without the warning side-effect. Used
   * internally + by tests that want to query the state without
   * triggering the warning.
   */
  function computeEnabled(): boolean {
    if (programmaticState !== undefined) return programmaticState
    if (CliArgs.hasCliFlag(FLAG)) return true
    const envValue = process.env[ENV_VAR]?.toLowerCase()
    return envValue === "true" || envValue === "1"
  }

  /**
   * Programmatically enable dangerous mode. Used by tests + by
   * code paths that want to enable it without touching argv/env.
   *
   * Calling enable() AFTER isEnabled() has already returned false
   * is fine — the next isEnabled() call will return true and print
   * the warning.
   */
  export function enable(): void {
    programmaticState = true
  }

  /**
   * Programmatically disable dangerous mode. Used by tests to
   * restore state in afterEach. Note this OVERRIDES argv/env
   * detection — calling disable() then re-checking isEnabled()
   * returns false even if --dangerously-skip-permissions is in
   * argv.
   *
   * Most production code should not call this; use _reset()
   * instead to clear the override and fall back to detection.
   */
  export function disable(): void {
    programmaticState = false
  }

  /**
   * Test escape hatch: clear the programmatic override AND the
   * warning-printed flag. Tests should call this in beforeEach so
   * each test starts from the same state. Production code should
   * not call this.
   */
  export function _reset(): void {
    programmaticState = undefined
    warningPrinted = false
  }

  /**
   * Inspect the current state without side effects. Used for tests
   * and the future debug command.
   */
  export function state(): {
    enabled: boolean
    source: "programmatic" | "argv" | "env" | "none"
    warningPrinted: boolean
  } {
    let source: "programmatic" | "argv" | "env" | "none" = "none"
    if (programmaticState !== undefined) {
      source = "programmatic"
    } else if (CliArgs.hasCliFlag(FLAG)) {
      source = "argv"
    } else {
      const envValue = process.env[ENV_VAR]?.toLowerCase()
      if (envValue === "true" || envValue === "1") source = "env"
    }
    return {
      enabled: computeEnabled(),
      source,
      warningPrinted,
    }
  }

  /**
   * Print a prominent stderr warning. Format chosen to be
   * maximally visible — user can't miss it scrolling past startup
   * logs. Uses ASCII box-drawing so it works on any terminal.
   */
  function printWarning(): void {
    const banner = [
      "",
      "╔═══════════════════════════════════════════════════════════════════╗",
      "║                                                                   ║",
      "║   ⚠  DANGEROUS MODE: permission checks are DISABLED               ║",
      "║                                                                   ║",
      "║   opencode will run every tool call without asking for approval.  ║",
      "║   Bash commands, file edits, network requests, and shell access   ║",
      "║   all proceed without prompting. Use ONLY in sandboxes where the  ║",
      "║   entire process is isolated.                                     ║",
      "║                                                                   ║",
      "║   To disable: remove --dangerously-skip-permissions or unset      ║",
      "║   OPENCODE_DANGEROUSLY_SKIP_PERMISSIONS                           ║",
      "║                                                                   ║",
      "╚═══════════════════════════════════════════════════════════════════╝",
      "",
    ].join("\n")
    try {
      process.stderr.write(banner + "\n")
    } catch {
      // stderr write failures are non-fatal — the user might have
      // closed stderr (e.g. opencode | grep). The flag still applies,
      // they just don't see the visual warning.
    }
  }
}
