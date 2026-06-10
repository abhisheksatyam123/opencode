// debug/outputs-scanner.ts
//
// `opencode debug outputs-scanner [path] [--since N]` — list files
// in a directory whose mtime ≥ a given timestamp (parity gap-4-followup-1).
//
// Brings `OutputsScanner.findModifiedFiles` (gap-4) from orphan →
// live consumer. The scanner provides three things that the
// equivalent `find -newer file` shell command doesn't:
//
//   1. Recursive parallel-stat scan via Promise.all (faster than
//      sequential `find` for large trees)
//   2. Mtime cutoff in epoch milliseconds (sub-second precision —
//      `find -newer` only compares against another file's mtime)
//   3. Symlink security: skips symlinks unconditionally so an
//      attacker can't trick the scanner into traversing outside
//      the requested directory (`find -L` follows them by default)
//
// Use cases:
//   * Magic Docs debugging: "what doc files have changed since the
//     session started?"
//   * Diff acceleration debugging: "what files mtime'd since the
//     last snapshot?"
//   * General "did anything change here?" probe with sub-second
//     precision
//
// Example:
//   $ opencode debug outputs-scanner --since 1733635200000 src/
//   /abs/path/src/foo.ts
//   /abs/path/src/bar/baz.ts
//   (2 files modified since 2024-12-08T07:20:00.000Z)
//
//   $ opencode debug outputs-scanner src/
//   (no --since: defaults to "60 seconds ago")

import * as path from "path"
import { OutputsScanner } from "@/filesystem/file/outputs-scanner"
import { Instance } from "@/config/project/instance"
import { NdjsonSafe } from "@/foundation/util/ndjson-safe"
import { Hyperlink } from "@/foundation/util/hyperlink"
import { bootstrap } from "@/surface/cli/bootstrap"
import { cmd } from "@/surface/cli/cmd/cmd"

const DEFAULT_LOOKBACK_MS = 60_000 // 60 seconds

export const OutputsScannerCommand = cmd({
  command: "outputs-scanner [path]",
  describe: "list files in a directory whose mtime is >= a given timestamp",
  builder: (yargs) =>
    yargs
      .positional("path", {
        type: "string",
        description: "directory to scan (defaults to the current opencode project root)",
      })
      .option("since", {
        type: "number",
        description: "mtime cutoff in epoch milliseconds (defaults to 60 seconds ago)",
      })
      .option("relative", {
        type: "boolean",
        description: "print paths relative to the scanned directory",
        default: false,
      })
      .option("json", {
        type: "boolean",
        description: "emit a JSON object { dir, since, files } via NdjsonSafe (jq-able, line-splitter-safe)",
        default: false,
      }),
  async handler(args) {
    await bootstrap(process.cwd(), async () => {
      const dir = args.path ? path.resolve(args.path) : Instance.directory
      const since = args.since ?? Date.now() - DEFAULT_LOOKBACK_MS
      const files = await OutputsScanner.findModifiedFiles(since, dir)
      // gap-12/4/24-followup-2: --json output via NdjsonSafe.
      if (args.json) {
        const payload = {
          dir,
          since,
          sinceISO: new Date(since).toISOString(),
          count: files.length,
          files: args.relative ? files.map((f) => path.relative(dir, f)) : files,
        }
        console.log(NdjsonSafe.stringify(payload))
        return
      }
      if (files.length === 0) {
        console.log(`(no files modified since ${new Date(since).toISOString()} in ${dir})`)
        return
      }
      // gap-29: wrap each file path in an OSC 8 hyperlink so it's
      // clickable in supported terminals (iTerm2, kitty, wezterm,
      // ghostty, etc). Falls back to plain text in unsupported
      // terminals + when stdout is piped or redirected.
      for (const f of files) {
        const display = args.relative ? path.relative(dir, f) : f
        // The link target is always the absolute path so jumping
        // works regardless of cwd; the display text honors --relative.
        console.log(Hyperlink.file(f, display))
      }
      console.log(
        `(${files.length} file${files.length === 1 ? "" : "s"} modified since ${new Date(since).toISOString()})`,
      )
    })
  },
})
