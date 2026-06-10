import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/foundation/effect/instance-state"
import { makeRuntime } from "@/foundation/effect/run-service"
import { SessionID, MessageID } from "@/foundation/identifier/session"
import { Effect, Layer, ServiceMap } from "effect"
import z from "zod"
import { Config } from "@/config/config"
import { Log } from "@/foundation/util/log"
import { notesRoot } from "@/notes/root"
import PROMPT_INITIALIZE from "./template/initialize.txt"
import PROMPT_REVIEW from "./template/review.txt"
import PROMPT_SECURITY_REVIEW from "./template/security-review.txt"
import PROMPT_SKILL from "./template/skill.txt"
import PROMPT_ARCHITECTURE from "./template/architecture.txt"
import PROMPT_MODULE from "./template/module.txt"
export * from "./contract/port"

export namespace Command {
  const log = Log.create({ service: "command" })

  type State = {
    commands: Record<string, Info>
  }

  export const Event = {
    Executed: BusEvent.define(
      "command.executed",
      z.object({
        name: z.string(),
        sessionID: SessionID.zod,
        arguments: z.string(),
        messageID: MessageID.zod,
      }),
    ),
  }

  export const Info = z
    .object({
      name: z.string(),
      description: z.string().optional(),
      agent: z.string().optional(),
      model: z.string().optional(),
      source: z.enum(["command", "skill"]).optional(),
      // workaround for zod not supporting async functions natively so we use getters
      // https://zod.dev/v4/changelog?id=zfunction
      template: z.promise(z.string()).or(z.string()),
      subtask: z.boolean().optional(),
      hints: z.array(z.string()),
    })
    .meta({
      ref: "Command",
    })

  // for some reason zod is inferring `string` for z.promise(z.string()).or(z.string()) so we have to manually override it
  export type Info = Omit<z.infer<typeof Info>, "template"> & { template: Promise<string> | string }

  export function hints(template: string) {
    const result: string[] = []
    const numbered = template.match(/\$\d+/g)
    if (numbered) {
      for (const match of [...new Set(numbered)].sort()) result.push(match)
    }
    if (template.includes("$ARGUMENTS")) result.push("$ARGUMENTS")
    return result
  }

  export const Default = {
    INIT: "init",
    REVIEW: "review",
    SECURITY_REVIEW: "security-review",
    SKILL: "skill",
    ARCHITECTURE: "architecture",
    MODULE: "module",
  } as const

  export interface Interface {
    readonly get: (name: string) => Effect.Effect<Info | undefined>
    readonly list: () => Effect.Effect<Info[]>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/Command") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const config = yield* Config.Service

      const init = Effect.fn("Command.state")(function* (ctx) {
        const cfg = yield* config.get()
        const resolvedNotesRoot = cfg.notes?.root?.trim() || notesRoot()
        const commands: Record<string, Info> = {}
        const withRoots = (template: string) =>
          template.replaceAll("${path}", ctx.worktree).replaceAll("${notesRoot}", resolvedNotesRoot)

        commands[Default.INIT] = {
          name: Default.INIT,
          description: "guided notes setup",
          source: "command",
          get template() {
            return withRoots(PROMPT_INITIALIZE)
          },
          hints: hints(PROMPT_INITIALIZE),
        }
        commands[Default.REVIEW] = {
          name: Default.REVIEW,
          description: "review changes [commit|branch|pr], defaults to uncommitted",
          source: "command",
          get template() {
            return withRoots(PROMPT_REVIEW)
          },
          subtask: true,
          hints: hints(PROMPT_REVIEW),
        }
        commands[Default.SECURITY_REVIEW] = {
          name: Default.SECURITY_REVIEW,
          description: "security review of pending changes [commit|branch|pr], defaults to branch diff",
          source: "command",
          get template() {
            return withRoots(PROMPT_SECURITY_REVIEW)
          },
          subtask: true,
          hints: hints(PROMPT_SECURITY_REVIEW),
        }
        commands[Default.SKILL] = {
          name: Default.SKILL,
          description: "load focused skill notes from vault",
          source: "command",
          get template() {
            return withRoots(PROMPT_SKILL)
          },
          hints: hints(PROMPT_SKILL),
        }
        commands[Default.ARCHITECTURE] = {
          name: Default.ARCHITECTURE,
          description: "load focused architecture notes from vault",
          source: "command",
          get template() {
            return withRoots(PROMPT_ARCHITECTURE)
          },
          hints: hints(PROMPT_ARCHITECTURE),
        }
        commands[Default.MODULE] = {
          name: Default.MODULE,
          description: "load focused module notes from vault",
          source: "command",
          get template() {
            return withRoots(PROMPT_MODULE)
          },
          hints: hints(PROMPT_MODULE),
        }

        for (const [name, command] of Object.entries(cfg.command ?? {})) {
          commands[name] = {
            name,
            agent: command.agent,
            model: command.model,
            description: command.description,
            source: "command",
            get template() {
              return command.template
            },
            subtask: command.subtask,
            hints: hints(command.template),
          }
        }

        return {
          commands,
        }
      })

      const state = yield* InstanceState.make<State>((ctx) => init(ctx))

      const get = Effect.fn("Command.get")(function* (name: string) {
        const s = yield* InstanceState.get(state)
        return s.commands[name]
      })

      const list = Effect.fn("Command.list")(function* () {
        const s = yield* InstanceState.get(state)
        return Object.values(s.commands)
      })

      return Service.of({ get, list })
    }),
  )

  export const defaultLayer = layer.pipe(Layer.provide(Config.defaultLayer))

  const { runPromise } = makeRuntime(Service, defaultLayer)

  export async function list() {
    return runPromise((svc) => svc.list())
  }
}
