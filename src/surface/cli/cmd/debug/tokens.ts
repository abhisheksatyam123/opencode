// debug/tokens.ts
//
// `opencode debug tokens <sessionID>` — print per-tool token
// attribution for an existing session (parity gap-12-followup-1).
//
// Brings `TokenAttribution.analyze` (gap-12) from orphan → live
// consumer. The analyzer is a pure function over MessageV2.WithParts[]
// and the table format is line-oriented for grep-ability, so this
// command works by calling `Session.messages` to load the message
// history, passing it through `TokenAttribution.analyze`, and
// printing the formatted table to stdout.
//
// Use cases:
//   * "which tools ate the most context on my long session?"
//   * compaction guidance: "which tools should be pruned first?"
//   * debugging unexpected token spend: a single bash output
//     contributing 60% of the bill is easy to spot here
//
// Example:
//   $ opencode debug tokens ses_01k...
//   tool        calls    in_tok   out_tok   total
//   bash            7      1240     85432   86672
//   read           12      4810      6210   11020
//   grep            5       820      3120    3940
//   ─────────────────────────────────────────────
//   total          24      6870     94762  101632

import { Session } from "@/process/session"
import type { SessionID } from "@/process/session/schema"
import { TokenAttribution } from "@/process/session/token-attribution"
import { NdjsonSafe } from "@/foundation/util/ndjson-safe"
import { bootstrap } from "@/surface/cli/bootstrap"
import { cmd } from "@/surface/cli/cmd/cmd"

export const TokensCommand = cmd({
  command: "tokens <sessionID>",
  describe: "show per-tool token attribution for a session",
  builder: (yargs) =>
    yargs
      .positional("sessionID", {
        type: "string",
        description: "session id",
        demandOption: true,
      })
      .option("top", {
        type: "number",
        description: "show only top N tools by total tokens",
        alias: "n",
      })
      .option("json", {
        type: "boolean",
        description: "emit the breakdown as a single JSON object (jq-able, line-splitter-safe via NdjsonSafe)",
        default: false,
      }),
  async handler(args) {
    await bootstrap(process.cwd(), async () => {
      const messages = await Session.messages({ sessionID: args.sessionID as SessionID })
      const breakdown = TokenAttribution.analyze(messages)
      // gap-12/4/24-followup-2: --json output via NdjsonSafe so the
      // serialized output is pipe-friendly AND survives line-splitting
      // receivers (jq, awk -F'\n', etc.).
      if (args.json) {
        const payload = args.top !== undefined ? { ...breakdown, tools: breakdown.tools.slice(0, args.top) } : breakdown
        console.log(NdjsonSafe.stringify(payload))
        return
      }
      if (breakdown.tools.length === 0) {
        console.log("No tool calls found in this session.")
        return
      }
      const text = TokenAttribution.format(breakdown, args.top !== undefined ? { topN: args.top } : {})
      console.log(text)
    })
  },
})
