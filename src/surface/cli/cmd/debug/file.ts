import { EOL } from "os"
import * as path from "path"
import { File } from "@/filesystem/file"
import { Hyperlink } from "@/foundation/util/hyperlink"
import { Instance } from "@/config/project/instance"
import { bootstrap } from "@/surface/cli/bootstrap"
import { cmd } from "@/surface/cli/cmd/cmd"
import { Ripgrep } from "@/filesystem/file/ripgrep"

const FileSearchCommand = cmd({
  command: "search <query>",
  describe: "search files by query",
  builder: (yargs) =>
    yargs.positional("query", {
      type: "string",
      demandOption: true,
      description: "Search query",
    }),
  async handler(args) {
    await bootstrap(process.cwd(), async () => {
      const results = await File.search({ query: args.query })
      // gap-29-followup-1: wrap each path in an OSC 8 hyperlink so
      // it's clickable in supported terminals. File.search returns
      // paths relative to Instance.directory, so join for the link
      // target while keeping the relative form as the display.
      const lines = results.map((f) => Hyperlink.file(path.join(Instance.directory, f), f))
      process.stdout.write(lines.join(EOL) + EOL)
    })
  },
})

const FileReadCommand = cmd({
  command: "read <path>",
  describe: "read file contents as JSON",
  builder: (yargs) =>
    yargs.positional("path", {
      type: "string",
      demandOption: true,
      description: "File path to read",
    }),
  async handler(args) {
    await bootstrap(process.cwd(), async () => {
      const content = await File.read(args.path)
      process.stdout.write(JSON.stringify(content, null, 2) + EOL)
    })
  },
})

const FileStatusCommand = cmd({
  command: "status",
  describe: "show file status information",
  builder: (yargs) => yargs,
  async handler() {
    await bootstrap(process.cwd(), async () => {
      const status = await File.status()
      process.stdout.write(JSON.stringify(status, null, 2) + EOL)
    })
  },
})

const FileListCommand = cmd({
  command: "list <path>",
  describe: "list files in a directory",
  builder: (yargs) =>
    yargs.positional("path", {
      type: "string",
      demandOption: true,
      description: "File path to list",
    }),
  async handler(args) {
    await bootstrap(process.cwd(), async () => {
      const files = await File.list(args.path)
      process.stdout.write(JSON.stringify(files, null, 2) + EOL)
    })
  },
})

const FileTreeCommand = cmd({
  command: "tree [dir]",
  describe: "show directory tree",
  builder: (yargs) =>
    yargs.positional("dir", {
      type: "string",
      description: "Directory to tree",
      default: process.cwd(),
    }),
  async handler(args) {
    const files = await Ripgrep.tree({ cwd: args.dir, limit: 200 })
    console.log(JSON.stringify(files, null, 2))
  },
})

export const FileCommand = cmd({
  command: "file",
  describe: "file system debugging utilities",
  builder: (yargs) =>
    yargs
      .command(FileReadCommand)
      .command(FileStatusCommand)
      .command(FileListCommand)
      .command(FileSearchCommand)
      .command(FileTreeCommand)
      .demandCommand(),
  async handler() {},
})
