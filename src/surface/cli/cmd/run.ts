import type { Argv } from "yargs"
import path from "path"
import { pathToFileURL } from "url"
import { UI } from "@/surface/cli/ui"
import { cmd } from "@/surface/cli/cmd/cmd"
import { Flag } from "@/foundation/flag/flag"
import { bootstrap } from "@/surface/cli/bootstrap"
import { EOL } from "os"
import { Filesystem } from "@/foundation/util/filesystem"
import { PreventSleep } from "@/foundation/util/prevent-sleep"
import { createOpencodeClient, type Message, type OpencodeClient, type ToolPart } from "@opencode-ai/sdk/v2"
import { Server } from "@/surface/server/server"
import { Provider } from "@/provider/provider"
import { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Tool } from "@/tool/tool"
import { TaskTool } from "@/tool/task"
import { BashTool } from "@/tool/bash"
import { Locale } from "@/foundation/util/locale"
import { NdjsonSafe } from "@/foundation/util/ndjson-safe"
import { type PermissionMode } from "@/config/types"

type ToolProps<T> = {
  input: Tool.InferParameters<T>
  metadata: Tool.InferMetadata<T>
  part: ToolPart
}

function props<T>(part: ToolPart): ToolProps<T> {
  const state = part.state
  return {
    input: state.input as Tool.InferParameters<T>,
    metadata: ("metadata" in state ? state.metadata : {}) as Tool.InferMetadata<T>,
    part,
  }
}

type Inline = {
  icon: string
  title: string
  description?: string
}

type BashOutputLine = {
  kind: "output" | "meta"
  text: string
}

const BASH_METADATA_START = "<bash_metadata>"
const BASH_METADATA_END = "</bash_metadata>"
const BASH_ERROR_PATTERN =
  /\b(error|failed|failure|fatal|exception|traceback|permission denied|not found|no such file|cannot|denied|segmentation fault|panic)\b/i
const BASH_WARNING_PATTERN = /\b(warn|warning|deprecated|timeout|timed out)\b/i

function parseBashOutputLines(output: string): BashOutputLine[] {
  if (!output) return []

  const lines = output.split("\n")
  const parsed: BashOutputLine[] = []
  let inMetaBlock = false

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === BASH_METADATA_START) {
      inMetaBlock = true
      continue
    }
    if (trimmed === BASH_METADATA_END) {
      inMetaBlock = false
      continue
    }
    parsed.push({
      kind: inMetaBlock ? "meta" : "output",
      text: line,
    })
  }

  return parsed
}

function colorizeBashLine(line: BashOutputLine) {
  if (line.kind === "meta") return UI.Style.TEXT_WARNING + line.text + UI.Style.TEXT_NORMAL
  if (!line.text.trim()) return line.text
  if (BASH_ERROR_PATTERN.test(line.text)) return UI.Style.TEXT_DANGER + line.text + UI.Style.TEXT_NORMAL
  if (BASH_WARNING_PATTERN.test(line.text)) return UI.Style.TEXT_WARNING + line.text + UI.Style.TEXT_NORMAL
  return line.text
}

function getBashExitCode(metadata: unknown): number | undefined {
  if (!metadata || typeof metadata !== "object") return undefined
  const meta = metadata as Record<string, unknown>
  if (typeof meta.exitCode === "number") return meta.exitCode
  if (typeof meta.exit === "number") return meta.exit
  return undefined
}

function inline(info: Inline) {
  const suffix = info.description ? UI.Style.TEXT_DIM + ` ${info.description}` + UI.Style.TEXT_NORMAL : ""
  UI.println(UI.Style.TEXT_NORMAL + info.icon, UI.Style.TEXT_NORMAL + info.title + suffix)
}

function block(info: Inline, output?: string) {
  UI.empty()
  inline(info)
  if (!output?.trim()) return
  UI.println(output)
  UI.empty()
}

