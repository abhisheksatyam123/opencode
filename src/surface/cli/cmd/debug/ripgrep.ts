import { EOL } from "os"
import * as path from "path"
import { Ripgrep } from "@/filesystem/file/ripgrep"
import { Instance } from "@/config/project/instance"
import { Hyperlink } from "@/foundation/util/hyperlink"
import { bootstrap } from "@/surface/cli/bootstrap"
import { cmd } from "@/surface/cli/cmd/cmd"

export const RipgrepCommand = cmd({
  command: "rg",
  describe: "ripgrep debugging utilities",
  builder: (yargs) => yargs.command(TreeCommand).command(FilesCommand).command(SearchCommand).demandCommand(),
  async handler() {},
})

const TreeCommand = cmd({
  command: "tree",
  describe: "show file tree using ripgrep",
  builder: (yargs) =>
    yargs.option("limit", {
      type: "number",
    }),
  async handler(args) {
    await bootstrap(process.cwd(), async () => {
      process.stdout.write((await Ripgrep.tree({ cwd: Instance.directory, limit: args.limit })) + EOL)
    })
  },
})

const FilesCommand = cmd({
  command: "files",
  describe: "list files using ripgrep",
  builder: (yargs) =>
    yargs
      .option("query", {
        type: "string",
        description: "Filter files by query",
      })
      .option("glob", {
        type: "string",
        description: "Glob pattern to match files",
      })
      .option("limit", {
        type: "number",
        description: "Limit number of results",
      }),
  async handler(args) {
    await bootstrap(process.cwd(), async () => {
      const files: string[] = []
      for await (const file of Ripgrep.files({
        cwd: Instance.directory,
        glob: args.glob ? [args.glob] : undefined,
      })) {
        files.push(file)
        if (args.limit && files.length >= args.limit) break
      }
      // gap-29-followup-1: wrap each file path in an OSC 8 hyperlink
      // so it's clickable in supported terminals (iTerm2, kitty, wezterm,
      // ghostty, etc). Ripgrep yields paths RELATIVE to the cwd, so we
      // join with Instance.directory to get an absolute file:// link
      // target while still showing the relative path as the display.
      const lines = files.map((f) => Hyperlink.file(path.join(Instance.directory, f), f))
      process.stdout.write(lines.join(EOL) + EOL)
    })
  },
})

const SearchCommand = cmd({
  command: "search <pattern>",
  describe: "search file contents using ripgrep",
  builder: (yargs) =>
    yargs
      .positional("pattern", {
        type: "string",
        demandOption: true,
        description: "Search pattern",
      })
      .option("glob", {
        type: "array",
        description: "File glob patterns",
      })
      .option("limit", {
        type: "number",
        description: "Limit number of results",
      }),
  async handler(args) {
    const results = await Ripgrep.search({
      cwd: process.cwd(),
      pattern: args.pattern,
      glob: args.glob as string[] | undefined,
      limit: args.limit,
    })
    process.stdout.write(JSON.stringify(results, null, 2) + EOL)
  },
})
