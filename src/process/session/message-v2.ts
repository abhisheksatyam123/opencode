import { BusEvent } from "@/bus/bus-event"
import { SessionID, MessageID, PartID } from "@/process/session/schema"
import z from "zod"
import { NamedError, type NamedErrorObject } from "@opencode-ai/util/error"
import { APICallError, convertToModelMessages, LoadAPIKeyError, type ModelMessage, type UIMessage } from "ai"
import { Snapshot } from "@/storage/snapshot"
import { SyncEvent } from "@/surface/sync/layer"
import { Database, NotFoundError, and, desc, eq, inArray, lt, or } from "@/storage/db"
import { MessageTable, PartTable, SessionTable } from "@/process/session/session.sql"
import { ProviderError } from "@/provider/error"
import { iife } from "@/foundation/util/iife"
import {
  isGemini3Model,
  extractThoughtSignature,
  createProviderOptions,
  SKIP_THOUGHT_SIGNATURE,
} from "@/process/session/thought-signature"
import { errorMessage } from "@/foundation/util/error"
import type { SystemError } from "bun"
import type { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { Effect } from "effect"
import { sanitizeToolNameForModel } from "@/tool/name"

/** Error shape thrown by Bun's fetch() when gzip/br decompression fails mid-stream */
interface FetchDecompressionError extends Error {
  code: "ZlibError"
  errno: number
  path: string
}

/**
 * Build callProviderMetadata for a replayed tool-call part on Gemini 3.
 *
 * Gemini 3 rejects any assistant-side function-call block missing a
 * thought_signature. For Gemini 3 we always normalize the signature under
 * the `google` key (even if the stored metadata has it under a proxy key
 * like `qpilot` / `qgenie`) because the native @ai-sdk/openai-compatible
 * send path reads providerOptions.google.thoughtSignature. If no signature
 * is present, inject the skip sentinel so VertexAI bypasses validation.
 */
function buildGemini3ToolCallMetadata(args: {
  isGemini3: boolean
  differentModel: boolean
  partMetadata: Record<string, any> | undefined
  thoughtSignature: string | undefined
}): Record<string, any> | undefined {
  const { isGemini3, differentModel, partMetadata, thoughtSignature } = args
  if (!isGemini3) return differentModel ? undefined : sanitizeProviderMetadata(partMetadata)
  const effective = thoughtSignature ?? SKIP_THOUGHT_SIGNATURE
  const normalized = createProviderOptions(effective).providerOptions
  if (differentModel) return normalized
  return { ...(sanitizeProviderMetadata(partMetadata) ?? {}), ...normalized }
}

/**
 * AI SDK providerOptions schema expects a record of provider-name -> record.
 * Historical parts can carry scalar/array keys (e.g. calls_total) that break
 * ModelMessage validation. Drop non-record leaves before convertToModelMessages.
 */
function sanitizeProviderMetadata(
  metadata: Record<string, any> | undefined,
): Record<string, Record<string, any>> | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined
  const entries = Object.entries(metadata).filter(([, value]) => {
    return value !== null && typeof value === "object" && !Array.isArray(value)
  })
  if (entries.length === 0) return undefined
  return Object.fromEntries(entries) as Record<string, Record<string, any>>
}

export namespace MessageV2 {
  export function isMedia(mime: string) {
    return mime.startsWith("image/") || mime === "application/pdf"
  }

  export const OutputLengthError = NamedError.create("MessageOutputLengthError", z.object({}))
  export const AbortedError = NamedError.create("MessageAbortedError", z.object({ message: z.string() }))
  export const StructuredOutputError = NamedError.create(
    "StructuredOutputError",
    z.object({
      message: z.string(),
      retries: z.number(),
    }),
  )
  export const AuthError = NamedError.create(
    "ProviderAuthError",
    z.object({
      providerID: z.string(),
      message: z.string(),
    }),
  )
  export const APIError = NamedError.create(
    "APIError",
    z.object({
      message: z.string(),
      statusCode: z.number().optional(),
      isRetryable: z.boolean(),
      responseHeaders: z.record(z.string(), z.string()).optional(),
      responseBody: z.string().optional(),
      metadata: z.record(z.string(), z.string()).optional(),
    }),
  )
  export type APIError = z.infer<typeof APIError.Schema>
  export const ContextOverflowError = NamedError.create(
    "ContextOverflowError",
    z.object({ message: z.string(), responseBody: z.string().optional() }),
  )

  export const CompactionSkippedError = NamedError.create(
    "CompactionSkippedError",
    z.object({
      reason: z.literal("provider_forbidden"),
      attempted: z.array(z.string()),
    }),
  )
  export type CompactionSkippedError = z.infer<typeof CompactionSkippedError.Schema>

