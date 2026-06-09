// debug/events.ts
//
// `opencode debug events [--tail N] [--duration ms] [--filter regex]`
// — subscribe to the Bus event stream, buffer the most-recent N
// events into a CircularBuffer, print on Ctrl-C or duration
// timeout (parity gap-24-followup-1).
//
// Brings `CircularBuffer` (gap-24) from orphan → live consumer.
// The ring-buffer pattern is exactly right here: callers want a
// SLIDING WINDOW of the last N events, not the FIRST N (which would
// be useless for "what just happened?" debugging) and not the FULL
// log (which would grow unboundedly during long debug sessions).
//
// Use cases:
//   * "what events fired during the last 30 seconds?" — default
//     mode (--duration 30000) collects everything and prints on
//     timeout
//   * "show me the last 50 events when I press Ctrl-C" — pair
//     --duration 0 (no timeout) with a tail size and SIGINT
//   * "show me only file.watcher events" — --filter "file.watcher"
//   * Debugging Bus event payload shapes during plugin development
//
// Example:
//   $ opencode debug events --tail 20 --duration 5000
//   ... 5 seconds later ...
//   [2026-04-08T12:34:56.789Z] file.watcher.updated { file: "/foo", event: "change" }
//   [2026-04-08T12:34:56.812Z] session.message.created { ... }
//   ... 18 more ...
//   (printed last 20 of 47 events captured in 5000ms)

import { Bus } from "@/bus"
import { CircularBuffer } from "@/foundation/util/circular-buffer"
import { NdjsonSafe } from "@/foundation/util/ndjson-safe"
import { Sleep } from "@/foundation/util/sleep"
import { bootstrap } from "@/surface/cli/bootstrap"
import { cmd } from "@/surface/cli/cmd/cmd"

const DEFAULT_TAIL = 100
const DEFAULT_DURATION_MS = 30_000

type CapturedEvent = {
  /** ISO timestamp when the event was captured. */
  ts: string
  /** Bus event type (e.g. "file.watcher.updated"). */
  type: string
  /** The event payload's `properties` field, JSON-stringified. */
  properties: string
}

export const EventsCommand = cmd({
  command: "events",
  describe: "subscribe to the Bus event stream and print the most-recent N events",
  builder: (yargs) =>
    yargs
      .option("tail", {
        type: "number",
        description: "ring-buffer size — keep only the last N events",
        default: DEFAULT_TAIL,
        alias: "n",
      })
      .option("duration", {
        type: "number",
        description: "auto-stop after this many milliseconds (0 = run until Ctrl-C)",
        default: DEFAULT_DURATION_MS,
      })
      .option("filter", {
        type: "string",
        description: "only capture events whose type matches this regex",
        alias: "f",
      })
      .option("json", {
        type: "boolean",
        description: "emit captured events as a JSON object via NdjsonSafe (jq-able, line-splitter-safe)",
        default: false,
      }),
  async handler(args) {
    await bootstrap(process.cwd(), async () => {
      const buffer = new CircularBuffer<CapturedEvent>(args.tail)
      const filter = args.filter ? new RegExp(args.filter) : undefined
      let totalCaptured = 0

      const unsub = Bus.subscribeAll((event: { type?: string; properties?: unknown }) => {
        if (!event?.type) return
        if (filter && !filter.test(event.type)) return
        totalCaptured += 1
        buffer.add({
          ts: new Date().toISOString(),
          type: event.type,
          properties: safeStringify(event.properties),
        })
      })

      const printAndExit = () => {
        unsub()
        const captured = buffer.toArray()
        // gap-12/4/24-followup-2: --json output via NdjsonSafe so the
        // serialized output is jq-able AND line-splitter-safe (event
        // payloads can contain U+2028/U+2029 in tool outputs).
        if (args.json) {
          const payload = {
            duration: args.duration,
            tail: args.tail,
            filter: args.filter ?? null,
            totalCaptured,
            printed: captured.length,
            events: captured,
          }
          console.log(NdjsonSafe.stringify(payload))
          return
        }
        for (const ev of captured) {
          console.log(`[${ev.ts}] ${ev.type} ${ev.properties}`)
        }
        const range =
          totalCaptured > captured.length
            ? `(printed last ${captured.length} of ${totalCaptured} events`
            : `(printed all ${captured.length} events`
        const elapsed = args.duration > 0 ? ` captured in ${args.duration}ms` : " captured"
        console.log(`${range}${elapsed})`)
      }

      // Ctrl-C immediate flush
      const onSigint = () => {
        printAndExit()
        process.exit(0)
      }
      process.once("SIGINT", onSigint)

      // Auto-stop after duration (unless duration === 0)
      if (args.duration > 0) {
        // gap-26-followup-2: Sleep.until is the centralized helper.
        // No signal here because the SIGINT handler short-circuits via
        // process.exit before this resolves.
        await Sleep.until(args.duration)
        process.removeListener("SIGINT", onSigint)
        printAndExit()
      } else {
        // Wait forever — only Ctrl-C exits
        await new Promise<void>(() => {})
      }
    })
  },
})

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return "<unserializable>"
  }
}
