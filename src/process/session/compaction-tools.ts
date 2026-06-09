import { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { MessageV2 } from "@/process/session/message-v2"
import { Session } from "@/process/session"
import { SessionProcessor } from "@/process/session/processor"
import { PartID } from "@/process/session/schema"
import type { Provider } from "@/provider/provider"
import { ModelID } from "@/provider/schema"
import { ProviderPluginHooks } from "@/provider/plugin-hooks"
import { ProviderTransform } from "@/provider/transform"
import { ToolRegistry } from "@/tool/registry"
import { Tool } from "@/tool/tool"
import { Effect } from "effect"
import { type Tool as AITool, type ToolExecutionOptions, tool as aiTool, jsonSchema } from "ai"
import z from "zod"

export const resolveCompactionTools = Effect.fn("SessionCompaction.resolveTools")(function* (input: {
  agent: Agent.Info
  model: Provider.Model
  session: Session.Info
  processor: Pick<SessionProcessor.Handle, "message" | "partFromToolCall">
  messages: MessageV2.WithParts[]
  sessionService: Session.Interface
  permission: Permission.Interface
  registry: ToolRegistry.Interface
}) {
  const tools: Record<string, AITool> = {}

  const context = (args: any, options: ToolExecutionOptions): Tool.Context => ({
    sessionID: input.session.id,
    abort: options.abortSignal ?? new AbortController().signal,
    messageID: input.processor.message.id,
    callID: options.toolCallId,
    extra: {
      model: input.model,
      bypassAgentCheck: false,
    },
    agent: input.agent.name,
    permissionMode: input.session.permissionMode,
    messages: input.messages,
    metadata: (val) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const match = input.processor.partFromToolCall(options.toolCallId)
          if (!match || !["running", "pending"].includes(match.state.status)) return
          yield* input.sessionService.updatePart({
            ...match,
            state: {
              title: val.title,
              metadata: val.metadata,
              status: "running",
              input: args,
              time: { start: Date.now() },
            },
          })
        }),
      ),
    ask: (req) =>
      Effect.runPromise(
        input.permission.ask({
          ...req,
          sessionID: input.session.id,
          tool: { messageID: input.processor.message.id, callID: options.toolCallId },
          ruleset: Permission.merge(input.agent.permission, input.session.permission ?? []),
          mode: input.session.permissionMode,
        }),
      ),
  })

  for (const item of yield* input.registry.tools(
    { modelID: ModelID.make(input.model.api.id), providerID: input.model.providerID },
    input.agent,
  )) {
    const schema = ProviderTransform.schema(input.model, z.toJSONSchema(item.parameters))
    tools[item.id] = aiTool({
      id: item.id as any,
      description: item.description,
      inputSchema: jsonSchema(schema as any),
      execute(args, options) {
        return Effect.runPromise(
          Effect.gen(function* () {
            const beforeOut: { args: any; deny?: string } = yield* ProviderPluginHooks.triggerEffect(
              "tool.execute.before",
              { tool: item.id, sessionID: input.session.id, callID: options.toolCallId },
              { args, deny: undefined } as { args: any; deny?: string },
            )
            if (beforeOut.deny) {
              throw new Error(`tool execution denied by plugin: ${beforeOut.deny}`)
            }
            const toolArgs = beforeOut.args ?? args
            const ctx = context(toolArgs, options)
            try {
              const result = yield* Effect.promise(() => item.execute(toolArgs, ctx))
              const output = {
                ...result,
                attachments: result.attachments?.map((attachment) => ({
                  ...attachment,
                  id: PartID.ascending(),
                  sessionID: ctx.sessionID,
                  messageID: input.processor.message.id,
                })),
              }
              yield* ProviderPluginHooks.triggerEffect(
                "tool.execute.after",
                { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID, args: toolArgs },
                output,
              )
              return output
            } catch (err) {
              yield* Effect.promise(() =>
                ProviderPluginHooks.notify("tool.execute.failure", {
                  tool: item.id,
                  sessionID: ctx.sessionID,
                  callID: ctx.callID ?? "",
                  args: toolArgs,
                  error: { message: err instanceof Error ? err.message : String(err) },
                }),
              ).pipe(Effect.ignore)
              throw err
            }
          }),
        )
      },
    })
  }

  return tools
})
