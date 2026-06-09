import { NodePath } from "@effect/platform-node"
import { Cause, Duration, Effect, Layer, Schedule, ServiceMap } from "effect"
import path from "path"
import { makeRuntime } from "@/foundation/effect/run-service"
import { AppFileSystem } from "@/filesystem"
import { Identifier } from "@/foundation/id"
import { Log } from "@/foundation/util/log"
import { ToolID } from "@/tool/schema"
import { TRUNCATION_DIR } from "@/tool/truncation-dir"

export namespace Truncate {
  const log = Log.create({ service: "truncation" })
  const RETENTION = Duration.days(7)

  export const MAX_CHARS = 4096
  /** @deprecated Use MAX_CHARS; compatibility alias retained until downstream callers migrate. */
  export const MAX_BYTES = MAX_CHARS
  export const DIR = TRUNCATION_DIR
  export const GLOB = path.join(TRUNCATION_DIR, "*")

  export type Result = { content: string; truncated: false } | { content: string; truncated: true; outputPath: string }

  export interface Options {
    /** @deprecated Use maxChars; compatibility alias treated as character budget until callers migrate. */
    maxBytes?: number
    maxChars?: number
    direction?: "head" | "tail"
  }

  export interface Interface {
    readonly cleanup: () => Effect.Effect<void>
    /**
     * Returns output unchanged when it fits within the character budget, otherwise writes
     * the full text to the truncation directory and returns a 4K prefix plus a spill-file hint.
     */
    readonly output: (
      text: string,
      options?: Options,
      agent?: { permission?: import("@/permission").Permission.Ruleset },
    ) => Effect.Effect<Result>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/Truncate") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* AppFileSystem.Service

      const cleanup = Effect.fn("Truncate.cleanup")(function* () {
        const cutoff = Identifier.timestamp(Identifier.create("tool", false, Date.now() - Duration.toMillis(RETENTION)))
        const entries = yield* fs.readDirectory(TRUNCATION_DIR).pipe(
          Effect.map((all) => all.filter((name) => name.startsWith("tool_"))),
          Effect.catch(() => Effect.succeed([])),
        )
        for (const entry of entries) {
          if (Identifier.timestamp(entry) >= cutoff) continue
          yield* fs.remove(path.join(TRUNCATION_DIR, entry)).pipe(Effect.catch(() => Effect.void))
        }
      })

      const output = Effect.fn("Truncate.output")(function* (
        text: string,
        options: Options = {},
        _agent?: { permission?: import("@/permission").Permission.Ruleset },
      ) {
        const configuredLimit = options.maxChars ?? options.maxBytes ?? MAX_CHARS
        const maxChars =
          Number.isFinite(configuredLimit) && configuredLimit > 0 ? Math.floor(configuredLimit) : MAX_CHARS
        const chars = Array.from(text)
        const totalChars = chars.length

        if (totalChars <= maxChars) {
          return { content: text, truncated: false } as const
        }

        const file = path.join(TRUNCATION_DIR, ToolID.ascending())

        yield* fs.ensureDir(TRUNCATION_DIR).pipe(Effect.orDie)
        yield* fs.writeFileString(file, text).pipe(Effect.orDie)

        const prefix = chars.slice(0, maxChars).join("")

        return {
          content:
            `${prefix}\n\n` +
            `[Output truncated at ${maxChars} characters (total ${totalChars}). Full output saved to ${file}]\n` +
            `Inspect the saved output with targeted range reads (for example: nl -ba ${file} | sed -n '<start>,<end>p') or a one-pass rg/python summarizer; avoid raw full-file dumps. ` +
            `If you truly need more inline text, request the smallest useful output budget (for bash, max_output_chars); large values can bloat context.`,
          truncated: true,
          outputPath: file,
        } as const
      })

      yield* cleanup().pipe(
        Effect.catchCause((cause) => {
          log.error("truncation cleanup failed", { cause: Cause.pretty(cause) })
          return Effect.void
        }),
        Effect.repeat(Schedule.spaced(Duration.hours(1))),
        Effect.delay(Duration.minutes(1)),
        Effect.forkScoped,
      )

      return Service.of({ cleanup, output })
    }),
  )

  export const defaultLayer = layer.pipe(Layer.provide(AppFileSystem.defaultLayer), Layer.provide(NodePath.layer))

  const { runPromise } = makeRuntime(Service, defaultLayer)

  export async function output(
    text: string,
    options: Options = {},
    agent?: { permission: import("@/permission").Permission.Ruleset },
  ): Promise<Result> {
    return runPromise((s) => s.output(text, options, agent))
  }
}