  export const OutputFormatText = z
    .object({
      type: z.literal("text"),
    })
    .meta({
      ref: "OutputFormatText",
    })

  export const OutputFormatJsonSchema = z
    .object({
      type: z.literal("json_schema"),
      schema: z.record(z.string(), z.any()).meta({ ref: "JSONSchema" }),
      retryCount: z.number().int().min(0).default(2),
    })
    .meta({
      ref: "OutputFormatJsonSchema",
    })

  export const Format = z.discriminatedUnion("type", [OutputFormatText, OutputFormatJsonSchema]).meta({
    ref: "OutputFormat",
  })
  export type OutputFormat = z.infer<typeof Format>

  const PartBase = z.object({
    id: PartID.zod,
    sessionID: SessionID.zod,
    messageID: MessageID.zod,
  })

  export const SnapshotPart = PartBase.extend({
    type: z.literal("snapshot"),
    snapshot: z.string(),
  }).meta({
    ref: "SnapshotPart",
  })
  export type SnapshotPart = z.infer<typeof SnapshotPart>

  export const PatchPart = PartBase.extend({
    type: z.literal("patch"),
    hash: z.string(),
    files: z.string().array(),
  }).meta({
    ref: "PatchPart",
  })
  export type PatchPart = z.infer<typeof PatchPart>

  export const TextPart = PartBase.extend({
    type: z.literal("text"),
    text: z.string(),
    synthetic: z.boolean().optional(),
    ignored: z.boolean().optional(),
    time: z
      .object({
        start: z.number(),
        end: z.number().optional(),
      })
      .optional(),
    metadata: z.record(z.string(), z.any()).optional(),
  }).meta({
    ref: "TextPart",
  })
  export type TextPart = z.infer<typeof TextPart>

  export const ReasoningPart = PartBase.extend({
    type: z.literal("reasoning"),
    text: z.string(),
    metadata: z.record(z.string(), z.any()).optional(),
    time: z.object({
      start: z.number(),
      end: z.number().optional(),
    }),
  }).meta({
    ref: "ReasoningPart",
  })
  export type ReasoningPart = z.infer<typeof ReasoningPart>

  const FilePartSourceBase = z.object({
    text: z
      .object({
        value: z.string(),
        start: z.number().int(),
        end: z.number().int(),
      })
      .meta({
        ref: "FilePartSourceText",
      }),
  })

  export const FileSource = FilePartSourceBase.extend({
    type: z.literal("file"),
    path: z.string(),
  }).meta({
    ref: "FileSource",
  })

  const SymbolRange = z
    .object({
      start: z.object({
        line: z.number(),
        character: z.number(),
      }),
      end: z.object({
        line: z.number(),
        character: z.number(),
      }),
    })
    .meta({
      ref: "SymbolRange",
    })

  export const SymbolSource = FilePartSourceBase.extend({
    type: z.literal("symbol"),
    path: z.string(),
    range: SymbolRange,
    name: z.string(),
    kind: z.number().int(),
  }).meta({
    ref: "SymbolSource",
  })

  export const ResourceSource = FilePartSourceBase.extend({
    type: z.literal("resource"),
    clientName: z.string(),
    uri: z.string(),
  }).meta({
    ref: "ResourceSource",
  })

  export const FilePartSource = z.discriminatedUnion("type", [FileSource, SymbolSource, ResourceSource]).meta({
    ref: "FilePartSource",
  })

  export const FilePart = PartBase.extend({
    type: z.literal("file"),
    mime: z.string(),
    filename: z.string().optional(),
    url: z.string(),
    source: FilePartSource.optional(),
  }).meta({
    ref: "FilePart",
  })
  export type FilePart = z.infer<typeof FilePart>

  export const AgentPart = PartBase.extend({
    type: z.literal("agent"),
    name: z.string(),
    source: z
      .object({
        value: z.string(),
        start: z.number().int(),
        end: z.number().int(),
      })
      .optional(),
  }).meta({
    ref: "AgentPart",
  })
  export type AgentPart = z.infer<typeof AgentPart>

  export const CompactionPart = PartBase.extend({
    type: z.literal("compaction"),
    auto: z.boolean(),
    overflow: z.boolean().optional(),
  }).meta({
    ref: "CompactionPart",
  })
  export type CompactionPart = z.infer<typeof CompactionPart>

  export const SubtaskPart = PartBase.extend({
    type: z.literal("subtask"),
    prompt: z.string(),
    description: z.string(),
    agent: z.string(),
    model: z
      .object({
        providerID: ProviderID.zod,
        modelID: ModelID.zod,
      })
      .optional(),
    command: z.string().optional(),
    background: z.boolean().optional(),
  }).meta({
    ref: "SubtaskPart",
  })
  export type SubtaskPart = z.infer<typeof SubtaskPart>