function fallback(part: ToolPart) {
  const state = part.state
  const input = "input" in state ? state.input : undefined
  const title =
    ("title" in state && state.title ? state.title : undefined) ||
    (input && typeof input === "object" && Object.keys(input).length > 0 ? JSON.stringify(input) : "Unknown")
  inline({
    icon: "⚙",
    title: `${part.tool} ${title}`,
  })
}


function task(info: ToolProps<typeof TaskTool>) {
  const input = info.part.state.input
  const status = info.part.state.status
  const subagent =
    typeof input.subagent_type === "string" && input.subagent_type.trim().length > 0 ? input.subagent_type : "unknown"
  const agent = Locale.titlecase(subagent)
  const desc =
    typeof input.description === "string" && input.description.trim().length > 0 ? input.description : undefined
  const icon = status === "error" ? "✗" : status === "running" ? "•" : "✓"
  const name = desc ?? `${agent} Task`
  inline({
    icon,
    title: name,
    description: desc ? `${agent} Agent` : undefined,
  })
}

function bash(info: ToolProps<typeof BashTool>) {
  const output = info.part.state.status === "completed" ? info.part.state.output?.trim() : undefined
  const command = String(info.input.command ?? "").trim() || "(empty command)"
  const exitCode = getBashExitCode(info.metadata)
  const lines = parseBashOutputLines(output ?? "")

  UI.empty()
  inline({
    icon: UI.Style.TEXT_HIGHLIGHT + "$" + UI.Style.TEXT_NORMAL,
    title: UI.Style.TEXT_HIGHLIGHT + command + UI.Style.TEXT_NORMAL,
  })

  if (typeof exitCode === "number") {
    const statusStyle = exitCode === 0 ? UI.Style.TEXT_SUCCESS_BOLD : UI.Style.TEXT_DANGER_BOLD
    UI.println(UI.Style.TEXT_DIM + "  ↳ " + statusStyle + `exit ${exitCode}` + UI.Style.TEXT_NORMAL)
  }

  for (const line of lines) {
    const prefix =
      line.kind === "meta"
        ? UI.Style.TEXT_WARNING + "! " + UI.Style.TEXT_NORMAL
        : UI.Style.TEXT_DIM + "| " + UI.Style.TEXT_NORMAL
    UI.println(prefix + colorizeBashLine(line))
  }

  UI.empty()
}

function normalizePath(input?: string) {
  if (!input) return ""
  if (path.isAbsolute(input)) return path.relative(process.cwd(), input) || "@/surface/cli/cmd"
  return input
}

