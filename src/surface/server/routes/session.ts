import { Hono } from "hono"
import { stream } from "hono/streaming"
import { describeRoute, validator, resolver } from "hono-openapi"
import { SessionID, MessageID, PartID } from "@/process/session/schema"
import { Config } from "@/config/config"
import { getCompactionTriggerTokens } from "@/process/session/overflow"
import { addTokens, contextWindowStats, normalizeTokens, promptTokenTotal, numeric, tokenTotal } from "@/process/session/stats"
import z from "zod"
import { Session } from "@/process/session"
import { MessageV2 } from "@/process/session/message-v2"
import { SessionPrompt } from "@/process/session/prompt"
import { SessionCompaction } from "@/process/session/compaction"
import { SessionRevert } from "@/process/session/revert"
import { SessionStatus } from "@/process/session/status"
import { SessionSummary } from "@/process/session/summary"
import { SystemPrompt } from "@/process/session/system"
import { TokenAttribution } from "@/process/session/token-attribution"
import { Agent } from "@/agent/agent"
import { Snapshot } from "@/storage/snapshot"
import { Log } from "@/foundation/util/log"
import { ModelID, ProviderID } from "@/provider/schema"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { errors } from "@/surface/server/error"
import { semanticNumber } from "@/foundation/util/semantic-number"
import { NdjsonSafe } from "@/foundation/util/ndjson-safe"
import { Bus } from "@/bus"
import { NamedError } from "@opencode-ai/util/error"
// gap-error-followup-1: errorMessage centralizes the
// `err instanceof Error ? err.message : String(err)` boilerplate.
import { errorMessage } from "@/foundation/util/error"
import { Token } from "@/foundation/util/token"
import { appendRoutedTodoAgentComments, parseTodoAgentTasks } from "@/process/session/todo-agent-protocol"
import { TodoAgentRunner } from "@/process/session/todo-agent-runner"
import { TodoAgentRegistry } from "@/process/session/todo-agent-registry"
import { TodoFile } from "@/process/session/todo-file"
import { TodoFilePatch } from "@/process/session/todo-file-patch"

const log = Log.create({ service: "server" })

const TokenCounts = z.object({
  input: z.number(),
  output: z.number(),
  reasoning: z.number(),
  cache: z.object({
    read: z.number(),
    write: z.number(),
  }),
})

const AgentTokenStats = z.object({
  sessionID: SessionID.zod,
  title: z.string(),
  providerID: z.string(),
  modelID: z.string(),
  tokens: TokenCounts,
  cost: z.number(),
  contextLimit: z.number().optional(),
  contextUsagePct: z.number().optional(),
  messageCount: z.number(),
  isRoot: z.boolean(),
})

const TurnStats = z.object({
  userMessageID: MessageID.zod,
  turnIndex: z.number(),
  tokens: TokenCounts,
  cost: z.number(),
  createdAt: z.number(),
})

const ContextComponentStats = z.object({
  name: z.string(),
  tokens: z.number(),
  pct: z.number(),
  detail: z.string().optional(),
})

const ContextToolStats = z.object({
  name: z.string(),
  calls: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
})

const ContextWindowStats = z.object({
  providerID: z.string().optional(),
  modelID: z.string().optional(),
  modelName: z.string().optional(),
  hardLimit: z.number().optional(),
  inputLimit: z.number().optional(),
  outputReserve: z.number().optional(),
  softLimit: z.number().optional(),
  used: z.number(),
  availableHard: z.number().optional(),
  availableInput: z.number().optional(),
  availableSoft: z.number().optional(),
  usedPctHard: z.number().optional(),
  usedPctInput: z.number().optional(),
  usedPctSoft: z.number().optional(),
  estimatedTotal: z.number(),
  components: ContextComponentStats.array(),
  tools: ContextToolStats.array(),
  callCount: z.number(),
  avgCallTokens: z.number(),
  totalToolCalls: z.number(),
  totalToolCallTokens: z.number(),
  avgToolCallsPerLLM: z.number(),
  maxToolCallsPerLLM: z.number(),
})

const LLMCallStats = z.object({
  messageID: MessageID.zod,
  turnIndex: z.number(),
  providerID: z.string(),
  modelID: z.string(),
  tokens: TokenCounts,
  sentTokens: z.number(),
  receivedTokens: z.number(),
  toolCalls: z.number(),
  cost: z.number(),
  createdAt: z.number(),
})

const SessionTokenStats = z.object({
  sessionID: SessionID.zod,
  agents: AgentTokenStats.array(),
  aggregate: z.object({
    tokens: TokenCounts,
    cost: z.number(),
    agentCount: z.number(),
    messageCount: z.number(),
  }),
  timeline: TurnStats.array(),
  llmCalls: LLMCallStats.array(),
  context: ContextWindowStats,
})

function emptyTokens() {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: {
      read: 0,
      write: 0,
    },
  }
}

