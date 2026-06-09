import { EOL } from "os"
import { Project } from "@/config/project/project"
import { Log } from "@/foundation/util/log"
import { cmd } from "@/surface/cli/cmd/cmd"

export const ScrapCommand = cmd({
  command: "scrap",
  describe: "list all known projects",
  builder: (yargs) => yargs,
  async handler() {
    const timer = Log.Default.time("scrap")
    const list = await Project.list()
    process.stdout.write(JSON.stringify(list, null, 2) + EOL)
    timer.stop()
  },
})
