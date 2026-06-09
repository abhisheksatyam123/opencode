// debug/tool-summary.ts
//
// `opencode debug tool-summary <sessionID>` — print the
// ToolUseSummary buildPrompt output for the most recent assistant
// turn in a session, OR (with --generate) call the LLM to produce
// the actual git-commit-subject-style label (parity gap-37-followup-1).
//
// Brings `ToolUseSummary` (gap-37) from orphan helper → live
// debug consumer. Same migration-over-orphan pattern as
// gap-12-followup-1 (`opencode debug tokens`) and gap-4-followup-1
// (`opencode debug outputs-scanner`).
//
// MODES:
//
//   1. DRY RUN (default): prints the SYSTEM_PROMPT + buildPrompt
//      output without calling the LLM. Useful for inspecting what
//      the model would see + tweaking the helper without burning
//      tokens. No model/agent setup required.
//
//   2. --generate: calls ToolUseSummary.generate() against the
//      session's model + agent. Burns tokens but produces the real
//      label. Slower (full LLM round-trip).
//
//   3. --json: emits a JSON object with the prompt + (when
//      --generate) the label, via NdjsonSafe.stringify so the
//      output is jq-pipeable AND safe across line splitters.
//
// Use cases:
//   * inspect ToolUseSummary's prompt construction during development
//   * "what label would the model emit for this batch?" — quick
//     dry-run check before wiring into the live processor
//   * generate sample labels for the TUI sidebar feature design

import { Session } from "@/process/session"
import type { SessionID } from "@/process/session/schema"
import { ProviderID, ModelID } from "@/provider/schema"
import { ToolUseSummary } from "@/process/session/tool-use-summary"
import { NdjsonSafe } from "@/foundation/util/ndjson-safe"
import { bootstrap } from "@/surface/cli/bootstrap"
import { cmd } from "@/surface/cli/cmd/cmd"

export const ToolSummaryCommand = cmd({
  command: "tool-summary <sessionID>",
  describe: "print the ToolUseSummary prompt (or generated label) for a session's most recent assistant turn",
  builder: (yargs) =>
    yargs
      .positional("sessionID", {
        type: "string",
        description: "session id",
        demandOption: true,
      })
      .option("generate", {
        type: "boolean",
        description: "call the LLM to produce a real label (default: dry-run prompt only)",
        default: false,
      })
      .option("json", {
        type: "boolean",
        description: "emit the result as a single JSON object (jq-able, line-splitter-safe via NdjsonSafe)",
        default: false,
      }),
  async handler(args) {
    await bootstrap(process.cwd(), async () => {
      const sessionID = args.sessionID as SessionID
      const messages = await Session.messages({ sessionID })

      // Find the LATEST assistant message with completed tool calls.
      // Walking from the end is the cheap way to grab "the most
      // recent batch" without paging.
      const completedTools: ToolUseSummary.ToolInfo[] = []
      let lastAssistantText: string | undefined
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]
        if (m.info.role !== "assistant") continue
        // Collect every completed tool part on this assistant message.
        for (const part of m.parts) {
          if (part.type === "tool" && part.state.status === "completed") {
            completedTools.push({
              name: part.tool,
              input: part.state.input,
              output: part.state.output,
            })
          }
          if (part.type === "text") lastAssistantText = part.text
        }
        if (completedTools.length > 0) break
      }

      if (completedTools.length === 0) {
        if (args.json) {
          console.log(NdjsonSafe.stringify({ sessionID, toolCount: 0, prompt: "", label: null }))
        } else {
          console.log("No completed tool calls found in the session's most recent assistant turn.")
        }
        return
      }

      // DRY RUN: build the prompt + print it. No model call.
      const prompt = ToolUseSummary.buildPrompt({
        tools: completedTools,
        lastAssistantText,
      })

      if (!args.generate) {
        if (args.json) {
          console.log(
            NdjsonSafe.stringify({
              sessionID,
              toolCount: completedTools.length,
              systemPrompt: ToolUseSummary.SYSTEM_PROMPT,
              prompt,
              label: null,
            }),
          )
          return
        }
        console.log("─── system prompt ───")
        console.log(ToolUseSummary.SYSTEM_PROMPT)
        console.log()
        console.log("─── user prompt ───")
        console.log(prompt)
        console.log()
        console.log(`(${completedTools.length} tool calls; pass --generate to actually call the LLM)`)
        return
      }

      // GENERATE: call the LLM. Requires loading the session's
      // model + agent so this is the slow path.
      //
      // We need a real Provider.Model + Agent.Info pair. The session
      // already has these baked into its assistant messages — pull
      // them from the latest assistant message that completed tools.
      // If we can't find one, abort with a helpful message.
      const sessionInfo = await Session.get(sessionID)
      if (!sessionInfo) {
        console.error(`session ${sessionID} not found`)
        process.exit(1)
      }

      // Pull provider + model + agent name from the latest assistant
      // message. Most messages carry these fields directly.
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

      // Load the actual model + agent via the lazy services. We do
      // this here (inside the handler, after bootstrap) so the dry
      // run path doesn't need any of this machinery.
      const { Provider } = await import("@/provider/provider")
      const { Agent } = await import("@/agent/agent")
      const model = await Provider.getModel(ProviderID.make(providerID), ModelID.make(modelID))
      const agent = await Agent.get(agentName ?? "explore")

      const label = await ToolUseSummary.generate({
        tools: completedTools,
        model,
        agent,
        sessionID,
        lastAssistantText,
      })

      if (args.json) {
        console.log(
          NdjsonSafe.stringify({
            sessionID,
            toolCount: completedTools.length,
            systemPrompt: ToolUseSummary.SYSTEM_PROMPT,
            prompt,
            label,
          }),
        )
        return
      }
      console.log("─── label ───")
      console.log(label ?? "(generation failed or empty)")
    })
  },
})
