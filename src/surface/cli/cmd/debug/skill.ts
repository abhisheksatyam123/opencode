import { EOL } from "os"
import { Skill } from "@/agent/skill"
import { bootstrap } from "@/surface/cli/bootstrap"
import { cmd } from "@/surface/cli/cmd/cmd"

export const SkillCommand = cmd({
  command: "skill",
  describe: "list all available skills",
  builder: (yargs) => yargs,
  async handler() {
    await bootstrap(process.cwd(), async () => {
      const skills = await Skill.all()
      process.stdout.write(JSON.stringify(skills, null, 2) + EOL)
    })
  },
})
