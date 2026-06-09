/**
 * Shared help + error-output scaffold for CLI subcommands.
 *
 * Every `opencode <subcmd>` that is intended for model consumption should:
 *   1. Expose a rich `--help` via `renderHelp(spec)` (Usage / Required /
 *      Optional / Examples / See-also sections).
 *   2. On invalid args or runtime misuse, emit a parseable three-line triple
 *      on stderr via `emitError(spec, message, hint?)`:
 *        error: <what went wrong>
 *        hint:  <minimum-correct signature>
 *        help:  opencode <subcmd> --help
 *      then exit non-zero.
 *
 * The triple shape lets the model spot the fix without re-running --help,
 * while the hint points at the full docs when the fix isn't obvious.
 */

export interface HelpFlag {
  /** Flag spec as it appears in Usage, e.g. `--every <duration>`. */
  flag: string
  /** One-line description. */
  desc: string
}

export interface SubcmdSpec {
  /** Fully qualified command name, e.g. "cron create". */
  name: string
  /** One-line summary (shown at top of --help and in `opencode --help` lists). */
  summary: string
  /** Signature line (without the leading `opencode`), e.g. `cron create --every <d> --task <p> [--agent <n>]`. */
  usage: string
  required?: HelpFlag[]
  optional?: HelpFlag[]
  /** Copy-pasteable examples. 2-3 is ideal. */
  examples: string[]
  /** Sibling subcommands (bare names, no `opencode` prefix). */
  seeAlso?: string[]
}

function section(title: string, lines: string[]): string {
  if (lines.length === 0) return ""
  return `\n${title}:\n${lines.map((l) => `  ${l}`).join("\n")}\n`
}

function renderFlags(flags: HelpFlag[] | undefined): string[] {
  if (!flags || flags.length === 0) return []
  const width = Math.max(...flags.map((f) => f.flag.length))
  return flags.map((f) => `${f.flag.padEnd(width)}  ${f.desc}`)
}

/** Build the full `--help` text for a subcommand. */
export function renderHelp(spec: SubcmdSpec): string {
  const parts: string[] = [spec.summary, ""]
  parts.push(`Usage:\n  opencode ${spec.usage}`)
  parts.push(section("Required", renderFlags(spec.required)))
  parts.push(section("Optional", renderFlags(spec.optional)))
  if (spec.examples.length > 0) {
    parts.push(section("Examples", spec.examples.map((e) => (e.startsWith("opencode ") ? e : `opencode ${e}`))))
  }
  if (spec.seeAlso && spec.seeAlso.length > 0) {
    parts.push(section("See also", spec.seeAlso.map((s) => `opencode ${s}`)))
  }
  return parts.filter(Boolean).join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n"
}

/** Shorthand: signature line the model should copy when hinted. */
export function minimalSignature(spec: SubcmdSpec): string {
  return `opencode ${spec.usage}`
}

/**
 * Emit the structured error triple on stderr and exit non-zero.
 *
 *   error: <message>
 *   hint:  <hint or minimum-correct signature>
 *   help:  opencode <name> --help
 *
 * Returns `never` — always calls process.exit.
 */
export function emitError(spec: SubcmdSpec, message: string, hint?: string): never {
  const sig = hint ?? minimalSignature(spec)
  const lines = [`error: ${message}`, `hint:  ${sig}`, `help:  opencode ${spec.name} --help`]
  process.stderr.write(lines.join("\n") + "\n")
  process.exit(2)
}

/**
 * Emit `renderHelp(spec)` to stdout and exit 0. Useful in handlers that
 * detect a `--help` or bare invocation and want to print help without
 * yargs' built-in formatter.
 */
export function emitHelp(spec: SubcmdSpec): never {
  process.stdout.write(renderHelp(spec))
  process.exit(0)
}

/**
 * Yargs-fail-handler factory. Use as `yargs.fail(makeYargsFailHandler(spec))`
 * so validation errors (missing required flag, unknown option, etc.) go
 * through the structured triple.
 */
export function makeYargsFailHandler(spec: SubcmdSpec) {
  return (msg: string | null, err: Error | undefined): never => {
    const message = err?.message || msg || "invalid invocation"
    emitError(spec, message)
  }
}
