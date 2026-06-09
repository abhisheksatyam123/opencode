import { createHash } from "node:crypto"

export namespace TrajectoryRegulator {
  export const DEFAULT_REPEAT_THRESHOLD = 3

  export type ToolResult = {
    title: string
    metadata: Record<string, any>
    output: string
    attachments?: any[]
  }

  export type Config = {
    repeatThreshold?: number
  }

  export type Observation = {
    tool: string
    args: unknown
  }

  export type Intervention = {
    type: "repeated-identical-tool-observation"
    action: "warn" | "block"
    tool: string
    repeatCount: number
    message: string
  }

  export class State {
    readonly #repeatThreshold: number
    #lastFingerprint = ""
    #lastActionFingerprint = ""
    #streak = 0

    constructor(config: Config = {}) {
      this.#repeatThreshold = Math.max(2, Math.floor(config.repeatThreshold ?? DEFAULT_REPEAT_THRESHOLD))
    }

    blockRepeatedCall(input: Observation): Error | undefined {
      if (this.#streak < this.#repeatThreshold) return undefined
      if (actionFingerprintOf(input) !== this.#lastActionFingerprint) return undefined
      const intervention = makeIntervention(input.tool, this.#streak + 1, "block")
      return new Error(intervention.message)
    }

    recordSuccess<T extends ToolResult>(input: Observation & { result: T }): T {
      const intervention = this.#record({ ...input, outcome: "success", observation: input.result.output })
      if (!intervention) return input.result
      return {
        ...input.result,
        output: appendIntervention(input.result.output, intervention.message),
        metadata: {
          ...input.result.metadata,
          trajectoryRegulation: intervention,
        },
      }
    }

    recordFailure(input: Observation & { error: unknown }): Error {
      const original = toError(input.error)
      const intervention = this.#record({ ...input, outcome: "error", observation: original.message })
      if (!intervention) return original
      const error = new Error(appendIntervention(original.message, intervention.message), { cause: original })
      error.name = original.name
      return error
    }

    #record(input: Observation & { outcome: "success" | "error"; observation: string }): Intervention | undefined {
      const fingerprint = fingerprintOf(input)
      this.#lastActionFingerprint = actionFingerprintOf(input)
      if (fingerprint === this.#lastFingerprint) {
        this.#streak++
      } else {
        this.#lastFingerprint = fingerprint
        this.#streak = 1
      }
      if (this.#streak < this.#repeatThreshold) return undefined
      return {
        ...makeIntervention(input.tool, this.#streak, "warn"),
      }
    }
  }

  export function create(config?: Config) {
    return new State(config)
  }

  export function stableStringify(value: unknown): string {
    const seen = new WeakSet<object>()
    return JSON.stringify(normalize(value, seen))
  }

  function normalize(value: unknown, seen: WeakSet<object>): unknown {
    if (value === null || typeof value !== "object") return value
    if (seen.has(value)) return "[Circular]"
    seen.add(value)
    if (Array.isArray(value)) return value.map((item) => normalize(item, seen))
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = normalize((value as Record<string, unknown>)[key], seen)
    }
    return out
  }

  function fingerprintOf(input: Observation & { outcome: "success" | "error"; observation: string }) {
    return hash(
      stableStringify({
        action: actionFingerprintOf(input),
        outcome: input.outcome,
        observation: input.observation,
      }),
    )
  }

  function actionFingerprintOf(input: Observation) {
    return hash(stableStringify({ tool: input.tool, args: input.args }))
  }

  function hash(text: string) {
    return createHash("sha256").update(text).digest("hex")
  }

  function toError(error: unknown): Error {
    if (error instanceof Error) return error
    return new Error(String(error))
  }

  function appendIntervention(text: string, message: string) {
    return `${text.trimEnd()}\n\n${message}`
  }

  function makeIntervention(tool: string, repeatCount: number, action: Intervention["action"]): Intervention {
    return {
      type: "repeated-identical-tool-observation",
      action,
      tool,
      repeatCount,
      message: interventionMessage(tool, repeatCount, action),
    }
  }

  function interventionMessage(tool: string, repeatCount: number, action: Intervention["action"]) {
    const prefix =
      action === "block"
        ? `Trajectory regulation: blocked identical ${tool} call attempt #${repeatCount}.`
        : `Trajectory regulation: this is identical ${tool} result #${repeatCount} in a row.`
    return [
      prefix,
      "Do not repeat the same tool call again.",
      "Change strategy: use different arguments, inspect the prior result already in context, record a blocker, or move to the next actionable step.",
    ].join(" ")
  }
}
