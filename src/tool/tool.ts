import z from "zod"
import { Effect } from "effect"
import type { Permission } from "@/permission"
import type { SessionID, MessageID } from "@/foundation/identifier/session"
import { Truncate } from "@/tool/truncate"
import { type PermissionMode } from "@/config/types"

export namespace Tool {
  interface Metadata {
    [key: string]: any
  }

  export interface InitContext {
    agent?: {
      permission: Permission.Ruleset
      mode?: "subagent" | "primary" | "all"
      tier?: "0" | "1" | "2"
      name?: string
    }
  }

  export type Context<M extends Metadata = Metadata> = {
    sessionID: SessionID
    messageID: MessageID
    agent: string
    permissionMode?: PermissionMode
    abort: AbortSignal
    callID?: string
    /**
     * When set, this tool is an alias for the tool with this id.
     * Used by the registry to route permission checks through the canonical tool name.
     */
    canonicalId?: string
    extra?: { [key: string]: any }
    messages: any[]
    metadata(input: { title?: string; metadata?: M }): void
    ask(input: Omit<Permission.Request, "id" | "sessionID" | "tool">): Promise<void>
  }
  export interface Def<Parameters extends z.ZodType = z.ZodType, M extends Metadata = Metadata> {
    description: string
    parameters: Parameters
    /**
     * Whether this tool is safe to execute in parallel with sibling
     * concurrent-safe tools. When omitted or `false`, the tool runs in
     * exclusive mode (default-deny — the safe assumption for any tool
     * that might mutate state).
     *
     * Forms:
     *   - `true` / `false` — fixed answer regardless of input
     *   - `(args) => boolean` — dynamic decision based on the parsed
     *     args (e.g. two reads on different files can run in parallel,
     *     but two reads on the same file create a redundant call)
     *
     * The annotation is consumed by `tool/concurrency.ts` which exposes
     * `Concurrency.isSafe(toolID, args)` for the dispatch layer to
     * decide whether tools can group into a parallel batch. The actual
     * parallel-dispatch wiring is a follow-up; adding the annotation
     * now lets tools declare the property so the wiring can land
     * without retroactively updating every tool.
     *
     * Concept ported from
     * `instructkr-claude-code/src/services/tools/StreamingToolExecutor.ts`
     * (`TrackedTool.isConcurrencySafe`); the implementation is
     * opencode-shaped (declared on Tool.Def, not on a runtime
     * TrackedTool wrapper).
     */
    concurrencySafe?: boolean | ((args: z.infer<Parameters>) => boolean)
    execute(
      args: z.infer<Parameters>,
      ctx: Context,
    ): Promise<{
      title: string
      metadata: M
      output: string
      attachments?: any[]
    }>
    formatValidationError?(error: z.ZodError): string
  }

  export interface Info<Parameters extends z.ZodType = z.ZodType, M extends Metadata = Metadata> {
    id: string
    canonicalId?: string
    init: (ctx?: InitContext) => Promise<Def<Parameters, M>>
  }

  export type InferParameters<T> =
    T extends Info<infer P, any>
      ? z.infer<P>
      : T extends Effect.Effect<Info<infer P, any>, any, any>
        ? z.infer<P>
        : never
  export type InferMetadata<T> =
    T extends Info<any, infer M> ? M : T extends Effect.Effect<Info<any, infer M>, any, any> ? M : never

  function wrap<Parameters extends z.ZodType, Result extends Metadata>(
    id: string,
    init: ((ctx?: InitContext) => Promise<Def<Parameters, Result>>) | Def<Parameters, Result>,
  ) {
    return async (initCtx?: InitContext) => {
      const toolInfo = init instanceof Function ? await init(initCtx) : { ...init }
      const execute = toolInfo.execute
      toolInfo.execute = async (args, ctx) => {
        let parsed: z.infer<Parameters>
        try {
          parsed = toolInfo.parameters.parse(args)
        } catch (error) {
          if (error instanceof z.ZodError && toolInfo.formatValidationError) {
            throw new Error(toolInfo.formatValidationError(error), { cause: error })
          }
          throw new Error(
            `The ${id} tool was called with invalid arguments: ${error}.
Please rewrite the input so it satisfies the expected schema.`,
            { cause: error },
          )
        }
        const result = await execute(parsed, ctx)
        if (result.metadata.truncated !== undefined) {
          return result
        }
        const truncated = await Truncate.output(result.output, {}, initCtx?.agent)
        return {
          ...result,
          output: truncated.content,
          metadata: {
            ...result.metadata,
            truncated: truncated.truncated,
            ...(truncated.truncated && { outputPath: truncated.outputPath }),
          },
        }
      }
      return toolInfo
    }
  }

  export function define<Parameters extends z.ZodType, Result extends Metadata>(
    id: string,
    init: ((ctx?: InitContext) => Promise<Def<Parameters, Result>>) | Def<Parameters, Result>,
  ): Info<Parameters, Result> {
    return {
      id,
      init: wrap(id, init),
    }
  }

  export function defineEffect<Parameters extends z.ZodType, Result extends Metadata, R>(
    id: string,
    init: Effect.Effect<((ctx?: InitContext) => Promise<Def<Parameters, Result>>) | Def<Parameters, Result>, never, R>,
  ): Effect.Effect<Info<Parameters, Result>, never, R> {
    return Effect.map(init, (next) => ({ id, init: wrap(id, next) }))
  }
}
