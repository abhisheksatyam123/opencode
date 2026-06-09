import { Global } from "@/filesystem/global"
import { Hyperlink } from "@/foundation/util/hyperlink"
import { Sleep } from "@/foundation/util/sleep"
import { bootstrap } from "@/surface/cli/bootstrap"
import { cmd } from "@/surface/cli/cmd/cmd"
import { ConfigCommand } from "@/surface/cli/cmd/debug/config"
import { FileCommand } from "@/surface/cli/cmd/debug/file"
import { RipgrepCommand } from "@/surface/cli/cmd/debug/ripgrep"
import { ScrapCommand } from "@/surface/cli/cmd/debug/scrap"
import { SkillCommand } from "@/surface/cli/cmd/debug/skill"
import { SnapshotCommand } from "@/surface/cli/cmd/debug/snapshot"
import { AgentCommand } from "@/surface/cli/cmd/debug/agent"
import { TokensCommand } from "@/surface/cli/cmd/debug/tokens"
import { ToolSummaryCommand } from "@/surface/cli/cmd/debug/tool-summary"
import { AwaySummaryCommand } from "@/surface/cli/cmd/debug/away-summary"
import { OutputsScannerCommand } from "@/surface/cli/cmd/debug/outputs-scanner"
import { EventsCommand } from "@/surface/cli/cmd/debug/events"

export const DebugCommand = cmd({
  command: "debug",
  describe: "debugging and troubleshooting tools",
  builder: (yargs) =>
    yargs
      .command(ConfigCommand)
      .command(RipgrepCommand)
      .command(FileCommand)
      .command(ScrapCommand)
      .command(SkillCommand)
      .command(SnapshotCommand)
      .command(AgentCommand)
      .command(TokensCommand)
      .command(ToolSummaryCommand)
      .command(AwaySummaryCommand)
      .command(OutputsScannerCommand)
      .command(EventsCommand)
      .command(PathsCommand)
      .command({
        command: "wait",
        describe: "wait indefinitely (for debugging)",
        async handler() {
          await bootstrap(process.cwd(), async () => {
            // gap-26-followup-2: Sleep.until is the centralized helper.
            await Sleep.until(1_000 * 60 * 60 * 24)
          })
        },
      })
      .demandCommand(),
  async handler() {},
})

const PathsCommand = cmd({
  command: "paths",
  describe: "show global paths (data, config, cache, state)",
  handler() {
    // gap-29-followup-2: each Global.Path entry is an absolute
    // directory; wrap with Hyperlink.file so users can click to
    // open in supported terminals.
    for (const [key, value] of Object.entries(Global.Path)) {
      console.log(key.padEnd(10), Hyperlink.file(value))
    }
  },
})