  export const RetryPart = PartBase.extend({
    type: z.literal("retry"),
    attempt: z.number(),
    error: APIError.Schema,
    time: z.object({
      created: z.number(),
    }),
  }).meta({
    ref: "RetryPart",
  })
  export type RetryPart = z.infer<typeof RetryPart>

  export const StepStartPart = PartBase.extend({
    type: z.literal("step-start"),
    snapshot: z.string().optional(),
  }).meta({
    ref: "StepStartPart",
  })
  export type StepStartPart = z.infer<typeof StepStartPart>

  export const StepFinishPart = PartBase.extend({
    type: z.literal("step-finish"),
    reason: z.string(),
    snapshot: z.string().optional(),
    cost: z.number(),
    tokens: z.object({
      total: z.number().optional(),
      input: z.number(),
      output: z.number(),
      reasoning: z.number(),
      cache: z.object({
        read: z.number(),
        write: z.number(),
      }),
    }),
  }).meta({
    ref: "StepFinishPart",
  })
  export type StepFinishPart = z.infer<typeof StepFinishPart>

  export const ToolStatePending = z
    .object({
      status: z.literal("pending"),
      input: z.record(z.string(), z.any()),
      raw: z.string(),
    })
    .meta({
      ref: "ToolStatePending",
    })

  export type ToolStatePending = z.infer<typeof ToolStatePending>

  export const ToolStateRunning = z
    .object({
      status: z.literal("running"),
      input: z.record(z.string(), z.any()),
      title: z.string().optional(),
      metadata: z.record(z.string(), z.any()).optional(),
      time: z.object({
        start: z.number(),
      }),
    })
    .meta({
      ref: "ToolStateRunning",
    })
  export type ToolStateRunning = z.infer<typeof ToolStateRunning>

  export const ToolStateCompleted = z
    .object({
      status: z.literal("completed"),
      input: z.record(z.string(), z.any()),
      output: z.string(),
      title: z.string(),
      metadata: z.record(z.string(), z.any()),
      time: z.object({
        start: z.number(),
        end: z.number(),
        compacted: z.number().optional(),
      }),
      attachments: FilePart.array().optional(),
    })
    .meta({
      ref: "ToolStateCompleted",
    })
  export type ToolStateCompleted = z.infer<typeof ToolStateCompleted>

  export const ToolStateError = z
    .object({
      status: z.literal("error"),
      input: z.record(z.string(), z.any()),
      error: z.string(),
      metadata: z.record(z.string(), z.any()).optional(),
      time: z.object({
        start: z.number(),
        end: z.number(),
      }),
    })
    .meta({
      ref: "ToolStateError",
    })
  export type ToolStateError = z.infer<typeof ToolStateError>

  export const ToolState = z
    .discriminatedUnion("status", [ToolStatePending, ToolStateRunning, ToolStateCompleted, ToolStateError])
    .meta({
      ref: "ToolState",
    })

  export const ToolPart = PartBase.extend({
    type: z.literal("tool"),
    callID: z.string(),
    tool: z.string(),
    state: ToolState,
    metadata: z.record(z.string(), z.any()).optional(),
  }).meta({
    ref: "ToolPart",
  })
  export type ToolPart = z.infer<typeof ToolPart>

  const Base = z.object({
    id: MessageID.zod,
    sessionID: SessionID.zod,
  })

  export const User = Base.extend({
    role: z.literal("user"),
    time: z.object({
      created: z.number(),
    }),
    format: Format.optional(),
    summary: z
      .object({
        title: z.string().optional(),
        body: z.string().optional(),
        diffs: Snapshot.FileDiff.array(),
      })
      .optional(),
    agent: z.string(),
    model: z.object({
      providerID: ProviderID.zod,
      modelID: ModelID.zod,
    }),
    system: z.string().optional(),
    tools: z.record(z.string(), z.boolean()).optional(),
    variant: z.string().optional(),
  }).meta({
    ref: "UserMessage",
  })
  export type User = z.infer<typeof User>

  export const Part = z
    .discriminatedUnion("type", [
      TextPart,
      SubtaskPart,
      ReasoningPart,
      FilePart,
      ToolPart,
      StepStartPart,
      StepFinishPart,
      SnapshotPart,
      PatchPart,
      AgentPart,
      RetryPart,
      CompactionPart,
    ])
    .meta({
      ref: "Part",
    })
  export type Part = z.infer<typeof Part>