export const SessionRoutes = (_serverPermissionMode?: "default" | "plan" | "bypass") =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List sessions",
        description: "Get a list of all OpenCode sessions, sorted by most recently updated.",
        operationId: "session.list",
        responses: {
          200: {
            description: "List of sessions",
            content: {
              "application/json": {
                schema: resolver(Session.Info.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          directory: z.string().optional().meta({ description: "Filter sessions by project directory" }),
          roots: z.coerce.boolean().optional().meta({ description: "Only return root sessions (no parentID)" }),
          start: semanticNumber(z.number().optional()).meta({
            description: "Filter sessions updated on or after this timestamp (milliseconds since epoch)",
          }),
          search: z.string().optional().meta({ description: "Filter sessions by title (case-insensitive)" }),
          limit: semanticNumber(z.number().optional()).meta({
            description: "Maximum number of sessions to return",
          }),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        const sessions: Session.Info[] = []
        for await (const session of Session.list({
          directory: query.directory,
          roots: query.roots,
          start: query.start,
          search: query.search,
          limit: query.limit,
        })) {
          sessions.push(session)
        }
        return c.json(sessions)
      },
    )
    .get(
      "/status",
      describeRoute({
        summary: "Get session status",
        description: "Retrieve the current status of all sessions, including active, idle, and completed states.",
        operationId: "session.status",
        responses: {
          200: {
            description: "Get session status",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), SessionStatus.Info)),
              },
            },
          },
          ...errors(400),
        },
      }),
      async (c) => {
        const result = await SessionStatus.list()
        return c.json(Object.fromEntries(result))
      },
    )
    .get(
      "/:sessionID",
      describeRoute({
        summary: "Get session",
        description: "Retrieve detailed information about a specific OpenCode session.",
        tags: ["Session"],
        operationId: "session.get",
        responses: {
          200: {
            description: "Get session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: Session.get.schema,
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        log.info("SEARCH", { url: c.req.url })
        const session = await Session.get(sessionID)
        return c.json(session)
      },
    )
    .get(
      "/:sessionID/children",
      describeRoute({
        summary: "Get session children",
        tags: ["Session"],
        description: "Retrieve all child sessions that were forked from the specified parent session.",
        operationId: "session.children",
        responses: {
          200: {
            description: "List of children",
            content: {
              "application/json": {
                schema: resolver(Session.Info.array()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: Session.children.schema,
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const session = await Session.children(sessionID)
        return c.json(session)
      },
    )
    .get(
      "/:sessionID/stats",
      describeRoute({
        summary: "Get session token stats",
        tags: ["Session"],
        description: "Token, context, and tool-call stats for the current session.",
        operationId: "session.stats",
        responses: {
          200: {
            description: "Session token stats",
            content: {
              "application/json": {
                schema: resolver(SessionTokenStats),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const root = await Session.get(sessionID)
        const providers = await Provider.list()
        const sessions = [root]

        const messagesBySession = new Map<string, Awaited<ReturnType<typeof Session.messages>>>()
        for (const info of sessions) {
          messagesBySession.set(info.id, await Session.messages({ sessionID: info.id }))
        }

        const agents = sessions
          .map((info) => {
            const messages = messagesBySession.get(info.id) ?? []
            const assistants = messages
              .map((msg) => msg.info)
              .filter((msg): msg is MessageV2.Assistant => msg.role === "assistant")
            const tokens = emptyTokens()
            let cost = 0
            for (const message of assistants) {
              addTokens(tokens, normalizeTokens(message.tokens))
              cost += numeric(message.cost)
            }

            const latestAssistant = assistants.toSorted((a, b) => b.time.created - a.time.created)[0]
            const providerID = latestAssistant?.providerID ?? ""
            const modelID = latestAssistant?.modelID ?? ""
            const contextLimit =
              providerID && modelID ? providers[providerID]?.models[modelID]?.limit.context : undefined
            const total = tokenTotal(tokens)

            const firstMessageTime = messages
              .map((msg) => msg.info.time.created)
              .reduce((min, next) => Math.min(min, next), Number.POSITIVE_INFINITY)

            return {
              sessionID: info.id,
              title: info.title,
              providerID,
              modelID,
              tokens,
              cost,
              contextLimit,
              contextUsagePct: contextLimit ? Math.round((total / contextLimit) * 100) : undefined,
              messageCount: messages.length,
              isRoot: info.id === root.id,
              firstMessageTime,
            }
          })
          .toSorted((a, b) => {
            if (a.isRoot) return -1
            if (b.isRoot) return 1
            return a.firstMessageTime - b.firstMessageTime
          })
          .map(({ firstMessageTime: _firstMessageTime, ...agent }) => agent)

        const aggregateTokens = emptyTokens()
        let aggregateCost = 0
        let aggregateMessageCount = 0
        for (const agent of agents) {
          addTokens(aggregateTokens, agent.tokens)
          aggregateCost += agent.cost
          aggregateMessageCount += agent.messageCount
        }

        const rootMessages = messagesBySession.get(root.id) ?? []
        const rootAssistantsByUser = new Map<string, MessageV2.Assistant[]>()
        for (const message of rootMessages) {
          if (message.info.role !== "assistant") continue
          const list = rootAssistantsByUser.get(message.info.parentID)
          if (list) list.push(message.info)
          else rootAssistantsByUser.set(message.info.parentID, [message.info])
        }

        const users = rootMessages
          .map((msg) => msg.info)
          .filter((msg): msg is MessageV2.User => msg.role === "user")
          .toSorted((a, b) => a.time.created - b.time.created)
        const userTurnIndex = new Map(users.map((user, turnIndex) => [user.id, turnIndex]))

        const timeline = users.map((user, turnIndex) => {
          const turnTokens = emptyTokens()
          let turnCost = 0
          const assistants = rootAssistantsByUser.get(user.id) ?? []
          for (const assistant of assistants) {
            addTokens(turnTokens, normalizeTokens(assistant.tokens))
            turnCost += numeric(assistant.cost)
          }

          return {
            userMessageID: user.id,
            turnIndex,
            tokens: turnTokens,
            cost: turnCost,
            createdAt: user.time.created,
          }
        })

        const llmCalls = rootMessages
          .filter((message) => message.info.role === "assistant")
          .toSorted((a, b) => a.info.time.created - b.info.time.created)
          .map((message) => {
            const info = message.info as MessageV2.Assistant
            const tokens = normalizeTokens(info.tokens)
            return {
              messageID: info.id,
              turnIndex: userTurnIndex.get(info.parentID) ?? -1,
              providerID: info.providerID ?? "",
              modelID: info.modelID ?? "",
              tokens,
              sentTokens: promptTokenTotal(tokens),
              receivedTokens: tokens.output + tokens.reasoning,
              toolCalls: message.parts.filter((part) => part.type === "tool").length,
              cost: numeric(info.cost),
              createdAt: info.time.created,
            }
          })

        const statsInfos = rootMessages.map((msg) => msg.info)
        const statsLatestAssistant = statsInfos
          .filter((msg): msg is MessageV2.Assistant => msg.role === "assistant")
          .toSorted((a, b) => b.time.created - a.time.created)[0]
        const statsLatestUser = statsInfos
          .filter((msg): msg is MessageV2.User => msg.role === "user")
          .toSorted((a, b) => b.time.created - a.time.created)[0]

        const statsProviderID = statsLatestAssistant?.providerID ?? statsLatestUser?.model.providerID ?? ""
        const statsModelID = statsLatestAssistant?.modelID ?? statsLatestUser?.model.modelID ?? ""
        const statsModel = statsProviderID && statsModelID ? providers[statsProviderID]?.models[statsModelID] : undefined

        const envStable = statsModel ? await SystemPrompt.environmentStable(statsModel).catch(() => [] as string[]) : undefined
        const envVolatile = statsModel ? SystemPrompt.environmentVolatile() : undefined
        const agentPrompt = statsLatestUser?.agent ? await Agent.get(statsLatestUser.agent).then((a) => a?.prompt).catch(() => undefined) : undefined

        const cfg = await Config.get()
        const triggerTokens = getCompactionTriggerTokens(cfg)

        const context = await contextWindowStats({
          messages: rootMessages,
          providers,
          triggerTokens,
          envStable,
          envVolatile,
          agentPrompt,
        })

        return c.json({
          sessionID: root.id,
          agents,
          aggregate: {
            tokens: aggregateTokens,
            cost: aggregateCost,
            agentCount: agents.length,
            messageCount: aggregateMessageCount,
          },
          timeline,
          llmCalls,
          context,
        })
      },
    )
    .post(
      "/",
      describeRoute({
        summary: "Create session",
        description: "Create a new OpenCode session for interacting with AI assistants and managing conversations.",
        operationId: "session.create",
        responses: {
          ...errors(400),
          200: {
            description: "Successfully created session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
        },
      }),
      validator("json", Session.create.schema.optional()),
      async (c) => {
        const body = c.req.valid("json") ?? {}
        const session = await Session.create(body)
        return c.json(session)
      },
    )
    .delete(
      "/:sessionID",
      describeRoute({
        summary: "Delete session",
        description: "Delete a session and permanently remove all associated data, including messages and history.",
        operationId: "session.delete",
        responses: {
          200: {
            description: "Successfully deleted session",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: Session.remove.schema,
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        await Session.remove(sessionID)
        return c.json(true)
      },
    )
    .patch(
      "/:sessionID",
      describeRoute({
        summary: "Update session",
        description: "Update properties of an existing session, such as title or other metadata.",
        operationId: "session.update",
        responses: {
          200: {
            description: "Successfully updated session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator(
        "json",
        z.object({
          title: z.string().optional(),
          time: z
            .object({
              archived: z.number().optional(),
            })
            .optional(),
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const updates = c.req.valid("json")

        if (updates.title !== undefined) {
          await Session.setTitle({ sessionID, title: updates.title })
        }
        if (updates.time?.archived !== undefined) {
          await Session.setArchived({ sessionID, time: updates.time.archived })
        }

        const session = await Session.get(sessionID)
        return c.json(session)
      },
    )
    .post(
      "/:sessionID/init",
      describeRoute({
        summary: "Initialize session",
        description: "Analyze the current application and bootstrap project notes for notes-centric workflows.",
        operationId: "session.init",
        responses: {
          200: {
            description: "200",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator("json", Session.initialize.schema.omit({ sessionID: true })),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        await Session.initialize({ ...body, sessionID })
        return c.json(true)
      },
    )
    .post(
      "/:sessionID/fork",
      describeRoute({
        summary: "Fork session",
        description: "Create a new session by forking an existing session at a specific message point.",
        operationId: "session.fork",
        responses: {
          200: {
            description: "200",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: Session.fork.schema.shape.sessionID,
        }),
      ),
      validator("json", Session.fork.schema.omit({ sessionID: true })),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        const result = await Session.fork({ ...body, sessionID })
        return c.json(result)
      },
    )
    .post(
      "/:sessionID/abort",
      describeRoute({
        summary: "Abort session",
        description: "Abort an active session and stop any ongoing AI processing or command execution.",
        operationId: "session.abort",
        responses: {
          200: {
            description: "Aborted session",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      async (c) => {
        await SessionPrompt.cancel(c.req.valid("param").sessionID)
        return c.json(true)
      },
    )
    .post(
      "/:sessionID/share",
      describeRoute({
        summary: "Share session",
        description: "Create a shareable link for a session, allowing others to view the conversation.",
        operationId: "session.share",
        responses: {
          200: {
            description: "Successfully shared session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        await Session.share(sessionID)
        const session = await Session.get(sessionID)
        return c.json(session)
      },
    )
    .get(
      "/:sessionID/diff",
      describeRoute({
        summary: "Get message diff",
        description: "Get the file changes (diff) that resulted from a specific user message in the session.",
        operationId: "session.diff",
        responses: {
          200: {
            description: "Successfully retrieved diff",
            content: {
              "application/json": {
                schema: resolver(Snapshot.FileDiff.array()),
              },
            },
          },
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionSummary.DiffInput.shape.sessionID,
        }),
      ),
      validator(
        "query",
        z.object({
          messageID: SessionSummary.DiffInput.shape.messageID,
        }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        const params = c.req.valid("param")
        const result = await SessionSummary.diff({
          sessionID: params.sessionID,
          messageID: query.messageID,
        }).catch((error) => {
          log.warn("session.diff_failed", {
            sessionID: params.sessionID,
            messageID: query.messageID,
            error: errorMessage(error),
          })
          return []
        })
        return c.json(result)
      },
    )
    .delete(
      "/:sessionID/share",
      describeRoute({
        summary: "Unshare session",
        description: "Remove the shareable link for a session, making it private again.",
        operationId: "session.unshare",
        responses: {
          200: {
            description: "Successfully unshared session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: Session.unshare.schema,
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        await Session.unshare(sessionID)
        const session = await Session.get(sessionID)
        return c.json(session)
      },
    )
    .post(
      "/:sessionID/summarize",
      describeRoute({
        summary: "Summarize session",
        description: "Generate a concise summary of the session using AI compaction to preserve key information.",
        operationId: "session.summarize",
        responses: {
          200: {
            description: "Summarized session",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator(
        "json",
        z.object({
          providerID: ProviderID.zod,
          modelID: ModelID.zod,
          auto: z.boolean().optional().default(false),
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        const session = await Session.get(sessionID)
        await SessionRevert.cleanup(session)
        const msgs = await Session.messages({ sessionID })
        let currentAgent = await Agent.defaultAgent()
        for (let i = msgs.length - 1; i >= 0; i--) {
          const info = msgs[i].info
          if (info.role === "user") {
            currentAgent = info.agent || (await Agent.defaultAgent())
            break
          }
        }
        await SessionCompaction.create({
          sessionID,
          agent: currentAgent,
          model: {
            providerID: body.providerID,
            modelID: body.modelID,
          },
          auto: body.auto,
        })
        await SessionPrompt.loop({ sessionID, loopMode: false })
        return c.json(true)
      },
    )
    .get(
      "/:sessionID/message",
      describeRoute({
        summary: "Get session messages",
        description: "Retrieve all messages in a session, including user prompts and AI responses.",
        operationId: "session.messages",
        responses: {
          200: {
            description: "List of messages",
            content: {
              "application/json": {
                schema: resolver(MessageV2.WithParts.array()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator(
        "query",
        z
          .object({
            limit: z.coerce
              .number()
              .int()
              .min(0)
              .optional()
              .meta({ description: "Maximum number of messages to return" }),
            before: z
              .string()
              .optional()
              .meta({ description: "Opaque cursor for loading older messages" })
              .refine(
                (value) => {
                  if (!value) return true
                  try {
                    MessageV2.cursor.decode(value)
                    return true
                  } catch {
                    return false
                  }
                },
                { message: "Invalid cursor" },
              ),
          })
          .refine((value) => !value.before || value.limit !== undefined, {
            message: "before requires limit",
            path: ["before"],
          }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        const sessionID = c.req.valid("param").sessionID
        if (query.limit === undefined) {
          await Session.get(sessionID)
          const messages = await Session.messages({ sessionID })
          return c.json(messages)
        }

        if (query.limit === 0) {
          await Session.get(sessionID)
          const messages = await Session.messages({ sessionID })
          return c.json(messages)
        }

        const page = await MessageV2.page({
          sessionID,
          limit: query.limit,
          before: query.before,
        })
        if (page.cursor) {
          const url = new URL(c.req.url)
          url.searchParams.set("limit", query.limit.toString())
          url.searchParams.set("before", page.cursor)
          c.header("Access-Control-Expose-Headers", "Link, X-Next-Cursor")
          c.header("Link", `<${url.toString()}>; rel=\"next\"`)
          c.header("X-Next-Cursor", page.cursor)
        }
        return c.json(page.items)
      },
    )
    .get(
      "/:sessionID/message/:messageID",
      describeRoute({
        summary: "Get message",
        description: "Retrieve a specific message from a session by its message ID.",
        operationId: "session.message",
        responses: {
          200: {
            description: "Message",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    info: MessageV2.Info,
                    parts: MessageV2.Part.array(),
                  }),
                ),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
          messageID: MessageID.zod,
        }),
      ),
      async (c) => {
        const params = c.req.valid("param")
        const message = await MessageV2.get({
          sessionID: params.sessionID,
          messageID: params.messageID,
        })
        return c.json(message)
      },
    )
    .delete(
      "/:sessionID/message/:messageID",
      describeRoute({
        summary: "Delete message",
        description:
          "Permanently delete a specific message (and all of its parts) from a session. This does not revert any file changes that may have been made while processing the message.",
        operationId: "session.deleteMessage",
        responses: {
          200: {
            description: "Successfully deleted message",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
          messageID: MessageID.zod,
        }),
      ),
      async (c) => {
        const params = c.req.valid("param")
        await SessionPrompt.assertNotBusy(params.sessionID)
        await Session.removeMessage({
          sessionID: params.sessionID,
          messageID: params.messageID,
        })
        return c.json(true)
      },
    )
    .delete(
      "/:sessionID/message/:messageID/part/:partID",
      describeRoute({
        description: "Delete a part from a message",
        operationId: "part.delete",
        responses: {
          200: {
            description: "Successfully deleted part",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
          messageID: MessageID.zod,
          partID: PartID.zod,
        }),
      ),
      async (c) => {
        const params = c.req.valid("param")
        await Session.removePart({
          sessionID: params.sessionID,
          messageID: params.messageID,
          partID: params.partID,
        })
        return c.json(true)
      },
    )
    .patch(
      "/:sessionID/message/:messageID/part/:partID",
      describeRoute({
        description: "Update a part in a message",
        operationId: "part.update",
        responses: {
          200: {
            description: "Successfully updated part",
            content: {
              "application/json": {
                schema: resolver(MessageV2.Part),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
          messageID: MessageID.zod,
          partID: PartID.zod,
        }),
      ),
      validator("json", MessageV2.Part),
      async (c) => {
        const params = c.req.valid("param")
        const body = c.req.valid("json")
        if (body.id !== params.partID || body.messageID !== params.messageID || body.sessionID !== params.sessionID) {
          throw new Error(
            `Part mismatch: body.id='${body.id}' vs partID='${params.partID}', body.messageID='${body.messageID}' vs messageID='${params.messageID}', body.sessionID='${body.sessionID}' vs sessionID='${params.sessionID}'`,
          )
        }
        const part = await Session.updatePart(body)
        return c.json(part)
      },
    )

    .get(
      "/:sessionID/todo",
      describeRoute({
        summary: "Get attached todo snapshot",
        description:
          "Return the todo file currently attached to this session, reparsing the backing file when present.",
        operationId: "session.todo",
        responses: {
          200: {
            description: "Attached todo snapshot",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    task_path: z.string().optional(),
                    taskPath: z.string().optional(),
                    file: z.string().optional(),
                    label: z.string().optional(),
                    status: z.string().optional(),
                    todos: z.array(z.any()),
                    tree: z.array(z.any()).optional(),
                    sections: z.array(z.object({ title: z.string(), body: z.string() })).optional(),
                    attached_todo_ids: z.array(z.string()).optional(),
                    attached_todo_labels: z.record(z.string(), z.string()).optional(),
                  }),
                ),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        log.info("todo-file.get", { sessionID })
        return c.json(await TodoFile.get(sessionID))
      },
    )

    .post(
      "/:sessionID/todo-file",
      describeRoute({
        summary: "Create and attach todo file",
        description: "Create a scratchpad todo file and attach it to this session's Todo tab.",
        operationId: "session.todo_file.create",
        responses: {
          200: {
            description: "Created attached todo snapshot",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    task_path: z.string().optional(),
                    taskPath: z.string().optional(),
                    file: z.string().optional(),
                    label: z.string().optional(),
                    status: z.string().optional(),
                    todos: z.array(z.any()),
                    tree: z.array(z.any()).optional(),
                    sections: z.array(z.object({ title: z.string(), body: z.string() })).optional(),
                    attached_todo_ids: z.array(z.string()).optional(),
                    attached_todo_labels: z.record(z.string(), z.string()).optional(),
                  }),
                ),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator(
        "json",
        z.object({
          title: z.string().min(1),
          slug: z.string().optional(),
          assignment: z.string().optional(),
          body: z.string().optional(),
          project: z.string().optional(),
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        log.info("todo-file.create", { sessionID, title: body.title, slug: body.slug, project: body.project })
        try {
          const snapshot = await TodoFile.create({ sessionID, ...body })
          log.info("todo-file.create.success", { sessionID, taskPath: snapshot.task_path, file: snapshot.file })
          return c.json(snapshot)
        } catch (err) {
          log.warn("todo-file.create.failed", { sessionID, error: errorMessage(err) })
          throw new NamedError.Unknown({ message: errorMessage(err) })
        }
      },
    )

    .post(
      "/:sessionID/todo-file/attach",
      describeRoute({
        summary: "Attach existing todo file",
        description: "Attach an existing scratchpad todo file to this session's Todo tab.",
        operationId: "session.todo_file.attach",
        responses: {
          200: {
            description: "Attached todo snapshot",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    task_path: z.string().optional(),
                    taskPath: z.string().optional(),
                    file: z.string().optional(),
                    label: z.string().optional(),
                    status: z.string().optional(),
                    todos: z.array(z.any()),
                    tree: z.array(z.any()).optional(),
                    sections: z.array(z.object({ title: z.string(), body: z.string() })).optional(),
                    attached_todo_ids: z.array(z.string()).optional(),
                    attached_todo_labels: z.record(z.string(), z.string()).optional(),
                  }),
                ),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator(
        "json",
        z.object({
          path: z.string().min(1),
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        log.info("todo-file.attach", { sessionID, path: body.path })
        try {
          const snapshot = await TodoFile.attach({ sessionID, path: body.path })
          log.info("todo-file.attach.success", { sessionID, taskPath: snapshot.task_path, file: snapshot.file })
          return c.json(snapshot)
        } catch (err) {
          log.warn("todo-file.attach.failed", { sessionID, path: body.path, error: errorMessage(err) })
          throw new NamedError.Unknown({ message: errorMessage(err) })
        }
      },
    )

    .post(
      "/:sessionID/todo-file/patch",
      describeRoute({
        summary: "Patch attached todo file",
        description:
          "Apply typed, concurrency-safe edits to the todo.md file attached to this session. Used by Neovim todo agents for shared todo state updates.",
        operationId: "session.todo_file.patch",
        responses: {
          200: {
            description: "Patch result",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    snapshot: z.any(),
                    changed: z.boolean(),
                    applied: z.number(),
                    hash: z.string(),
                  }),
                ),
              },
            },
          },
          ...errors(400, 404, 409),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator(
        "json",
        z.object({
          baseHash: z.string().optional(),
          operations: z.array(
            z.discriminatedUnion("type", [
              z.object({
                type: z.literal("append-system-fact"),
                text: z.string().min(1),
                agentName: z.string().optional(),
              }),
              z.object({
                type: z.literal("add-task"),
                markdown: z.string().min(1),
                afterTaskID: z.string().optional(),
                afterTitle: z.string().optional(),
              }),
              z.object({
                type: z.literal("append-agent-response"),
                taskID: z.string().optional(),
                taskTitle: z.string().optional(),
                text: z.string().min(1),
              }),
              z.object({
                type: z.literal("resolve-comments"),
                taskID: z.string().optional(),
                taskTitle: z.string().optional(),
                commentText: z.string().optional(),
                allPending: z.boolean().optional(),
              }),
              z.object({
                type: z.literal("set-task-checked"),
                taskID: z.string().optional(),
                taskTitle: z.string().optional(),
                checked: z.boolean(),
              }),
              z.object({
                type: z.literal("add-comment"),
                taskID: z.string().optional(),
                taskTitle: z.string().optional(),
                text: z.string().min(1),
              }),
              z.object({
                type: z.literal("replace-source"),
                source: z.string(),
              }),
            ]),
          ),
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        log.info("todo-file.patch", { sessionID, operations: body.operations.map((op) => op.type) })
        try {
          return c.json(
            await TodoFile.patch({
              sessionID,
              baseHash: body.baseHash,
              operations: body.operations,
            }),
          )
        } catch (err) {
          log.warn("todo-file.patch.failed", { sessionID, error: errorMessage(err) })
          throw new NamedError.Unknown({ message: errorMessage(err) })
        }
      },
    )

    .get(
      "/:sessionID/todo-agent",
      describeRoute({
        summary: "List todo agents",
        description: "List named todo agents registered for the root session backing the file-based Todo interface.",
        operationId: "session.todo_agent.list",
        responses: {
          200: {
            description: "Todo agents",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    agents: z.array(
                      z.object({
                        rootSessionID: SessionID.zod,
                        name: z.string(),
                        sessionID: SessionID.zod,
                        providerID: z.string(),
                        modelID: z.string(),
                        source: z.any().optional(),
                        timeCreated: z.number(),
                        timeUpdated: z.number(),
                      }),
                    ),
                  }),
                ),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const agents = TodoAgentRegistry.list(sessionID)
        log.info("todo-agent.list", { sessionID, count: agents.length })
        return c.json({ agents })
      },
    )

    .post(
      "/:sessionID/todo-agent/run",
      describeRoute({
        summary: "Run todo agent task",
        description:
          "Run a todo-file assignment block against a named todo agent, creating, reusing, or forking the backing session as needed.",
        operationId: "session.todo_agent.run",
        responses: {
          200: {
            description: "Todo agent run accepted",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    agent: z.object({
                      rootSessionID: SessionID.zod,
                      name: z.string(),
                      sessionID: SessionID.zod,
                      providerID: z.string(),
                      modelID: z.string(),
                      created: z.boolean(),
                      forked: z.boolean(),
                    }),
                    responseText: z.string().optional(),
                    accepted: z.boolean().optional(),
                  }),
                ),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator(
        "json",
        z.object({
          taskMarkdown: z.string().min(1),
          systemsText: z.string().optional(),
          mode: z.enum(["initial", "follow-up"]).optional(),
          async: z.boolean().optional(),
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        log.info("todo-agent.run", { sessionID, async: body.async, mode: body.mode })
        let taskMarkdown = body.taskMarkdown
        let parsed = parseTodoAgentTasks(taskMarkdown)
        let task = parsed.tasks[0]
        if (
          task &&
          task.comments.filter((comment) => comment.status === "pending").length === 0 &&
          /<\s*Agent\b/.test(taskMarkdown)
        ) {
          try {
            const snapshot = await TodoFile.get(sessionID)
            if ("source" in snapshot && typeof snapshot.source === "string") {
              const enriched = appendRoutedTodoAgentComments(taskMarkdown, snapshot.source)
              if (enriched !== taskMarkdown) {
                taskMarkdown = enriched
                parsed = parseTodoAgentTasks(taskMarkdown)
                task = parsed.tasks[0]
                log.info("todo-agent.run.comments_enriched", {
                  sessionID,
                  taskTitle: task?.title,
                  pendingComments: task?.comments.filter((comment) => comment.status === "pending").length ?? 0,
                })
              }
            }
          } catch (err) {
            log.warn("todo-agent.run.comments_enrich_failed", { sessionID, error: errorMessage(err) })
          }
        }
        if (!task) throw new NamedError.Unknown({ message: "No todo task found in taskMarkdown" })
        if (parsed.diagnostics.length > 0) {
          throw new NamedError.Unknown({ message: `Invalid todo agent task: ${parsed.diagnostics.join("; ")}` })
        }
        if (body.async) {
          const agent = await TodoAgentRunner.dispatchTask({
            rootSessionID: sessionID,
            task,
            systemsText: body.systemsText,
            mode: body.mode,
            onComplete: async (completed) => {
              const responseText = completed.responseText?.trim()
              if (!responseText) return
              const pendingComments = task.comments.filter((comment) => comment.status === "pending").length
              const operations: TodoFilePatch.Operation[] = [
                { type: "append-agent-response", taskTitle: task.title, text: responseText },
              ]
              if (pendingComments > 0)
                operations.push({ type: "resolve-comments", taskTitle: task.title, allPending: true })
              try {
                const patched = await TodoFile.patch({ sessionID, operations })
                log.info("todo-agent.run.patched", {
                  sessionID,
                  agent: completed.name,
                  changed: patched.changed,
                  applied: patched.applied,
                  pendingComments,
                })
              } catch (err) {
                log.error("todo-agent async patch failed", { sessionID, agent: completed.name, error: err })
                Bus.publish(Session.Event.Error, {
                  sessionID,
                  error: MessageV2.AssistantError.parse(
                    new NamedError.Unknown({ message: errorMessage(err) }).toObject(),
                  ),
                })
              }
            },
            onError: (err) => {
              log.error("todo-agent async run failed", { sessionID, error: err })
              Bus.publish(Session.Event.Error, {
                sessionID,
                error: MessageV2.AssistantError.parse(
                  new NamedError.Unknown({ message: errorMessage(err) }).toObject(),
                ),
              })
            },
          })
          log.info("todo-agent.run.accepted", { sessionID, agent: agent.name, agentSessionID: agent.sessionID })
          return c.json({ agent, accepted: true })
        }
        const result = await TodoAgentRunner.runTask({
          rootSessionID: sessionID,
          task,
          systemsText: body.systemsText,
          mode: body.mode,
        })
        const { responseText, ...agent } = result
        log.info("todo-agent.run.completed", {
          sessionID,
          agent: agent.name,
          agentSessionID: agent.sessionID,
          responseChars: responseText?.length ?? 0,
        })
        return c.json({ agent, responseText, accepted: false })
      },
    )
    .post(
      "/:sessionID/message",
      describeRoute({
        summary: "Send message",
        description: "Create and send a new message to a session, streaming the AI response.",
        operationId: "session.prompt",
        responses: {
          200: {
            description: "Created message",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    info: MessageV2.Assistant,
                    parts: MessageV2.Part.array(),
                  }),
                ),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator("json", SessionPrompt.PromptInput.omit({ sessionID: true })),
      async (c) => {
        c.status(200)
        c.header("Content-Type", "application/json")
        return stream(c, async (stream) => {
          const sessionID = c.req.valid("param").sessionID
          const body = c.req.valid("json")
          const msg = await SessionPrompt.prompt({ ...body, sessionID })
          // gap-28-followup-2: NdjsonSafe escapes U+2028/U+2029 so the
          // serialized response can't be cut by line-splitting receivers.
          stream.write(NdjsonSafe.stringify(msg))
        })
      },
    )
    .post(
      "/:sessionID/prompt_async",
      describeRoute({
        summary: "Send async message",
        description:
          "Create and send a new message to a session asynchronously, starting the session if needed and returning immediately.",
        operationId: "session.prompt_async",
        responses: {
          204: {
            description: "Prompt accepted",
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator("json", SessionPrompt.PromptInput.omit({ sessionID: true })),
      async (c) => {
        c.status(204)
        c.header("Content-Type", "application/json")
        return stream(c, async () => {
          const sessionID = c.req.valid("param").sessionID
          const body = c.req.valid("json")
          SessionPrompt.prompt({ ...body, sessionID }).catch((err) => {
            log.error("prompt_async failed", { sessionID, error: err })
            Bus.publish(Session.Event.Error, {
              sessionID,
              error: MessageV2.AssistantError.parse(new NamedError.Unknown({ message: errorMessage(err) }).toObject()),
            })
          })
        })
      },
    )
    .post(
      "/:sessionID/command",
      describeRoute({
        summary: "Send command",
        description: "Send a new command to a session for execution by the AI assistant.",
        operationId: "session.command",
        responses: {
          200: {
            description: "Created message",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    info: MessageV2.Assistant,
                    parts: MessageV2.Part.array(),
                  }),
                ),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator("json", SessionPrompt.CommandInput.omit({ sessionID: true })),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        const msg = await SessionPrompt.command({ ...body, sessionID })
        return c.json(msg)
      },
    )
    .post(
      "/:sessionID/shell",
      describeRoute({
        summary: "Run shell command",
        description: "Execute a shell command within the session context and return the AI's response.",
        operationId: "session.shell",
        responses: {
          200: {
            description: "Created message",
            content: {
              "application/json": {
                schema: resolver(MessageV2.Assistant),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator("json", SessionPrompt.ShellInput.omit({ sessionID: true })),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        const msg = await SessionPrompt.shell({ ...body, sessionID })
        return c.json(msg)
      },
    )
    .post(
      "/:sessionID/revert",
      describeRoute({
        summary: "Revert message",
        description: "Revert a specific message in a session, undoing its effects and restoring the previous state.",
        operationId: "session.revert",
        responses: {
          200: {
            description: "Updated session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator("json", SessionRevert.RevertInput.omit({ sessionID: true })),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        log.info("revert", c.req.valid("json"))
        const session = await SessionRevert.revert({
          sessionID,
          ...c.req.valid("json"),
        })
        return c.json(session)
      },
    )
    .post(
      "/:sessionID/unrevert",
      describeRoute({
        summary: "Restore reverted messages",
        description: "Restore all previously reverted messages in a session.",
        operationId: "session.unrevert",
        responses: {
          200: {
            description: "Updated session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const session = await SessionRevert.unrevert({ sessionID })
        return c.json(session)
      },
    )
