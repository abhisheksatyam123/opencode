import type { Argv } from "yargs"
import { cmd } from "@/surface/cli/cmd/cmd"
import { Session } from "@/process/session"
import { SessionID, MessageID, PartID } from "@/process/session/schema"
import { SessionRevert } from "@/process/session/revert"
import { bootstrap } from "@/surface/cli/bootstrap"
import { UI } from "@/surface/cli/ui"
import { Locale } from "@/foundation/util/locale"
import { Flag } from "@/foundation/flag/flag"
import { Filesystem } from "@/foundation/util/filesystem"
import { Process } from "@/foundation/util/process"
import { EOL } from "os"
import path from "path"
import { which } from "@/foundation/util/which"

function pagerCmd(): string[] {
  const lessOptions = ["-R", "-S"]
  if (process.platform !== "win32") {
    return ["less", ...lessOptions]
  }

  // user could have less installed via other options
  const lessOnPath = which("less")
  if (lessOnPath) {
    if (Filesystem.stat(lessOnPath)?.size) return [lessOnPath, ...lessOptions]
  }

  if (Flag.OPENCODE_GIT_BASH_PATH) {
    const less = path.join(Flag.OPENCODE_GIT_BASH_PATH, "@/surface/cli", "@/surface/cli", "usr", "bin", "less.exe")
    if (Filesystem.stat(less)?.size) return [less, ...lessOptions]
  }

  const git = which("git")
  if (git) {
    const less = path.join(git, "@/surface/cli", "@/surface/cli", "usr", "bin", "less.exe")
    if (Filesystem.stat(less)?.size) return [less, ...lessOptions]
  }

  // Fall back to Windows built-in more (via cmd.exe)
  return ["cmd", "/c", "more"]
}

export const SessionCommand = cmd({
  command: "session",
  describe: "manage sessions",
  builder: (yargs: Argv) =>
    yargs
      .command(SessionListCommand)
      .command(SessionDeleteCommand)
      .command(SessionRewindCommand)
      .command(SessionUnrewindCommand)
      .demandCommand(),
  async handler() {},
})

export const SessionDeleteCommand = cmd({
  command: "delete <sessionID>",
  describe: "delete a session",
  builder: (yargs: Argv) => {
    return yargs.positional("sessionID", {
      describe: "session ID to delete",
      type: "string",
      demandOption: true,
    })
  },
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      const sessionID = SessionID.make(args.sessionID)
      try {
        await Session.get(sessionID)
      } catch {
        UI.error(`Session not found: ${args.sessionID}`)
        process.exit(1)
      }
      await Session.remove(sessionID)
      UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Session ${args.sessionID} deleted` + UI.Style.TEXT_NORMAL)
    })
  },
})

export const SessionListCommand = cmd({
  command: "list",
  describe: "list sessions",
  builder: (yargs: Argv) => {
    return yargs
      .option("max-count", {
        alias: "n",
        describe: "limit to N most recent sessions",
        type: "number",
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["table", "json"],
        default: "table",
      })
  },
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      const sessions = [...Session.list({ roots: true, limit: args.maxCount })]

      if (sessions.length === 0) {
        return
      }

      let output: string
      if (args.format === "json") {
        output = formatSessionJSON(sessions)
      } else {
        output = formatSessionTable(sessions)
      }

      const shouldPaginate = process.stdout.isTTY && !args.maxCount && args.format === "table"

      if (shouldPaginate) {
        const proc = Process.spawn(pagerCmd(), {
          stdin: "pipe",
          stdout: "inherit",
          stderr: "inherit",
        })

        if (!proc.stdin) {
          console.log(output)
          return
        }

        proc.stdin.write(output)
        proc.stdin.end()
        await proc.exited
      } else {
        console.log(output)
      }
    })
  },
})

function formatSessionTable(sessions: Session.Info[]): string {
  const lines: string[] = []

  const maxIdWidth = Math.max(20, ...sessions.map((s) => s.id.length))
  const maxTitleWidth = Math.max(25, ...sessions.map((s) => s.title.length))

  const header = `Session ID${" ".repeat(maxIdWidth - 10)}  Title${" ".repeat(maxTitleWidth - 5)}  Updated`
  lines.push(header)
  lines.push("─".repeat(header.length))
  for (const session of sessions) {
    const truncatedTitle = Locale.truncate(session.title, maxTitleWidth)
    // gap-25-followup-1: brief format gives temporal context for
    // session lists (was binary today/other via todayTimeOrDateTime)
    const timeStr = Locale.briefTimestamp(session.time.updated)
    const line = `${session.id.padEnd(maxIdWidth)}  ${truncatedTitle.padEnd(maxTitleWidth)}  ${timeStr}`
    lines.push(line)
  }

  return lines.join(EOL)
}

function formatSessionJSON(sessions: Session.Info[]): string {
  const jsonData = sessions.map((session) => ({
    id: session.id,
    title: session.title,
    updated: session.time.updated,
    created: session.time.created,
    projectId: session.projectID,
    directory: session.directory,
  }))
  return JSON.stringify(jsonData, null, 2)
}

export const SessionRewindCommand = cmd({
  command: "rewind <sessionID> <messageID>",
  describe: "rewind a session to a specific message (truncates messages and restores filesystem snapshot)",
  builder: (yargs: Argv) => {
    return yargs
      .positional("sessionID", {
        describe: "session ID to rewind",
        type: "string",
        demandOption: true,
      })
      .positional("messageID", {
        describe: "message ID to rewind to (this message and prior are kept)",
        type: "string",
        demandOption: true,
      })
      .option("part", {
        describe: "optional part ID within the message for fine-grained rewind",
        type: "string",
      })
  },
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      const sessionID = SessionID.make(args.sessionID)
      try {
        await Session.get(sessionID)
      } catch {
        UI.error(`Session not found: ${args.sessionID}`)
        process.exit(1)
      }
      const messageID = MessageID.make(args.messageID)
      const partID = args.part ? PartID.make(args.part) : undefined
      const result = await SessionRevert.revert({ sessionID, messageID, partID })
      if (!result.revert) {
        UI.error(`Could not rewind: messageID ${args.messageID} not found in session ${args.sessionID}`)
        process.exit(1)
      }
      const summary = result.summary
        ? `${result.summary.additions} additions, ${result.summary.deletions} deletions across ${result.summary.files} file(s)`
        : "no filesystem changes"
      UI.println(
        UI.Style.TEXT_SUCCESS_BOLD +
          `Rewound session ${args.sessionID} to message ${args.messageID} (${summary})` +
          UI.Style.TEXT_NORMAL,
      )
      UI.println(`Use 'opencode session unrewind ${args.sessionID}' to undo.`)
    })
  },
})

export const SessionUnrewindCommand = cmd({
  command: "unrewind <sessionID>",
  describe: "undo a previous rewind on this session (restores messages and filesystem)",
  builder: (yargs: Argv) => {
    return yargs.positional("sessionID", {
      describe: "session ID to unrewind",
      type: "string",
      demandOption: true,
    })
  },
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      const sessionID = SessionID.make(args.sessionID)
      let session
      try {
        session = await Session.get(sessionID)
      } catch {
        UI.error(`Session not found: ${args.sessionID}`)
        process.exit(1)
      }
      if (!session.revert) {
        UI.error(`Session ${args.sessionID} has no active rewind to undo`)
        process.exit(1)
      }
      await SessionRevert.unrevert({ sessionID })
      UI.println(
        UI.Style.TEXT_SUCCESS_BOLD + `Unrewound session ${args.sessionID}` + UI.Style.TEXT_NORMAL,
      )
    })
  },
})