  export const AssistantError = z
    .discriminatedUnion("name", [
      AuthError.Schema,
      NamedError.Unknown.Schema,
      OutputLengthError.Schema,
      AbortedError.Schema,
      StructuredOutputError.Schema,
      ContextOverflowError.Schema,
      APIError.Schema,
    ])
    .meta({
      ref: "AssistantError",
    })
  export type AssistantError = z.infer<typeof AssistantError>

  export const Assistant = Base.extend({
    role: z.literal("assistant"),
    time: z.object({
      created: z.number(),
      completed: z.number().optional(),
    }),
    error: AssistantError.optional(),
    parentID: MessageID.zod,
    modelID: ModelID.zod,
    providerID: ProviderID.zod,
    /**
     * @deprecated
     */
    mode: z.string(),
    agent: z.string(),
    path: z.object({
      cwd: z.string(),
      root: z.string(),
    }),
    summary: z.boolean().optional(),
    cost: z.number(),
    tokens: z.object({
      total: z.number().optional(),
      input: z.number(),
      output: z.number(),
      reasoning: z.number(),
      cache: z.object({
        read: z.number(),
        write: z.number(),
      }),
    }),
    structured: z.any().optional(),
    variant: z.string().optional(),
    finish: z.string().optional(),
  }).meta({
    ref: "AssistantMessage",
  })
  export type Assistant = z.infer<typeof Assistant>

