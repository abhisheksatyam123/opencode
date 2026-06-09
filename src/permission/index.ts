import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { makeRuntime } from "@/foundation/effect/run-service"
import type { Brand } from "effect/Brand"
import { Log } from "@/foundation/util/log"
import { Wildcard } from "@/foundation/util/wildcard"
import { Deferred, Effect, Layer, Ref, Schema, ServiceMap } from "effect"
import os from "os"
import z from "zod"
import { evaluate as evalRule } from "@/permission/evaluate"
import { PermissionID } from "@/permission/schema"

export namespace Permission {
  const log = Log.create({ service: "permission" })

  type ProjectID = string & Brand<"ProjectID">
  type SessionID = string & Brand<"SessionID">
  type MessageID = string & Brand<"MessageID">

  const ProjectIDSchema = z.string().pipe(z.custom<ProjectID>())
  const SessionIDSchema = z.string().pipe(z.custom<SessionID>())
  const MessageIDSchema = z.string().pipe(z.custom<MessageID>())

  export const Action = z.enum(["allow", "deny", "ask"]).meta({
    ref: "PermissionAction",
  })
  export type Action = z.infer<typeof Action>

  export const Rule = z
    .object({
      permission: z.string(),
      pattern: z.string(),
      action: Action,
    })
    .meta({
      ref: "PermissionRule",
    })
  export type Rule = z.infer<typeof Rule>

  export const Ruleset = Rule.array().meta({
    ref: "PermissionRuleset",
  })
  export type Ruleset = z.infer<typeof Ruleset>

  export const Mode = z.enum(["default", "plan", "bypass"]).default("default").meta({
    ref: "PermissionMode",
  })
  export type Mode = z.infer<typeof Mode>

  /**
   * Tools that are auto-approved in "plan" mode. Everything else is auto-rejected.
   * Plan mode allows the agent to explore, reason, and manage task notes.
   */
  export const PLAN_MODE_ALLOWED_TOOLS = new Set(["bash", "task"])

  export const Request = z
    .object({
      id: PermissionID.zod,
      sessionID: SessionIDSchema,
      permission: z.string(),
      patterns: z.string().array(),
      metadata: z.record(z.string(), z.any()),
      always: z.string().array(),
      tool: z
        .object({
          messageID: MessageIDSchema,
          callID: z.string(),
        })
        .optional(),
    })
    .meta({
      ref: "PermissionRequest",
    })
  export type Request = z.infer<typeof Request>

  export const Reply = z.enum(["once", "always", "reject"])
  export type Reply = z.infer<typeof Reply>

  export const Approval = z.object({
    projectID: ProjectIDSchema,
    patterns: z.string().array(),
  })

  export const Event = {
    Asked: BusEvent.define("permission.asked", Request),
    Replied: BusEvent.define(
      "permission.replied",
      z.object({
        sessionID: SessionIDSchema,
        requestID: PermissionID.zod,
        reply: Reply,
      }),
    ),
  }

  export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("PermissionRejectedError", {}) {
    override get message() {
      return "The user rejected permission to use this specific tool call."
    }
  }

  export class CorrectedError extends Schema.TaggedErrorClass<CorrectedError>()("PermissionCorrectedError", {
    feedback: Schema.String,
  }) {
    override get message() {
      return `The user rejected permission to use this specific tool call with the following feedback: ${this.feedback}`
    }
  }

  export class DeniedError extends Schema.TaggedErrorClass<DeniedError>()("PermissionDeniedError", {
    ruleset: Schema.Any,
  }) {
    override get message() {
      return `The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules ${JSON.stringify(this.ruleset)}`
    }
  }

  export type Error = DeniedError | RejectedError | CorrectedError

  export const AskInput = Request.partial({ id: true }).extend({
    ruleset: Ruleset,
    mode: Mode.optional(),
  })

  export const ReplyInput = z.object({
    requestID: PermissionID.zod,
    reply: Reply,
    message: z.string().optional(),
  })

  export interface Interface {
    readonly ask: (input: z.infer<typeof AskInput>) => Effect.Effect<void, Error>
    readonly reply: (input: z.infer<typeof ReplyInput>) => Effect.Effect<void>
    readonly list: () => Effect.Effect<Request[]>
    readonly reset: () => Effect.Effect<void>
  }

