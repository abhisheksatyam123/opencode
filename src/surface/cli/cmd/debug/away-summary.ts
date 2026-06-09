// debug/away-summary.ts
//
// `opencode debug away-summary <sessionID>` — print the AwaySummary
// recap prompt for a session, OR (with --generate) call the LLM to
// produce the actual 1-3 sentence "while you were away" recap
// (parity gap-31-followup-1).
//
// Brings `AwaySummary` (gap-31) from orphan helper → live debug
// consumer. Same migration-over-orphan pattern as gap-37-followup-1
// (`opencode debug tool-summary`), gap-12-followup-1 (`debug tokens`),
// gap-4-followup-1 (`debug outputs-scanner`).
//
// MODES:
//
//   1. DRY RUN (default): prints the buildPrompt output without
//      calling the LLM. Useful for inspecting the prompt construction
//      + tweaking the helper without burning tokens. No model/agent
//      setup required — just walks the session's recent messages.
//
//   2. --generate: calls AwaySummary.generate() against the session's
//      actual model + agent inferred from the latest assistant message.
//      Slower (full LLM round-trip) and burns tokens.
//
//   3. --json: emits a JSON object with the prompt + (when --generate)
//      the recap, via NdjsonSafe.stringify so the output is jq-pipeable
//      and survives line splitters.
//
//   4. --memory <file>: optional path to a file whose contents become
//      the AwaySummary `currentMemory` argument (the broader-context
//      block prepended to the prompt). Default is no memory.
//
// USE CASES:
//   * inspect AwaySummary's prompt construction during development
//   * "what recap would the model emit when I resume this session?"
//   * generate sample recaps for the TUI session-resume welcome card

import * as fs from "fs/promises"
import { Session } from "@/process/session"
import type { SessionID } from "@/process/session/schema"
import { ProviderID, ModelID } from "@/provider/schema"
import { AwaySummary } from "@/process/session/away-summary"
import { NdjsonSafe } from "@/foundation/util/ndjson-safe"
import { bootstrap } from "@/surface/cli/bootstrap"
import { cmd } from "@/surface/cli/cmd/cmd"

export const AwaySummaryCommand = cmd({
  command: "away-summary <sessionID>",
  describe: "print the AwaySummary recap prompt (or generated text) for a session",
  builder: (yargs) =>
    yargs
      .positional("sessionID", {
        type: "string",
        description: "session id",
        demandOption: true,
      })
      .option("generate", {
        type: "boolean",
        description: "call the LLM to produce a real recap (default: dry-run prompt only)",
        default: false,
      })
      .option("json", {
        type: "boolean",
        description: "emit the result as a single JSON object (jq-able, line-splitter-safe via NdjsonSafe)",
        default: false,
      })
      .option("memory", {
        type: "string",
        description: "path to a file whose contents become the currentMemory context (default: no memory)",
      }),
  async handler(args) {
    await bootstrap(process.cwd(), async () => {
      const sessionID = args.sessionID as SessionID
      const messages = await Session.messages({ sessionID })

      if (messages.length === 0) {
        if (args.json) {
          console.log(NdjsonSafe.stringify({ sessionID, messageCount: 0, prompt: "", recap: null }))
        } else {
          console.log("Session has no messages — nothing to recap.")
        }
        return
      }

      // Optional memory file: when provided, slurp the contents and
      // pass to buildPrompt as the currentMemory argument. The
      // AwaySummary helper expects raw text, not JSON or anything
      // structured.
      let currentMemory: string | null = null
      if (args.memory) {
        try {
          currentMemory = await fs.readFile(args.memory, "utf8")
        } catch (err) {
          console.error(`failed to read memory file ${args.memory}: ${(err as Error).message}`)
          process.exit(1)
        }
      }

      // DRY RUN: build the prompt + print it. No model call, no
      // model/agent inference needed.
      const prompt = AwaySummary.buildPrompt(currentMemory)

      if (!args.generate) {
        if (args.json) {
          console.log(
            NdjsonSafe.stringify({
              sessionID,
              messageCount: messages.length,
              currentMemoryLength: currentMemory?.length ?? 0,
              recentWindow: AwaySummary.RECENT_MESSAGE_WINDOW,
              prompt,
              recap: null,
            }),
          )
          return
        }
        console.log("─── away-summary prompt ───")
        console.log(prompt)
        console.log()
        console.log(
          `(${messages.length} messages in session, last ${AwaySummary.RECENT_MESSAGE_WINDOW} would be sent; pass --generate to actually call the LLM)`,
        )
        return
      }

      // GENERATE: call the LLM. Requires loading the session's model
      // + agent from the latest assistant message.
      let providerID: string | undefined
      let modelID: string | undefined
      let agentName: string | undefined
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]
        if (m.info.role !== "assistant") continue
        const info = m.info as any
        providerID = info.providerID ?? info.modelID?.split("/")?.[0]
        modelID = info.modelID
        agentName = info.agent ?? info.mode
        if (providerID && modelID) break
      }

      if (!providerID || !modelID) {
        console.error(
          "could not infer provider/model from session messages — try --generate after running at least one assistant turn",
        )
        process.exit(1)
      }

      const { Provider } = await import("@/provider/provider")
      const { Agent } = await import("@/agent/agent")
      const model = await Provider.getModel(ProviderID.make(providerID), ModelID.make(modelID))
      const agent = await Agent.get(agentName ?? "explore")

      const recap = await AwaySummary.generate({
        messages,
        model,
        agent,
        sessionID,
        currentMemory,
      })

      if (args.json) {
        console.log(
          NdjsonSafe.stringify({
            sessionID,
            messageCount: messages.length,
            currentMemoryLength: currentMemory?.length ?? 0,
            recentWindow: AwaySummary.RECENT_MESSAGE_WINDOW,
            prompt,
            recap,
          }),
        )
        return
      }
      console.log("─── recap ───")
      console.log(recap ?? "(generation failed or empty)")
    })
  },
})