  export const Info = z.discriminatedUnion("role", [User, Assistant]).meta({
    ref: "Message",
  })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Updated: SyncEvent.define({
      type: "message.updated",
      version: 1,
      aggregate: "sessionID",
      schema: z.object({
        sessionID: SessionID.zod,
        info: Info,
      }),
    }),
    Removed: SyncEvent.define({
      type: "message.removed",
      version: 1,
      aggregate: "sessionID",
      schema: z.object({
        sessionID: SessionID.zod,
        messageID: MessageID.zod,
      }),
    }),
    PartUpdated: SyncEvent.define({
      type: "message.part.updated",
      version: 1,
      aggregate: "sessionID",
      schema: z.object({
        sessionID: SessionID.zod,
        part: Part,
        time: z.number(),
      }),
    }),
    PartDelta: BusEvent.define(
      "message.part.delta",
      z.object({
        sessionID: SessionID.zod,
        messageID: MessageID.zod,
        partID: PartID.zod,
        field: z.string(),
        delta: z.string(),
      }),
    ),
    PartRemoved: SyncEvent.define({
      type: "message.part.removed",
      version: 1,
      aggregate: "sessionID",
      schema: z.object({
        sessionID: SessionID.zod,
        messageID: MessageID.zod,
        partID: PartID.zod,
      }),
    }),
  }

  export const WithParts = z.object({
    info: Info,
    parts: z.array(Part),
  })
  export type WithParts = z.infer<typeof WithParts>

  const Cursor = z.object({
    id: MessageID.zod,
    time: z.number(),
  })
  type Cursor = z.infer<typeof Cursor>

  export const cursor = {
    encode(input: Cursor) {
      return Buffer.from(JSON.stringify(input)).toString("base64url")
    },
    decode(input: string) {
      return Cursor.parse(JSON.parse(Buffer.from(input, "base64url").toString("utf8")))
    },
  }

  const info = (row: typeof MessageTable.$inferSelect) =>
    ({
      ...row.data,
      id: row.id,
      sessionID: row.session_id,
    }) as MessageV2.Info

  // ─── Read-time migration: legacy tool → execute envelope ─────────────────
  // Legacy sessions stored ToolPart with tool !== "execute" (e.g. tool="bash",
  // tool="read", etc.). The new surface collapses all tool calls through execute.
  // On read, wrap legacy parts into a synthetic execute envelope so the TUI
  // renderer (which handles tool="execute" with expanded[]) works uniformly.
  // No DB writes — pure read-time transform. Idempotent: already-execute parts
  // pass through unchanged.
  //
  // Exported for direct unit testing — tests import this function and test it
  // against the real implementation rather than an inline copy.
  export function migrateLegacyToolPart(p: MessageV2.Part): MessageV2.Part {
    return p
  }

  const part = (row: typeof PartTable.$inferSelect) => {
    const raw = {
      ...row.data,
      id: row.id,
      sessionID: row.session_id,
      messageID: row.message_id,
    } as MessageV2.Part
    return migrateLegacyToolPart(raw)
  }

  const older = (row: Cursor) =>
    or(
      lt(MessageTable.time_created, row.time),
      and(eq(MessageTable.time_created, row.time), lt(MessageTable.id, row.id)),
    )

  function hydrate(rows: (typeof MessageTable.$inferSelect)[]) {
    const ids = rows.map((row) => row.id)
    const partByMessage = new Map<string, MessageV2.Part[]>()
    if (ids.length > 0) {
      const partRows = Database.use((db) =>
        db
          .select()
          .from(PartTable)
          .where(inArray(PartTable.message_id, ids))
          .orderBy(PartTable.message_id, PartTable.id)
          .all(),
      )
      for (const row of partRows) {
        const next = part(row)
        const list = partByMessage.get(row.message_id)
        if (list) list.push(next)
        else partByMessage.set(row.message_id, [next])
      }
    }

    return rows.map((row) => ({
      info: info(row),
      parts: partByMessage.get(row.id) ?? [],
    }))
  }

  export const toModelMessagesEffect = Effect.fnUntraced(function* (
    input: WithParts[],
    model: Provider.Model,
    options?: { stripMedia?: boolean },
  ) {
    const result: UIMessage[] = []
    const toolNames = new Set<string>()
    const isGemini3 = isGemini3Model(model)
    // Track media from tool results that need to be injected as user messages
    // for providers that don't support media in tool results.
    //
    // OpenAI-compatible APIs only support string content in tool results, so we need
    // to extract media and inject as user messages. Other SDKs (anthropic, google,
    // bedrock) handle type: "content" with media parts natively.
    //
    // Only apply this workaround if the model actually supports image input -
    // otherwise there's no point extracting images.
    const supportsMediaInToolResults = (() => {
      if (model.api.npm === "@ai-sdk/anthropic") return true
      if (model.api.npm === "@ai-sdk/openai") return true
      if (model.api.npm === "@ai-sdk/amazon-bedrock") return true
      if (model.api.npm === "@ai-sdk/google-vertex/anthropic") return true
      if (model.api.npm === "@ai-sdk/google") {
        const id = model.api.id.toLowerCase()
        return id.includes("gemini-3") && !id.includes("gemini-2")
      }
      return false
    })()

    // Phase 1b — sentinel builder for microcompacted tool results. Pulls the
    // truncation file path out of the original output (written by
    // tool/truncate.ts when the result exceeded MAX_BYTES) and embeds it in
    // the cleared sentinel so the model can rehydrate the result via Read.
    // The truncation hint format is fixed at "Full output saved to: <path>"
    // (tool/truncate.ts:110-111).
    const TRUNCATION_PATH_RX = /Full output saved to:\s*(\S+)/
    const clearedSentinel = (originalOutput: string): string => {
      const match = originalOutput.match(TRUNCATION_PATH_RX)
      if (match && match[1]) {
        return `[Old tool result content cleared — full output preserved at ${match[1]}; Read it if you need the original]`
      }
      return "[Old tool result content cleared]"
    }

    const toModelOutput = (options: { toolCallId: string; input: unknown; output: unknown }) => {
      const output = options.output
      if (typeof output === "string") {
        return { type: "text", value: output }
      }

      if (typeof output === "object") {
        const outputObject = output as {
          text: string
          attachments?: Array<{ mime: string; url: string }>
        }
        const attachments = (outputObject.attachments ?? []).filter((attachment) => {
          return attachment.url.startsWith("data:") && attachment.url.includes(",")
        })

        return {
          type: "content",
          value: [
            { type: "text", text: outputObject.text },
            ...attachments.map((attachment) => ({
              type: "media",
              mediaType: attachment.mime,
              data: iife(() => {
                const commaIndex = attachment.url.indexOf(",")
                return commaIndex === -1 ? attachment.url : attachment.url.slice(commaIndex + 1)
              }),
            })),
          ],
        }
      }

      return { type: "json", value: output as never }
    }

    // Pre-pass: find the last index where a different model was used.
    // All assistant messages at or before that index are "pre-switch" — their
    // provider-scoped IDs (e.g. openai.itemId / rs_...) reference a prior
    // provider session store and must not be forwarded to the current session.
    let lastDifferentModelIdx = -1
    const currentModelKey = `${model.providerID}/${model.id}`
    for (let i = 0; i < input.length; i++) {
      const m = input[i]
      if (m.info.role === "assistant") {
        const msgModelKey = `${m.info.providerID}/${m.info.modelID}`
        if (currentModelKey !== msgModelKey) lastDifferentModelIdx = i
      }
    }

    let msgIndex = -1
    for (const msg of input) {
      msgIndex++
      if (msg.parts.length === 0) continue

      if (msg.info.role === "user") {
        const userMessage: UIMessage = {
          id: msg.info.id,
          role: "user",
          parts: [],
        }
        result.push(userMessage)
        for (const part of msg.parts) {
          if (part.type === "text" && !part.ignored)
            userMessage.parts.push({
              type: "text",
              text: part.text,
            })
          // text/plain and directory files are converted into text parts, ignore them
          if (part.type === "file" && part.mime !== "text/plain" && part.mime !== "application/x-directory") {
            if (options?.stripMedia && isMedia(part.mime)) {
              userMessage.parts.push({
                type: "text",
                text: `[Attached ${part.mime}: ${part.filename ?? "file"}]`,
              })
            } else {
              userMessage.parts.push({
                type: "file",
                url: part.url,
                mediaType: part.mime,
                filename: part.filename,
              })
            }
          }

          if (part.type === "compaction") {
            userMessage.parts.push({
              type: "text",
              text: "Produce a concise context packet from the task note and conversation above. Do not replay conversation history.",
            })
          }
          if (part.type === "subtask") {
            userMessage.parts.push({
              type: "text",
              text: "The following tool was executed by the user",
            })
          }
        }
      }

      if (msg.info.role === "assistant") {
        const differentModel = currentModelKey !== `${msg.info.providerID}/${msg.info.modelID}`
        const preSwitch = msgIndex <= lastDifferentModelIdx
        const stripProviderIds = differentModel || preSwitch
        const media: Array<{ mime: string; url: string }> = []

        if (
          msg.info.error &&
          !(
            MessageV2.AbortedError.isInstance(msg.info.error) &&
            msg.parts.some((part) => part.type !== "step-start" && part.type !== "reasoning")
          )
        ) {
          continue
        }
        const assistantMessage: UIMessage = {
          id: msg.info.id,
          role: "assistant",
          parts: [],
        }
        for (const part of msg.parts) {
          if (part.type === "text")
            assistantMessage.parts.push({
              type: "text",
              text: part.text,
              ...(stripProviderIds ? {} : { providerMetadata: sanitizeProviderMetadata(part.metadata) }),
            })
          if (part.type === "step-start")
            assistantMessage.parts.push({
              type: "step-start",
            })
          if (part.type === "tool") {
            const modelToolName = sanitizeToolNameForModel(part.tool)
            toolNames.add(modelToolName)
            if (part.state.status === "completed") {
              // Phase 1b — when this part has been microcompacted, surface
              // the on-disk truncation path (if one was written by
              // Truncate.output) inside the sentinel so the model can
              // rehydrate the result via Read instead of guessing or
              // re-running the tool. The truncation hint follows a fixed
              // "Full output saved to: <path>" format from
              // tool/truncate.ts:110-111, which we regex out of the
              // original output before substituting the sentinel.
              const outputText = part.state.time.compacted ? clearedSentinel(part.state.output) : part.state.output
              const safeOutputText = outputText || "[Tool produced no output]"
              const attachments = part.state.time.compacted || options?.stripMedia ? [] : (part.state.attachments ?? [])

              // For providers that don't support media in tool results, extract media files
              // (images, PDFs) to be sent as a separate user message
              const mediaAttachments = attachments.filter((a) => isMedia(a.mime))
              const nonMediaAttachments = attachments.filter((a) => !isMedia(a.mime))
              if (!supportsMediaInToolResults && mediaAttachments.length > 0) {
                media.push(...mediaAttachments)
              }
              const finalAttachments = supportsMediaInToolResults ? attachments : nonMediaAttachments

              const output =
                finalAttachments.length > 0
                  ? {
                      text: safeOutputText,
                      attachments: finalAttachments,
                    }
                  : safeOutputText

              const thoughtSignature = isGemini3 ? extractThoughtSignature(part.metadata) : undefined
              // callProviderMetadata is what convertToModelMessages reads for tool-call providerOptions.
              // For Gemini 3, always include at least the thought_signature even when differentModel=true.
              const toolCallProviderMetadata = buildGemini3ToolCallMetadata({
                isGemini3,
                differentModel: stripProviderIds,
                partMetadata: part.metadata,
                thoughtSignature,
              })
              assistantMessage.parts.push({
                type: ("tool-" + modelToolName) as `tool-${string}`,
                state: "output-available",
                toolCallId: part.callID,
                input: part.state.input,
                output,
                ...(toolCallProviderMetadata != null ? { callProviderMetadata: toolCallProviderMetadata } : {}),
              })
            }
            if (part.state.status === "error") {
              const thoughtSignature = isGemini3 ? extractThoughtSignature(part.metadata) : undefined
              const toolCallProviderMetadata = buildGemini3ToolCallMetadata({
                isGemini3,
                differentModel: stripProviderIds,
                partMetadata: part.metadata,
                thoughtSignature,
              })
              assistantMessage.parts.push({
                type: ("tool-" + modelToolName) as `tool-${string}`,
                state: "output-error",
                toolCallId: part.callID,
                input: part.state.input,
                errorText: part.state.error || "[Tool execution failed]",
                ...(toolCallProviderMetadata != null ? { callProviderMetadata: toolCallProviderMetadata } : {}),
              })
            }
            // Handle pending/running tool calls to prevent dangling tool_use blocks
            // Anthropic/Claude APIs require every tool_use to have a corresponding tool_result
            if (part.state.status === "pending" || part.state.status === "running") {
              const thoughtSignature = isGemini3 ? extractThoughtSignature(part.metadata) : undefined
              const toolCallProviderMetadata = buildGemini3ToolCallMetadata({
                isGemini3,
                differentModel: stripProviderIds,
                partMetadata: part.metadata,
                thoughtSignature,
              })
              assistantMessage.parts.push({
                type: ("tool-" + modelToolName) as `tool-${string}`,
                state: "output-error",
                toolCallId: part.callID,
                input: part.state.input,
                errorText: "[Tool execution was interrupted]",
                ...(toolCallProviderMetadata != null ? { callProviderMetadata: toolCallProviderMetadata } : {}),
              })
            }
          }
          if (part.type === "reasoning") {
            const thoughtSignature = isGemini3 ? extractThoughtSignature(part.metadata) : undefined
            // For Gemini 3, the thought_signature must always be present in
            // providerMetadata so convertToModelMessages forwards it to the SDK.
            // When differentModel=true the full metadata is stripped, but we
            // still need the signature — so build a minimal metadata object.
            const reasoningProviderMetadata = (() => {
              if (stripProviderIds) {
                // No full metadata, but still need the signature for Gemini 3
                return thoughtSignature ? createProviderOptions(thoughtSignature).providerOptions : undefined
              }
              return sanitizeProviderMetadata(part.metadata)
            })()
            assistantMessage.parts.push({
              type: "reasoning",
              text: part.text,
              ...(reasoningProviderMetadata != null ? { providerMetadata: reasoningProviderMetadata } : {}),
            })
          }
        }
        if (assistantMessage.parts.length > 0) {
          result.push(assistantMessage)
          // Inject pending media as a user message for providers that don't support
          // media (images, PDFs) in tool results
          if (media.length > 0) {
            result.push({
              id: MessageID.ascending(),
              role: "user",
              parts: [
                {
                  type: "text" as const,
                  text: "Attached image(s) from tool result:",
                },
                ...media.map((attachment) => ({
                  type: "file" as const,
                  url: attachment.url,
                  mediaType: attachment.mime,
                })),
              ],
            })
          }
        }
      }
    }

    const tools = Object.fromEntries(Array.from(toolNames).map((toolName) => [toolName, { toModelOutput }]))

    return yield* Effect.promise(() =>
      convertToModelMessages(
        result.filter((msg) => msg.parts.some((part) => part.type !== "step-start")),
        {
          //@ts-expect-error (convertToModelMessages expects a ToolSet but only actually needs tools[name]?.toModelOutput)
          tools,
        },
      ),
    )
  })

  export function toModelMessages(
    input: WithParts[],
    model: Provider.Model,
    options?: { stripMedia?: boolean },
  ): Promise<ModelMessage[]> {
    return Effect.runPromise(toModelMessagesEffect(input, model, options))
  }

  export function page(input: { sessionID: SessionID; limit: number; before?: string }) {
    const before = input.before ? cursor.decode(input.before) : undefined
    const where = before
      ? and(eq(MessageTable.session_id, input.sessionID), older(before))
      : eq(MessageTable.session_id, input.sessionID)
    const rows = Database.use((db) =>
      db
        .select()
        .from(MessageTable)
        .where(where)
        .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
        .limit(input.limit + 1)
        .all(),
    )
    if (rows.length === 0) {
      const row = Database.use((db) =>
        db.select({ id: SessionTable.id }).from(SessionTable).where(eq(SessionTable.id, input.sessionID)).get(),
      )
      if (!row) throw new NotFoundError({ message: `Session not found: ${input.sessionID}` })
      return {
        items: [] as MessageV2.WithParts[],
        more: false,
      }
    }

    const more = rows.length > input.limit
    const slice = more ? rows.slice(0, input.limit) : rows
    const items = hydrate(slice)
    items.reverse()
    const tail = slice.at(-1)
    return {
      items,
      more,
      cursor: more && tail ? cursor.encode({ id: tail.id, time: tail.time_created }) : undefined,
    }
  }

  export function* stream(sessionID: SessionID) {
    const size = 50
    let before: string | undefined
    while (true) {
      const next = page({ sessionID, limit: size, before })
      if (next.items.length === 0) break
      for (let i = next.items.length - 1; i >= 0; i--) {
        yield next.items[i]
      }
      if (!next.more || !next.cursor) break
      before = next.cursor
    }
  }

  export function parts(message_id: MessageID) {
    const rows = Database.use((db) =>
      db.select().from(PartTable).where(eq(PartTable.message_id, message_id)).orderBy(PartTable.id).all(),
    )
    return rows.map(
      (row) =>
        ({
          ...row.data,
          id: row.id,
          sessionID: row.session_id,
          messageID: row.message_id,
        }) as MessageV2.Part,
    )
  }

  export function get(input: { sessionID: SessionID; messageID: MessageID }): WithParts {
    const row = Database.use((db) =>
      db
        .select()
        .from(MessageTable)
        .where(and(eq(MessageTable.id, input.messageID), eq(MessageTable.session_id, input.sessionID)))
        .get(),
    )
    if (!row) throw new NotFoundError({ message: `Message not found: ${input.messageID}` })
    return {
      info: info(row),
      parts: parts(input.messageID),
    }
  }

  export function filterCompacted(msgs: Iterable<MessageV2.WithParts>) {
    const result = [] as MessageV2.WithParts[]
    const completed = new Set<string>()
    for (const msg of msgs) {
      result.push(msg)
      if (
        msg.info.role === "user" &&
        completed.has(msg.info.id) &&
        msg.parts.some((part) => part.type === "compaction")
      )
        break
      if (msg.info.role === "assistant" && msg.info.summary && msg.info.finish && !msg.info.error)
        completed.add(msg.info.parentID)
    }
    result.reverse()
    return result
  }

  export const filterCompactedEffect = Effect.fnUntraced(function* (sessionID: SessionID) {
    return filterCompacted(stream(sessionID))
  })

  export function fromError(e: unknown, ctx: { providerID: ProviderID; aborted?: boolean }): AssistantError {
    const parsed: NamedErrorObject<unknown> = (() => {
      switch (true) {
        case e instanceof DOMException && e.name === "AbortError":
          return new MessageV2.AbortedError(
            { message: e.message },
            {
              cause: e,
            },
          ).toObject()
        case MessageV2.OutputLengthError.isInstance(e):
          return e
        case LoadAPIKeyError.isInstance(e):
          return new MessageV2.AuthError(
            {
              providerID: ctx.providerID,
              message: e.message,
            },
            { cause: e },
          ).toObject()
        case (e as SystemError)?.code === "ECONNRESET":
          return new MessageV2.APIError(
            {
              message: "Connection reset by server",
              isRetryable: true,
              metadata: {
                code: (e as SystemError).code ?? "",
                syscall: (e as SystemError).syscall ?? "",
                message: (e as SystemError).message ?? "",
              },
            },
            { cause: e },
          ).toObject()
        case e instanceof Error && (e as FetchDecompressionError).code === "ZlibError":
          if (ctx.aborted) {
            return new MessageV2.AbortedError({ message: e.message }, { cause: e }).toObject()
          }
          return new MessageV2.APIError(
            {
              message: "Response decompression failed",
              isRetryable: true,
              metadata: {
                code: (e as FetchDecompressionError).code,
                message: e.message,
              },
            },
            { cause: e },
          ).toObject()
        case APICallError.isInstance(e):
          const apiError = ProviderError.parseAPICallError({
            providerID: ctx.providerID,
            error: e,
          })
          if (apiError.type === "context_overflow") {
            return new MessageV2.ContextOverflowError(
              {
                message: apiError.message,
                responseBody: apiError.responseBody,
              },
              { cause: e },
            ).toObject()
          }

          return new MessageV2.APIError(
            {
              message: apiError.message,
              statusCode: apiError.statusCode,
              isRetryable: apiError.isRetryable,
              responseHeaders: apiError.responseHeaders,
              responseBody: apiError.responseBody,
              metadata: apiError.metadata,
            },
            { cause: e },
          ).toObject()
        case e instanceof Error:
          return new NamedError.Unknown({ message: errorMessage(e) }, { cause: e }).toObject()
        default:
          try {
            const streamError = ProviderError.parseStreamError(e)
            if (streamError) {
              if (streamError.type === "context_overflow") {
                return new MessageV2.ContextOverflowError(
                  {
                    message: streamError.message,
                    responseBody: streamError.responseBody,
                  },
                  { cause: e },
                ).toObject()
              }
              return new MessageV2.APIError(
                {
                  message: streamError.message,
                  isRetryable: streamError.isRetryable,
                  responseBody: streamError.responseBody,
                },
                {
                  cause: e,
                },
              ).toObject()
            }
          } catch {}
          return new NamedError.Unknown({ message: JSON.stringify(e) }, { cause: e }).toObject()
      }
    })()

    return AssistantError.parse(parsed)
  }
}