export const RunCommand = cmd({
  command: "run [message..]",
  describe: "run opencode with a message",
  builder: (yargs: Argv) => {
    return yargs
      .positional("message", {
        describe: "message to send",
        type: "string",
        array: true,
        default: [],
      })
      .option("command", {
        describe: "the command to run, use message for args",
        type: "string",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        describe: "session id to continue",
        type: "string",
      })
      .option("fork", {
        describe: "fork the session before continuing (requires --continue or --session)",
        type: "boolean",
      })
      .option("share", {
        type: "boolean",
        describe: "share the session",
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      })
      .option("agent", {
        type: "string",
        describe: "agent to use",
      })
      .option("format", {
        type: "string",
        choices: ["default", "json"],
        default: "default",
        describe: "format: default (formatted) or json (raw JSON events)",
      })
      .option("file", {
        alias: ["f"],
        type: "string",
        array: true,
        describe: "file(s) to attach to message",
      })
      .option("title", {
        type: "string",
        describe: "title for the session (uses truncated prompt if no value provided)",
      })
      .option("attach", {
        type: "string",
        describe: "attach to a running opencode server (e.g., http://localhost:4096)",
      })
      .option("password", {
        alias: ["p"],
        type: "string",
        describe: "basic auth password (defaults to OPENCODE_SERVER_PASSWORD)",
      })
      .option("dir", {
        type: "string",
        describe: "directory to run in, path on remote server if attaching",
      })
      .option("port", {
        type: "number",
        describe: "port for the local server (defaults to random port if no value provided)",
      })
      .option("variant", {
        type: "string",
        describe: "model variant (provider-specific reasoning effort, e.g., high, max, minimal)",
      })
      .option("thinking", {
        type: "boolean",
        describe: "show thinking blocks",
        default: false,
      })
      .option("print", {
        type: "boolean",
        default: false,
        describe:
          "headless mode: print the assistant response and exit cleanly when the session reaches idle. Honors --format (default: text, use --format json for NDJSON). When stdin is piped, its contents are appended to the positional message. Short alias -p is reserved for --password; long-form only for now.",
      })
      .option("permission-mode", {
        type: "string",
        choices: ["default", "plan", "bypass"] as const,
        default: "default",
        describe:
          "permission mode: 'default' asks the user, 'plan' auto-rejects writes (read-only agent), 'bypass' auto-approves all (dangerous)",
      })
  },
  handler: async (args) => {
    let message = [...args.message, ...(args["--"] || [])]
      .map((arg) => (arg.includes(" ") ? `"${arg.replace(/"/g, '\\"')}"` : arg))
      .join(" ")

    const directory = (() => {
      if (!args.dir) return undefined
      if (args.attach) return args.dir
      try {
        process.chdir(args.dir)
        return process.cwd()
      } catch {
        UI.error("Failed to change directory to " + args.dir)
        process.exit(1)
      }
    })()

    const files: { type: "file"; url: string; filename: string; mime: string }[] = []
    if (args.file) {
      const list = Array.isArray(args.file) ? args.file : [args.file]

      for (const filePath of list) {
        const resolvedPath = path.resolve(process.cwd(), filePath)
        if (!(await Filesystem.exists(resolvedPath))) {
          UI.error(`File not found: ${filePath}`)
          process.exit(1)
        }

        const mime = (await Filesystem.isDir(resolvedPath)) ? "application/x-directory" : "text/plain"

        files.push({
          type: "file",
          url: pathToFileURL(resolvedPath).href,
          filename: path.basename(resolvedPath),
          mime,
        })
      }
    }

    if (!process.stdin.isTTY) message += "\n" + (await Bun.stdin.text())

    if (message.trim().length === 0 && !args.command) {
      UI.error("You must provide a message or a command")
      process.exit(1)
    }

    if (args.fork && !args.continue && !args.session) {
      UI.error("--fork requires --continue or --session")
      process.exit(1)
    }

    const rules: Permission.Ruleset = [
      {
        permission: "plan_enter",
        action: "deny",
        pattern: "*",
      },
      {
        permission: "plan_exit",
        action: "deny",
        pattern: "*",
      },
    ]

    function title() {
      if (args.title === undefined) return
      if (args.title !== "") return args.title
      return message.slice(0, 50) + (message.length > 50 ? "..." : "")
    }

    async function session(sdk: OpencodeClient) {
      const baseID = args.continue ? (await sdk.session.list()).data?.find((s) => !s.parentID)?.id : args.session

      if (baseID && args.fork) {
        const forked = await sdk.session.fork({ sessionID: baseID })
        return forked.data?.id
      }

      if (baseID) return baseID

      const name = title()
      const result = await sdk.session.create({
        title: name,
        permission: rules,
        permissionMode: (args.permissionMode ?? "default") as PermissionMode,
      })
      return result.data?.id
    }

    async function share(sdk: OpencodeClient, sessionID: string) {
      const cfg = await sdk.config.get()
      if (!cfg.data) return
      if (cfg.data.share !== "auto" && !Flag.OPENCODE_AUTO_SHARE && !args.share) return
      const res = await sdk.session.share({ sessionID }).catch((error) => {
        if (error instanceof Error && error.message.includes("disabled")) {
          UI.println(UI.Style.TEXT_DANGER_BOLD + "!  " + error.message)
        }
        return { error }
      })
      if (!res.error && "data" in res && res.data?.share?.url) {
        UI.println(UI.Style.TEXT_INFO_BOLD + "~  " + res.data.share.url)
      }
    }

    async function execute(sdk: OpencodeClient) {
      function tool(part: ToolPart) {
        try {
          if (part.tool === "bash") return bash(props<typeof BashTool>(part))
          if (part.tool === "task") return task(props<typeof TaskTool>(part))
          return fallback(part)
        } catch {
          return fallback(part)
        }
      }

      function emit(type: string, data: Record<string, unknown>) {
        if (args.format === "json") {
          // gap-28-followup-1: NdjsonSafe escapes U+2028/U+2029 so
          // tool outputs and file paths can't be cut by line-splitting receivers.
          process.stdout.write(NdjsonSafe.stringify({ type, timestamp: Date.now(), sessionID, ...data }) + EOL)
          return true
        }
        return false
      }

      const events = await sdk.event.subscribe()
      let error: string | undefined

      async function loop() {
        const toggles = new Map<string, boolean>()

        for await (const event of events.stream) {
          if (
            event.type === "message.updated" &&
            event.properties.info.role === "assistant" &&
            args.format !== "json" &&
            !args.print &&
            toggles.get("start") !== true
          ) {
            UI.empty()
            UI.println(`> ${event.properties.info.agent} · ${event.properties.info.modelID}`)
            UI.empty()
            toggles.set("start", true)
          }

          if (event.type === "message.part.updated") {
            const part = event.properties.part
            if (part.sessionID !== sessionID) continue

            if (part.type === "tool" && (part.state.status === "completed" || part.state.status === "error")) {
              if (emit("tool_use", { part })) continue
              if (args.print) {
                // In print mode, tool chrome is suppressed (text format).
                // Errors still go to stderr via UI.error.
                if (part.state.status === "error") UI.error(part.state.error)
                continue
              }
              if (part.state.status === "completed") {
                tool(part)
                continue
              }
              inline({
                icon: "✗",
                title: `${part.tool} failed`,
              })
              UI.error(part.state.error)
            }

            if (
              part.type === "tool" &&
              part.tool === "task" &&
              part.state.status === "running" &&
              args.format !== "json" &&
              !args.print
            ) {
              if (toggles.get(part.id) === true) continue
              task(props<typeof TaskTool>(part))
              toggles.set(part.id, true)
            }

            if (part.type === "step-start") {
              if (emit("step_start", { part })) continue
            }

            if (part.type === "step-finish") {
              if (emit("step_finish", { part })) continue
            }

            if (part.type === "text" && part.time?.end) {
              if (emit("text", { part })) continue
              const text = part.text.trim()
              if (!text) continue
              if (!process.stdout.isTTY || args.print) {
                process.stdout.write(text + EOL)
                continue
              }
              UI.empty()
              UI.println(text)
              UI.empty()
            }

            if (part.type === "reasoning" && part.time?.end && args.thinking) {
              if (emit("reasoning", { part })) continue
              const text = part.text.trim()
              if (!text) continue
              const line = `Thinking: ${text}`
              if (process.stdout.isTTY) {
                UI.empty()
                UI.println(`${UI.Style.TEXT_DIM}\u001b[3m${line}\u001b[0m${UI.Style.TEXT_NORMAL}`)
                UI.empty()
                continue
              }
              process.stdout.write(line + EOL)
            }
          }

          if (event.type === "session.error") {
            const props = event.properties
            if (props.sessionID !== sessionID || !props.error) continue
            let err = String(props.error.name)
            if ("data" in props.error && props.error.data && "message" in props.error.data) {
              err = String(props.error.data.message)
            }
            error = error ? error + EOL + err : err
            if (emit("error", { error: props.error })) continue
            UI.error(err)
          }

          if (
            event.type === "session.status" &&
            event.properties.sessionID === sessionID &&
            event.properties.status.type === "idle"
          ) {
            break
          }

          if (event.type === "permission.asked") {
            const permission = event.properties
            if (permission.sessionID !== sessionID) continue
            UI.println(
              UI.Style.TEXT_WARNING_BOLD + "!",
              UI.Style.TEXT_NORMAL +
                `permission requested: ${permission.permission} (${permission.patterns.join(", ")}); auto-rejecting`,
            )
            await sdk.permission.reply({
              requestID: permission.id,
              reply: "reject",
            })
          }
        }
      }

      // Validate agent if specified
      const agent = await (async () => {
        if (!args.agent) return undefined

        // When attaching, validate against the running server instead of local Instance state.
        if (args.attach) {
          const modes = await sdk.app
            .agents(undefined, { throwOnError: true })
            .then((x) => x.data ?? [])
            .catch(() => undefined)

          if (!modes) {
            UI.println(
              UI.Style.TEXT_WARNING_BOLD + "!",
              UI.Style.TEXT_NORMAL,
              `failed to list agents from ${args.attach}. Falling back to default agent`,
            )
            return undefined
          }

          const agent = modes.find((a) => a.name === args.agent)
          if (!agent) {
            UI.println(
              UI.Style.TEXT_WARNING_BOLD + "!",
              UI.Style.TEXT_NORMAL,
              `agent "${args.agent}" not found. Falling back to default agent`,
            )
            return undefined
          }

          if (agent.mode === "subagent") {
            UI.println(
              UI.Style.TEXT_WARNING_BOLD + "!",
              UI.Style.TEXT_NORMAL,
              `agent "${args.agent}" is a subagent, not a primary agent. Falling back to default agent`,
            )
            return undefined
          }

          return args.agent
        }

        const entry = await Agent.get(args.agent)
        if (!entry) {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `agent "${args.agent}" not found. Falling back to default agent`,
          )
          return undefined
        }
        if (entry.mode === "subagent") {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `agent "${args.agent}" is a subagent, not a primary agent. Falling back to default agent`,
          )
          return undefined
        }
        return args.agent
      })()

      const sessionID = await session(sdk)
      if (!sessionID) {
        UI.error("Session not found")
        process.exit(1)
      }
      await share(sdk, sessionID)

      const loopPromise = loop().catch((e) => {
        console.error(e)
        process.exit(1)
      })

      if (args.command) {
        await sdk.session.command({
          sessionID,
          agent,
          model: args.model,
          command: args.command,
          arguments: message,
          variant: args.variant,
        })
      } else {
        const model = args.model ? Provider.parseModel(args.model) : undefined
        await sdk.session.prompt({
          sessionID,
          agent,
          model,
          variant: args.variant,
          parts: [...files, { type: "text", text: message }],
        })
      }

      // Wait for the event loop to drain so print mode can observe any
      // session.error captured during the run. In interactive (non-print)
      // mode this is equivalent to the previous behaviour because loop()
      // still breaks on session.status.idle.
      await loopPromise

      if (args.print && error !== undefined) {
        // Non-zero exit so CI pipelines fail when the model errored.
        // `error !== undefined` (not just `error`) so an empty-string
        // error name from a pathological event still triggers the exit.
        process.exit(1)
      }
    }

    // gap-32-followup-1: hold an OS power assertion for the duration
    // of `opencode run` so the laptop doesn't sleep mid-API-call. The
    // wrapper is a no-op on platforms without caffeinate / systemd-inhibit.
    // Both attach-mode and bootstrap-mode call sites are wrapped so the
    // assertion is held regardless of which transport the run uses.
    if (args.attach) {
      const headers = (() => {
        const password = args.password ?? process.env.OPENCODE_SERVER_PASSWORD
        if (!password) return undefined
        const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode"
        const auth = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
        return { Authorization: auth }
      })()
      const sdk = createOpencodeClient({ baseUrl: args.attach, directory, headers })
      return await PreventSleep.run(() => execute(sdk))
    }

    await PreventSleep.run(() =>
      bootstrap(process.cwd(), async () => {
        const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init)
          return Server.Default().fetch(request)
        }) as typeof globalThis.fetch
        const sdk = createOpencodeClient({ baseUrl: "http://opencode.internal", fetch: fetchFn })
        await execute(sdk)
      }),
    )
  },
})
