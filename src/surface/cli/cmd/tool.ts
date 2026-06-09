import type { Argv } from "yargs"
import { cmd } from "@/surface/cli/cmd/cmd"
import { secondaryToolCatalog, runSecondaryTool } from "@/tool/secondary"

interface ToolListArgs {
  cwd?: string
  json?: boolean
}

const ToolListCommand = cmd({
  command: "list",
  describe: "list secondary tools discovered from <notes-root>/tools and configured script dirs",
  builder: (yargs: Argv) =>
    yargs
      .option("cwd", {
        type: "string",
        describe: "Working directory used for config resolution (default: process.cwd())",
      })
      .option("json", {
        type: "boolean",
        describe: "Emit machine-readable JSON",
        default: false,
      }),
  handler: async (args: ToolListArgs) => {
    const cwd = args.cwd ? String(args.cwd) : process.cwd()
    const catalog = await secondaryToolCatalog(cwd)

    if (args.json) {
      process.stdout.write(
        JSON.stringify(
          {
            notesRoot: catalog.notesRoot,
            dirs: catalog.dirs,
            tools: catalog.tools,
          },
          null,
          2,
        ) + "\n",
      )
      return
    }

    process.stdout.write(`notes_root: ${catalog.notesRoot}\n`)
    process.stdout.write(`dirs (${catalog.dirs.length}):\n`)
    if (catalog.dirs.length === 0) {
      process.stdout.write("- (none)\n")
    } else {
      for (const dir of catalog.dirs) process.stdout.write(`- ${dir}\n`)
    }
    process.stdout.write(`tools (${catalog.tools.length}):\n`)
    if (catalog.tools.length === 0) {
      process.stdout.write("- (none)\n")
      return
    }
    for (const tool of catalog.tools) {
      process.stdout.write(`- ${tool.name} :: ${tool.path}${tool.summary ? ` — ${tool.summary}` : ""}\n`)
    }
  },
})

interface ToolRunArgs {
  name?: string
  args?: string[]
  cwd?: string
}

const ToolRunCommand = cmd({
  command: "run <name> [args..]",
  describe: "execute a secondary tool by name from the discovered catalog",
  builder: (yargs: Argv) =>
    yargs
      .positional("name", {
        type: "string",
        describe: "Secondary tool name from `opencode tool list`",
      })
      .positional("args", {
        type: "string",
        array: true,
        describe: "Arguments passed through to the selected tool",
      })
      .option("cwd", {
        type: "string",
        describe: "Working directory used for config resolution and process cwd (default: process.cwd())",
      }),
  handler: async (args: ToolRunArgs) => {
    const cwd = args.cwd ? String(args.cwd) : process.cwd()
    const name = args.name ? String(args.name) : ""
    if (!name) throw new Error("Missing required tool name. Usage: opencode tool run <name> [args..]")
    const result = await runSecondaryTool({
      name,
      args: (args.args ?? []).map(String),
      cwd,
      stdio: "inherit",
    })
    if (result.code !== 0) process.exitCode = result.code
  },
})

export const ToolCommand = cmd({
  command: "tool",
  describe: "secondary script layer: list/run helper scripts from <notes-root>/tools (agent tool surface remains bash/task)",
  builder: (yargs: Argv) => yargs.command(ToolListCommand).command(ToolRunCommand).demandCommand(),
  handler: async () => {},
})
