import { cmd } from "@/surface/cli/cmd/cmd"
import * as prompts from "@clack/prompts"
import { UI } from "@/surface/cli/ui"
import { Global } from "@/filesystem/global"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import path from "path"
import fs from "fs/promises"
import { Color } from "@/foundation/util/color"
import { Filesystem } from "@/foundation/util/filesystem"
import { Hyperlink } from "@/foundation/util/hyperlink"
import { hasHiddenSegment } from "@/foundation/util/path"
import matter from "gray-matter"
import { Instance } from "@/config/project/instance"
import { EOL } from "os"
import type { Argv } from "yargs"

// gap-color-followup-1: ANSI reset escape — terminates the bold + 24-bit
// color sequence emitted by `Color.hexToAnsiBold`. Hardcoded here rather
// than imported because util/color.ts deliberately does NOT export the
// reset code (it's only meaningful in the OUTPUT path, not as a helper).
const ANSI_RESET = "\x1b[0m"

type AgentMode = "all" | "primary" | "subagent"

const AVAILABLE_TOOLS = ["bash", "read", "write", "task", "todo"]

export function resolveAgentCreateTargetPath(cliPath: string | undefined) {
  if (!cliPath) return path.join(Global.Path.config, "agent")

  const resolved = path.resolve(cliPath)
  if (hasHiddenSegment(resolved)) {
    throw new Error(
      `hidden-agent-path-unsupported: --path resolves inside a hidden directory (${resolved}); use ${path.join(Global.Path.config, "agent")} or a non-hidden directory`,
    )
  }

  return path.join(resolved, "agent")
}

const AgentCreateCommand = cmd({
  command: "create",
  describe: "create a new agent",
  builder: (yargs: Argv) =>
    yargs
      .option("path", {
        type: "string",
        describe: "directory path to generate the agent file",
      })
      .option("description", {
        type: "string",
        describe: "what the agent should do",
      })
      .option("mode", {
        type: "string",
        describe: "agent mode",
        choices: ["all", "primary", "subagent"] as const,
      })
      .option("tools", {
        type: "string",
        describe: `comma-separated list of tools to enable (default: all). Available: "${AVAILABLE_TOOLS.join(", ")}"`,
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      }),
  async handler(args) {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        const cliPath = args.path
        const cliDescription = args.description
        const cliMode = args.mode as AgentMode | undefined
        const cliTools = args.tools

        const isFullyNonInteractive = cliPath && cliDescription && cliMode && cliTools !== undefined

        if (!isFullyNonInteractive) {
          UI.empty()
          prompts.intro("Create agent")
        }

        // Determine destination path
        const targetPath = resolveAgentCreateTargetPath(cliPath)

        // Get description
        let description: string
        if (cliDescription) {
          description = cliDescription
        } else {
          const query = await prompts.text({
            message: "Description",
            placeholder: "What should this agent do?",
            validate: (x) => (x && x.length > 0 ? undefined : "Required"),
          })
          if (prompts.isCancel(query)) throw new UI.CancelledError()
          description = query
        }

        // Generate agent
        const spinner = prompts.spinner()
        spinner.start("Generating agent configuration...")
        const model = args.model ? Provider.parseModel(args.model) : undefined
        const generated = await Agent.generate({ description, model }).catch((error) => {
          spinner.stop(`LLM failed to generate agent: ${error.message}`, 1)
          if (isFullyNonInteractive) process.exit(1)
          throw new UI.CancelledError()
        })
        spinner.stop(`Agent ${generated.identifier} generated`)

        // Select tools
        let selectedTools: string[]
        if (cliTools !== undefined) {
          selectedTools = cliTools ? cliTools.split(",").map((t) => t.trim()) : AVAILABLE_TOOLS
        } else {
          const result = await prompts.multiselect({
            message: "Select tools to enable (Space to toggle)",
            options: AVAILABLE_TOOLS.map((tool) => ({
              label: tool,
              value: tool,
            })),
            initialValues: AVAILABLE_TOOLS,
          })
          if (prompts.isCancel(result)) throw new UI.CancelledError()
          selectedTools = result
        }

        // Get mode
        let mode: AgentMode
        if (cliMode) {
          mode = cliMode
        } else {
          const modeResult = await prompts.select({
            message: "Agent mode",
            options: [
              {
                label: "All",
                value: "all" as const,
                hint: "Can function in both primary and subagent roles",
              },
              {
                label: "Primary",
                value: "primary" as const,
                hint: "Acts as a primary/main agent",
              },
              {
                label: "Subagent",
                value: "subagent" as const,
                hint: "Can be used as a subagent by other agents",
              },
            ],
            initialValue: "all" as const,
          })
          if (prompts.isCancel(modeResult)) throw new UI.CancelledError()
          mode = modeResult
        }

        // Build tools config
        const tools: Record<string, boolean> = {}
        for (const tool of AVAILABLE_TOOLS) {
          if (!selectedTools.includes(tool)) {
            tools[tool] = false
          }
        }

        // Build frontmatter
        const frontmatter: {
          description: string
          mode: AgentMode
          tools?: Record<string, boolean>
        } = {
          description: generated.whenToUse,
          mode,
        }
        if (Object.keys(tools).length > 0) {
          frontmatter.tools = tools
        }

        // Write file
        const content = matter.stringify(generated.systemPrompt, frontmatter)
        const filePath = path.join(targetPath, `${generated.identifier}.md`)

        await fs.mkdir(targetPath, { recursive: true })

        if (await Filesystem.exists(filePath)) {
          if (isFullyNonInteractive) {
            console.error(`Error: Agent file already exists: ${filePath}`)
            process.exit(1)
          }
          // gap-29-followup-3: clickable in supported terminals so the user can verify
          prompts.log.error(`Agent file already exists: ${Hyperlink.file(filePath)}`)
          throw new UI.CancelledError()
        }

        await Filesystem.write(filePath, content)

        if (isFullyNonInteractive) {
          // gap-29-followup-1: wrap the printed path in an OSC 8
          // hyperlink so it's clickable in supported terminals.
          console.log(Hyperlink.file(filePath))
        } else {
          // gap-29-followup-3: clickable in supported terminals
          prompts.log.success(`Agent created: ${Hyperlink.file(filePath)}`)
          prompts.outro("Done")
        }
      },
    })
  },
})

const AgentListCommand = cmd({
  command: "list",
  describe: "list all available agents",
  async handler() {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        const agents = await Agent.list()
        const sortedAgents = agents.sort((a, b) => {
          if (a.native !== b.native) {
            return a.native ? -1 : 1
          }
          return a.name.localeCompare(b.name)
        })

        // gap-color-followup-1: when an agent has a custom color set,
        // wrap its name in the ANSI bold + 24-bit color escape so users
        // can visually distinguish agents in the list output. Color
        // codes are only emitted when stdout is a TTY — piped output
        // (e.g. `opencode agent list | jq`) gets clean text.
        const useColor = process.stdout.isTTY
        for (const agent of sortedAgents) {
          const colorPrefix = useColor ? Color.hexToAnsiBold(agent.color) : undefined
          const name = colorPrefix ? `${colorPrefix}${agent.name}${ANSI_RESET}` : agent.name
          process.stdout.write(`${name} (${agent.mode})` + EOL)
          process.stdout.write(`  ${JSON.stringify(agent.permission, null, 2)}` + EOL)
        }
      },
    })
  },
})

export const AgentCommand = cmd({
  command: "agent",
  describe: "manage agents",
  builder: (yargs) => yargs.command(AgentCreateCommand).command(AgentListCommand).demandCommand(),
  async handler() {},
})
