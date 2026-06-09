// util/cli-args.ts
//
// Eager CLI argument parsing helpers (parity gap-54).
//
// PROVENANCE: ported from
// `instructkr-claude-code/src/utils/cliArgs.ts` (60 LOC). Two
// self-contained functions for parsing CLI flags BEFORE the main
// option parser (yargs in opencode's case) runs. Useful for flags
// that must be inspected during init — settings paths, debug
// toggles, port overrides — that affect how the rest of the parser
// is configured.
//
// THE PROBLEM
// ===========
// opencode's existing pattern for "is this flag present?" is:
//   process.argv.includes("--port")
// scattered across cli/network.ts, cli/cmd/tui/thread.ts,
// cli/cmd/tui/worker.ts, and a few other places. Two issues:
//
//   1. Only tells you the flag IS PRESENT — doesn't return its VALUE.
//      For `--port 8080`, you'd need
//      `process.argv[process.argv.indexOf("--port") + 1]`, which
//      doesn't handle `--port=8080` syntax.
//
//   2. Returns false for `--port=8080` because the literal
//      "--port" doesn't appear as its own argv entry. The
//      shell-style `--flag=value` form is silently missed.
//
// Both forms ARE valid Unix CLI conventions. yargs handles both
// transparently when it runs, but the early-parse path doesn't.
//
// THE FIX
// =======
// `eagerParseCliFlag(name)` walks process.argv looking for either
// `--flag value` (two adjacent args) or `--flag=value` (single arg
// with `=` separator). Returns the value string or undefined.
//
// `extractArgsAfterDoubleDash(commandOrValue, args)` handles the
// Unix `--` separator convention: when a CLI library uses
// pass-through options, the `--` ends up as a positional argument
// rather than being consumed by the parser. This helper detects the
// `--` positional and pulls the actual command out of the rest
// array.
//
// USAGE
// =====
// ```ts
// import { CliArgs } from "./util/cli-args"
//
// // Inside init code that runs before yargs is configured
// const settingsPath = CliArgs.eagerParseCliFlag("--settings")
// if (settingsPath) {
//   loadSettingsFrom(settingsPath)
// }
//
// // Handle the -- separator pass-through
// const { command, args } = CliArgs.extractArgsAfterDoubleDash(
//   parsedCommand,
//   parsedRestArgs,
// )
// ```
//
// THIS IS NOT
// ===========
// Not a yargs replacement. Doesn't validate flag presence, doesn't
// enforce types, doesn't enforce required-ness. Use this only for
// the 1-2 flags that must be inspected before the real parser runs.
// Everything else should use yargs.
//
// Doesn't support short flags (`-p`). The two opencode use cases
// (--settings, --port) are long flags. Add short-flag support if a
// real consumer needs it.

export namespace CliArgs {
  /**
   * Parse a CLI flag value early, before the main option parser
   * processes arguments. Supports both space-separated
   * (`--flag value`) and equals-separated (`--flag=value`) syntax.
   *
   * Intended for flags that must be parsed before init() runs,
   * such as `--settings` which affects configuration loading. For
   * normal flag parsing, rely on yargs which handles this
   * automatically.
   *
   * @param flagName The flag name including dashes (e.g. "--settings")
   * @param argv Optional argv array to parse (defaults to process.argv)
   * @returns The value string if found, undefined otherwise
   */
  export function eagerParseCliFlag(flagName: string, argv: readonly string[] = process.argv): string | undefined {
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i]
      // Handle --flag=value syntax
      if (arg?.startsWith(`${flagName}=`)) {
        return arg.slice(flagName.length + 1)
      }
      // Handle --flag value syntax (next arg is the value)
      if (arg === flagName && i + 1 < argv.length) {
        return argv[i + 1]
      }
    }
    return undefined
  }

  /**
   * Check whether a CLI flag is present in argv. Doesn't extract
   * the value — just a boolean check. Handles both `--flag` (alone)
   * and `--flag=value` (with assigned value) forms.
   *
   * Useful when the caller only needs presence, not value:
   *   if (CliArgs.hasCliFlag("--print-logs")) ...
   *
   * Faster than `eagerParseCliFlag(name) !== undefined` for
   * value-less flags because it short-circuits on the first match
   * without needing to inspect the next argv entry.
   *
   * @param flagName The flag name including dashes
   * @param argv Optional argv array to parse (defaults to process.argv)
   */
  export function hasCliFlag(flagName: string, argv: readonly string[] = process.argv): boolean {
    const equalsPrefix = `${flagName}=`
    for (const arg of argv) {
      if (arg === flagName) return true
      if (arg?.startsWith(equalsPrefix)) return true
    }
    return false
  }

  /**
   * Handle the standard Unix `--` separator convention in CLI
   * arguments.
   *
   * When using a CLI library with pass-through options (yargs's
   * `parserConfiguration({ "populate--": true })` or commander's
   * `passThroughOptions`), the `--` separator is sometimes passed
   * through as a positional argument rather than being consumed.
   * That means a command like:
   *
   *   `cmd --opt value name -- subcmd --flag arg`
   *
   * gets parsed as:
   *
   *   positional1 = "name"
   *   positional2 = "--"
   *   rest        = ["subcmd", "--flag", "arg"]
   *
   * This helper detects when the supposed-command-or-value is `--`
   * and extracts the real command from the rest array.
   *
   * @param commandOrValue The parsed positional that may be "--"
   * @param args The remaining arguments array
   * @returns Object with corrected command + args
   */
  export function extractArgsAfterDoubleDash(
    commandOrValue: string,
    args: readonly string[] = [],
  ): { command: string; args: string[] } {
    if (commandOrValue === "--" && args.length > 0) {
      return {
        command: args[0]!,
        args: args.slice(1),
      }
    }
    return { command: commandOrValue, args: args.slice() }
  }
}