  export function evaluate(permission: string, pattern: string, ...rulesets: Ruleset[]): Rule {
    log.info("evaluate", { permission, pattern, ruleset: rulesets.flat() })
    return evalRule(permission, pattern, ...rulesets)
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/Permission") {}

  // ── Pending entry ─────────────────────────────────────────────────────────

  interface PendingEntry {
    info: Request
    deferred: Deferred.Deferred<void, Error>
  }

  // ── Layer (requires Bus.Service) ──────────────────────────────────────────

  export const layer: Layer.Layer<Service, never, Bus.Service> = Layer.effect(
    Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service

      // pending: Map<string, PendingEntry> — live requests awaiting reply
      const pendingRef = yield* Ref.make(new Map<string, PendingEntry>())

      // resolved: Map<string, string> — requestID → ISO resolvedAt timestamp
      // Tracks first-reply-wins; second reply is a silent no-op (I2).
      const resolvedRef = yield* Ref.make(new Map<string, string>())

      const ask = (input: z.infer<typeof AskInput>): Effect.Effect<void, Error> =>
        Effect.gen(function* () {
          const mode = input.mode ?? "default"

          // I7: plan mode — auto-reject non-allowed tools without pending entry
          if (mode === "plan" && !PLAN_MODE_ALLOWED_TOOLS.has(input.permission)) {
            return yield* Effect.fail(
              new Permission.DeniedError({
                ruleset: [{ permission: input.permission, pattern: "*", action: "deny" as const }],
              }),
            )
          }

          const patterns = input.patterns.length > 0 ? input.patterns : ["*"]

          // Evaluate against caller-supplied ruleset
          const denied = patterns.some(
            (pattern) => Permission.evaluate(input.permission, pattern, input.ruleset).action === "deny",
          )
          if (denied) {
            return yield* Effect.fail(new Permission.DeniedError({ ruleset: input.ruleset }))
          }

          // Check if all patterns evaluate to "allow" — skip prompting (I3 fast-path)
          const allAllowed = patterns.every(
            (pattern) => Permission.evaluate(input.permission, pattern, input.ruleset).action === "allow",
          )
          if (allAllowed) {
            return
          }

          // Needs user input — create pending entry (P1, I5)
          const id = PermissionID.ascending(input.id ? String(input.id) : undefined)
          const info: Request = {
            id,
            sessionID: input.sessionID,
            permission: input.permission,
            patterns,
            metadata: input.metadata ?? {},
            always: input.always ?? [],
            tool: input.tool,
          }

          const deferred = yield* Deferred.make<void, Error>()

          yield* Ref.update(pendingRef, (m) => {
            const next = new Map(m)
            next.set(String(id), { info, deferred })
            return next
          })

          // P2: publish Event.Asked only for true prompts
          yield* bus.publish(Event.Asked, info)

          // Block until reply resolves or rejects the Deferred
          return yield* Deferred.await(deferred)
        })

      const reply = (input: z.infer<typeof ReplyInput>): Effect.Effect<void> =>
        Effect.gen(function* () {
          const requestIDStr = String(input.requestID)

          // First-reply-wins: second reply is a silent no-op (I2)
          const resolved = yield* Ref.get(resolvedRef)
          if (resolved.has(requestIDStr)) {
            // Already resolved — silent no-op at service level.
            // HTTP layer (routes/permission.ts) handles 409 via its own map.
            return
          }

          const pending = yield* Ref.get(pendingRef)
          const entry = pending.get(requestIDStr)
          if (!entry) {
            // Unknown ID — silent no-op (I2)
            return
          }

          // Record resolution timestamp before async work (atomic claim)
          const resolvedAt = new Date().toISOString()
          yield* Ref.update(resolvedRef, (m) => {
            const next = new Map(m)
            next.set(requestIDStr, resolvedAt)
            return next
          })

          // Remove from pending
          yield* Ref.update(pendingRef, (m) => {
            const next = new Map(m)
            next.delete(requestIDStr)
            return next
          })

          // Publish Event.Replied (P3)
          yield* bus.publish(Event.Replied, {
            sessionID: entry.info.sessionID,
            requestID: input.requestID,
            reply: input.reply,
          })

          // Resolve or reject the Deferred (I1, I6)
          if (input.reply === "reject") {
            const err =
              input.message && input.message.length > 0
                ? new CorrectedError({ feedback: input.message })
                : new RejectedError()
            yield* Deferred.fail(entry.deferred, err)
          } else {
            // "once" or "always" — succeed void
            yield* Deferred.succeed(entry.deferred, undefined)
          }
        })

      const list = (): Effect.Effect<Request[]> =>
        Effect.gen(function* () {
          const pending = yield* Ref.get(pendingRef)
          return Array.from(pending.values()).map((e) => e.info)
        })

      // reset: clear pending + resolved maps — used between test runs to
      // prevent state leaking across instances that share the same layer.
      const reset = (): Effect.Effect<void> =>
        Effect.gen(function* () {
          yield* Ref.set(pendingRef, new Map())
          yield* Ref.set(resolvedRef, new Map())
        })

      return Service.of({ ask, reply, list, reset })
    }),
  )

  function expand(pattern: string): string {
    if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
    if (pattern === "~") return os.homedir()
    if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
    if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
    return pattern
  }

  export function fromConfig(permission: Config.Permission) {
    const ruleset: Ruleset = []
    for (const [key, value] of Object.entries(permission)) {
      if (typeof value === "string") {
        ruleset.push({ permission: key, action: value, pattern: "*" })
        continue
      }
      ruleset.push(
        ...Object.entries(value).map(([pattern, action]) => ({
          permission: key,
          pattern: expand(pattern),
          action,
        })),
      )
    }
    return ruleset
  }

  export function merge(...rulesets: Ruleset[]): Ruleset {
    return rulesets.flat()
  }

  export function disabled(tools: string[], ruleset: Ruleset): Set<string> {
    const result = new Set<string>()
    for (const tool of tools) {
      const rule = ruleset.findLast((rule) => Wildcard.match(tool, rule.permission))
      if (!rule) continue
      if (rule.pattern === "*" && rule.action === "deny") result.add(tool)
    }
    return result
  }

  export const defaultLayer: Layer.Layer<Service> = layer.pipe(Layer.provide(Bus.layer))

  export const { runPromise } = makeRuntime(Service, defaultLayer)

  export async function ask(input: z.infer<typeof AskInput>) {
    return runPromise((s) => s.ask(input))
  }

  export async function reply(input: z.infer<typeof ReplyInput>) {
    return runPromise((s) => s.reply(input))
  }

  export async function list() {
    return runPromise((s) => s.list())
  }

  export async function reset() {
    return runPromise((s) => s.reset())
  }
}
