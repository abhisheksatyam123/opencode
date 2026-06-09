import path from "path"
import os from "os"
import { createReadStream } from "fs"
import * as fs from "fs/promises"
import { createInterface } from "readline"
import z from "zod"
import { SessionID, MessageID, PartID } from "@/process/session/schema"
import { MessageV2 } from "@/process/session/message-v2"
import { Log } from "@/foundation/util/log"
import { SessionRevert } from "@/process/session/revert"
import { Session } from "@/process/session"
import { Agent } from "@/agent/agent"
import { RuntimeRoles } from "@/agent/runtime-roles"
import { AgentRoles } from "@/agent/agent-roles"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { type Tool as AITool, tool, jsonSchema, type ToolExecutionOptions } from "ai"
import { SessionCompaction } from "@/process/session/compaction"
import { Instance } from "@/config/project/instance"
import { Bus } from "@/bus"
import { ProviderTransform } from "@/provider/transform"
import { SystemPrompt } from "@/process/session/system"
import { ProviderPluginHooks } from "@/provider/plugin-hooks"
import { ToolRegistry } from "@/tool/registry"
import { Runner } from "@/foundation/effect/runner"
import { Concurrency } from "@/tool/concurrency"
import { ConcurrencyLock } from "@/tool/concurrency-lock"
import { FileTime } from "@/filesystem/file/time"
import { Flag } from "@/foundation/flag/flag"
import { ulid } from "ulid"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import * as CrossSpawnSpawner from "@/foundation/effect/cross-spawn-spawner"
import * as Stream from "effect/Stream"
import { Command } from "@/surface/command"
import { pathToFileURL, fileURLToPath } from "url"
import { ConfigMarkdown } from "@/config/markdown"
import { SessionSummary } from "@/process/session/summary"
import { NamedError } from "@opencode-ai/util/error"
import { SessionProcessor } from "@/process/session/processor"
import { subtaskTaskArgs } from "@/process/session/subtask-task-args"
import { TaskTool } from "@/tool/task"
import { Tool } from "@/tool/tool"
import { Permission } from "@/permission"
import { SessionStatus } from "@/process/session/status"
import { LLM } from "@/process/session/llm"
import { Config } from "@/config/config"
import { markPacketStale } from "@/process/session/context-packet"
import { CacheBreakDetector } from "@/provider/cache-break-detector"
import { TokenBudget } from "@/process/session/token-budget"
import { TrajectoryRegulator } from "@/process/session/trajectory-regulator"
import { TokenEstimate } from "@/process/session/token-estimate"
import { ModelRouter } from "@/provider/model-router"
import { Shell } from "@/filesystem/shell/shell"
import { AppFileSystem } from "@/filesystem"
import { Truncate } from "@/tool/truncate"
import { decodeDataUrl } from "@/foundation/util/data-url"
import { Process } from "@/foundation/util/process"
import { Cause, Effect, Exit, Layer, Option, Scope, ServiceMap } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { InstanceState } from "@/foundation/effect/instance-state"
import { makeRuntime } from "@/foundation/effect/run-service"

// See: https://github.com/vercel/ai/blob/main/packages/ai/src/logger/log-warnings.ts
globalThis.AI_SDK_LOG_WARNINGS = false

const SESSION_PROMPTS = {
  plan: "Plan mode: keep the active TODO current and concise.",
  "max-steps": "Max steps hit. No tools. Text only.\nSay: max steps reached, what done, what left, next step.",
} as const

type SessionPromptKey = keyof typeof SESSION_PROMPTS

/** Resolve runtime session prompts from bundled code only. */
async function loadSessionPrompt(key: string): Promise<string> {
  const prompt = SESSION_PROMPTS[key as SessionPromptKey]
  if (!prompt) throw new Error(`missing bundled session prompt: ${key}`)
  return prompt
}

const STRUCTURED_OUTPUT_DESCRIPTION = `Use this tool to return your final response in the requested structured format.

IMPORTANT:
- You MUST call this tool exactly once at the end of your response
- The input must be valid JSON matching the required schema
- Complete all necessary research and tool calls BEFORE calling this tool
- This tool provides your final answer - no further actions are taken after calling it`

const STRUCTURED_OUTPUT_SYSTEM_PROMPT = `IMPORTANT: The user has requested structured output. You MUST use the StructuredOutput tool to provide your final response. Respond using the StructuredOutput tool with your answer formatted according to the schema — plain text responses are rejected.`

const ATTACHMENT_READ_DEFAULT_LIMIT = Number.MAX_SAFE_INTEGER
const ATTACHMENT_READ_MAX_LINE_LENGTH = 300
const ATTACHMENT_READ_MAX_BYTES = 4 * 1024
const ATTACHMENT_READ_MAX_BYTES_LABEL = `${ATTACHMENT_READ_MAX_BYTES / 1024} KB`
const ATTACHMENT_READ_MAX_LINE_SUFFIX = `... (line truncated to ${ATTACHMENT_READ_MAX_LINE_LENGTH} chars)`
const ATTACHMENT_BLOCKED_DEVICE_PATHS = new Set([
  "/dev/zero",
  "/dev/random",
  "/dev/urandom",
  "/dev/full",
  "/dev/stdin",
  "/dev/tty",
  "/dev/console",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/fd/0",
  "/dev/fd/1",
  "/dev/fd/2",
])

function isBlockedAttachmentPath(filepath: string): boolean {
  if (ATTACHMENT_BLOCKED_DEVICE_PATHS.has(filepath)) return true
  return (
    filepath.startsWith("/proc/") &&
    (filepath.endsWith("/fd/0") || filepath.endsWith("/fd/1") || filepath.endsWith("/fd/2"))
  )
}

async function missingAttachmentMessage(filepath: string): Promise<string> {
  const dir = path.dirname(filepath)
  const base = path.basename(filepath)
  const matches = await fs
    .readdir(dir)
    .then((items) =>
      items
        .filter(
          (item) => item.toLowerCase().includes(base.toLowerCase()) || base.toLowerCase().includes(item.toLowerCase()),
        )
        .map((item) => path.join(dir, item))
        .slice(0, 3),
    )
    .catch(() => [] as string[])
  return matches.length > 0
    ? `File not found: ${filepath}\n\nDid you mean one of these?\n${matches.join("\n")}`
    : `File not found: ${filepath}`
}

function sliceAttachmentEntries(items: string[], start: number, explicitLimit?: number) {
  const entries: string[] = []
  let chars = 0

  for (let i = start; i < items.length; i++) {
    if (explicitLimit !== undefined && entries.length >= explicitLimit) return { entries, budgetCut: false }

    const entry = items[i]!
    const added = (entries.length > 0 ? 1 : 0) + entry.length
    if (chars + added > ATTACHMENT_READ_MAX_BYTES) return { entries, budgetCut: true }

    entries.push(entry)
    chars += added
  }

  return { entries, budgetCut: false }
}

async function listAttachmentDirectory(filepath: string, opts: { offset?: number; limit?: number } = {}) {
  const entries = await fs.readdir(filepath, { withFileTypes: true })
  const items = await Promise.all(
    entries.map(async (entry) => {
      if (entry.isDirectory()) return `${entry.name}/`
      if (!entry.isSymbolicLink()) return entry.name
      const target = await fs.stat(path.join(filepath, entry.name)).catch(() => undefined)
      return target?.isDirectory() ? `${entry.name}/` : entry.name
    }),
  )
  items.sort((a, b) => a.localeCompare(b))
  const offset = opts.offset ?? 1
  if (offset < 1) throw new Error("offset must be >= 1")
  const start = offset - 1
  const { entries: sliced, budgetCut } = sliceAttachmentEntries(items, start, opts.limit)
  const truncated = budgetCut || start + sliced.length < items.length
  return [
    `<path>${filepath}</path>`,
    `<type>directory</type>`,
    `<entries>`,
    sliced.join("\n"),
    truncated
      ? `\n(Showing ${sliced.length} of ${items.length} entries. Use offset=${offset + sliced.length} to continue.)`
      : `\n(${items.length} entries)`,
    `</entries>`,
  ].join("\n")
}

async function isBinaryAttachmentFile(filepath: string, fileSize: number): Promise<boolean> {
  switch (path.extname(filepath).toLowerCase()) {
    case ".zip":
    case ".tar":
    case ".gz":
    case ".exe":
    case ".dll":
    case ".so":
    case ".class":
    case ".jar":
    case ".war":
    case ".7z":
    case ".doc":
    case ".docx":
    case ".xls":
    case ".xlsx":
    case ".ppt":
    case ".pptx":
    case ".odt":
    case ".ods":
    case ".odp":
    case ".bin":
    case ".dat":
    case ".obj":
    case ".o":
    case ".a":
    case ".lib":
    case ".wasm":
    case ".pyc":
    case ".pyo":
      return true
    default:
      break
  }
  if (fileSize === 0) return false
  const handle = await fs.open(filepath, "r")
  try {
    const sampleSize = Math.min(4096, fileSize)
    const bytes = Buffer.alloc(sampleSize)
    const result = await handle.read(bytes, 0, sampleSize, 0)
    if (result.bytesRead === 0) return false
    let nonPrintable = 0
    for (let i = 0; i < result.bytesRead; i++) {
      if (bytes[i] === 0) return true
      if (bytes[i]! < 9 || (bytes[i]! > 13 && bytes[i]! < 32)) nonPrintable++
    }
    return nonPrintable / result.bytesRead > 0.3
  } finally {
    await handle.close()
  }
}

async function readAttachmentLines(filepath: string, opts: { limit: number; offset: number }) {
  const stream = createReadStream(filepath, { encoding: "utf8" })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  const start = opts.offset - 1
  const raw: string[] = []
  let bytes = 0
  let count = 0
  let cut = false
  let more = false

  try {
    for await (const text of lines) {
      count += 1
      if (count <= start) continue
      if (raw.length >= opts.limit) {
        more = true
        continue
      }
      const line =
        text.length > ATTACHMENT_READ_MAX_LINE_LENGTH
          ? text.substring(0, ATTACHMENT_READ_MAX_LINE_LENGTH) + ATTACHMENT_READ_MAX_LINE_SUFFIX
          : text
      const size = Buffer.byteLength(line, "utf-8") + (raw.length > 0 ? 1 : 0)
      if (bytes + size > ATTACHMENT_READ_MAX_BYTES) {
        cut = true
        more = true
        break
      }
      raw.push(line)
      bytes += size
    }
  } finally {
    lines.close()
    stream.destroy()
  }

  return { raw, count, cut, more, offset: opts.offset }
}

async function loadAttachmentFile(filepath: string, opts: { offset?: number; limit?: number }) {
  if (opts.offset !== undefined && opts.offset < 1) throw new Error("offset must be >= 1")
  if (isBlockedAttachmentPath(filepath)) {
    throw new Error(`Cannot read '${filepath}': device file would block or produce infinite output.`)
  }

  const stat = await fs.stat(filepath).catch(async (error: any) => {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") throw new Error(await missingAttachmentMessage(filepath))
    throw error
  })

  if (stat.isDirectory()) return listAttachmentDirectory(filepath, opts)
  if (await isBinaryAttachmentFile(filepath, stat.size)) throw new Error(`Cannot read binary file: ${filepath}`)

  const file = await readAttachmentLines(filepath, {
    limit: opts.limit ?? ATTACHMENT_READ_DEFAULT_LIMIT,
    offset: opts.offset ?? 1,
  })
  if (file.count < file.offset && !(file.count === 0 && file.offset === 1)) {
    throw new Error(`Offset ${file.offset} is out of range for this file (${file.count} lines)`)
  }

  const last = file.offset + file.raw.length - 1
  const next = last + 1
  const output = [`<path>${filepath}</path>`, `<type>file</type>`, "<content>\n"].join("\n")
  let content = output + file.raw.map((line, index) => `${index + file.offset}: ${line}`).join("\n")

  if (file.cut) {
    content +=
      `\n\n(Read output exceeded the ${ATTACHMENT_READ_MAX_BYTES_LABEL} context budget at ${ATTACHMENT_READ_MAX_BYTES} characters. ` +
      `Lines ${file.offset}-${last} were scanned. Use offset=${next} to continue.)`
  } else if (file.more) {
    content += `\n\n(Lines ${file.offset}-${last} of ${file.count}. Use offset=${next} to continue.)`
  } else {
    content += `\n\n(End of file — ${file.count} lines)`
  }
  return `${content}\n</content>`
}

export namespace SessionPrompt {
  const log = Log.create({ service: "session.prompt" })
  export const AUTONOMOUS_MARKER = "<opencode:loop-autonomous>"
  // Loop-session title is derived from the RuntimeRoles role key — not from a
  // hardcoded agent name. The label format `Loop session - <role>` lets the
  // role binding (cfg.runtime_roles[role]) change the actual agent without
  // changing the display label, and adding a new role only requires extending
  // the RuntimeRoles enum, not editing this map.
  type LoopRole = Extract<RuntimeRoles.Role, "user-proxy" | "halt-auditor">
  function loopTitle(role: LoopRole): string {
    return `Loop session - ${role}`
  }

  const linked = Instance.state(() => new Map<string, SessionID>())

  function linkedKey(rootID: SessionID, agent: LoopRole) {
    return `${rootID}:${agent}`
  }

  function hasAutonomousMarker(parts: MessageV2.Part[]) {
    return parts.some(
      (part) => part.type === "text" && part.synthetic && part.ignored && part.text.trim() === AUTONOMOUS_MARKER,
    )
  }

  type LoopHistory = {
    lastUser: MessageV2.User
    lastUserWithParts: MessageV2.WithParts
    lastAssistant?: MessageV2.Assistant
    lastFinished?: MessageV2.Assistant
    tasks: (MessageV2.CompactionPart | MessageV2.SubtaskPart)[]
  }

  type ModelFallback = { providerID: ProviderID; modelID: ModelID }

  function scanLoopHistory(msgs: MessageV2.WithParts[]): LoopHistory {
    let lastUser: MessageV2.User | undefined
    let lastUserWithParts: MessageV2.WithParts | undefined
    let lastAssistant: MessageV2.Assistant | undefined
    let lastFinished: MessageV2.Assistant | undefined
    const tasks: (MessageV2.CompactionPart | MessageV2.SubtaskPart)[] = []

    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i]
      if (!lastUser && msg.info.role === "user") {
        lastUser = msg.info as MessageV2.User
        lastUserWithParts = msg
      }
      if (!lastAssistant && msg.info.role === "assistant") lastAssistant = msg.info as MessageV2.Assistant
      if (!lastFinished && msg.info.role === "assistant" && msg.info.finish)
        lastFinished = msg.info as MessageV2.Assistant
      if (lastUser && lastFinished) break
      const task = msg.parts.filter((part) => part.type === "compaction" || part.type === "subtask")
      if (task && !lastFinished) tasks.push(...task)
    }

    if (!lastUser || !lastUserWithParts) throw new Error("No user message found in stream. This should never happen.")
    return { lastUser, lastUserWithParts, lastAssistant, lastFinished, tasks }
  }

  function providerAffineUniqueFallbacks(input: {
    model: Provider.Model
    routed: ModelFallback[]
    statics: ModelFallback[]
  }): ModelFallback[] {
    const seen = new Set<string>()
    return [...input.routed, ...input.statics].filter((fallback) => {
      if (fallback.providerID !== input.model.providerID) return false
      const key = `${fallback.providerID}/${fallback.modelID}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  function resolveModelFallbacks(input: { model: Provider.Model; agent: Agent.Info; config: Config.Info }) {
    return Effect.gen(function* () {
      const currentModelKey = `${input.model.providerID}/${input.model.id}`
      const routed = input.config.model_routing
        ? yield* Effect.promise(async () => {
            const ranked = await ModelRouter.select({ agentName: input.agent.name, config: input.config })
            const out: ModelFallback[] = []
            const seen = new Set<string>()
            for (const candidate of ranked) {
              const key = `${candidate.providerID}/${candidate.modelID}`
              if (key === currentModelKey || seen.has(key)) continue
              seen.add(key)
              out.push({ providerID: candidate.providerID, modelID: candidate.modelID })
            }
            return out
          }).pipe(Effect.orElseSucceed((): ModelFallback[] => []))
        : []
      const statics = (input.agent.models?.slice(1) ?? []).filter(
        (fallback) => `${fallback.providerID}/${fallback.modelID}` !== currentModelKey,
      )
      return providerAffineUniqueFallbacks({ model: input.model, routed, statics })
    })
  }

  async function markAutonomous(input: { sessionID: SessionID; messageID: MessageID }) {
    await Session.updatePart({
      id: PartID.ascending(),
      messageID: input.messageID,
      sessionID: input.sessionID,
      type: "text",
      text: AUTONOMOUS_MARKER,
      synthetic: true,
      ignored: true,
    } satisfies MessageV2.TextPart)
  }

  async function ensureLoopSession(input: {
    rootID: SessionID
    agent: LoopRole
    user: MessageV2.User
  }): Promise<Session.Info> {
    const map = linked()
    const key = linkedKey(input.rootID, input.agent)
    const known = map.get(key)
    if (known) {
      const item = await Session.get(known).catch(() => null)
      if (item) return item
      map.delete(key)
    }
    const title = loopTitle(input.agent)
    const child = (await Session.children(input.rootID)).find((item) => item.title === title)
    if (child) {
      map.set(key, child.id)
      return child
    }
    const created = await Session.create({
      parentID: input.rootID,
      title,
    })
    map.set(key, created.id)
    const seed: MessageV2.User = {
      id: MessageID.ascending(),
      sessionID: created.id,
      role: "user",
      time: { created: Date.now() },
      agent: input.agent,
      model: input.user.model,
    }
    await Session.updateMessage(seed)
    await markAutonomous({
      sessionID: created.id,
      messageID: seed.id,
    })
    return created
  }

  async function appendLoopReview(input: {
    rootID?: SessionID
    agent: LoopRole
    user: MessageV2.User
    model: { providerID: ProviderID; modelID: ModelID }
    req: Record<string, unknown>
    res: Record<string, string>
  }) {
    if (!input.rootID) return
    const session = await ensureLoopSession({
      rootID: input.rootID,
      agent: input.agent,
      user: input.user,
    })
    const req = JSON.stringify(input.req, null, 2)
    const res = JSON.stringify(input.res)
    const u: MessageV2.User = {
      id: MessageID.ascending(),
      sessionID: session.id,
      role: "user",
      time: { created: Date.now() },
      agent: input.agent,
      model: input.user.model,
    }
    await Session.updateMessage(u)
    await Session.updatePart({
      id: PartID.ascending(),
      messageID: u.id,
      sessionID: session.id,
      type: "text",
      text: `Auto review request:\n${req}`,
    } satisfies MessageV2.TextPart)

    const a: MessageV2.Assistant = {
      id: MessageID.ascending(),
      parentID: u.id,
      sessionID: session.id,
      role: "assistant",
      mode: input.agent,
      agent: input.agent,
      path: {
        cwd: Instance.directory,
        root: Instance.worktree,
      },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      modelID: input.model.modelID,
      providerID: input.model.providerID,
      finish: "stop",
      time: {
        created: Date.now(),
        completed: Date.now(),
      },
    }
    await Session.updateMessage(a)
    await Session.updatePart({
      id: PartID.ascending(),
      messageID: a.id,
      sessionID: session.id,
      type: "text",
      text: res,
    } satisfies MessageV2.TextPart)
    await Session.touch(session.id).catch(() => null)
  }

  async function pickLoopModel(user: MessageV2.User) {
    return Provider.getSmallModel(user.model.providerID)
      .catch(() => undefined)
      .then((model) => model ?? Provider.getModel(user.model.providerID, user.model.modelID).catch(() => undefined))
  }

  function mergeLoopInstruction(input: { proxy: string; supervisor: string }) {
    const out: string[] = []
    for (const item of [input.supervisor.trim(), input.proxy.trim()]) {
      if (!item) continue
      if (out.some((x) => x.toLowerCase() === item.toLowerCase())) continue
      out.push(item)
    }
    return out.join("\n")
  }

  async function injectNextTodoDirective(input: {
    sessionID: SessionID
    user: MessageV2.User
    item: string
  }): Promise<void> {
    const n: MessageV2.User = {
      id: MessageID.ascending(),
      sessionID: input.sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: input.user.agent,
      model: input.user.model,
    }
    await Session.updateMessage(n)
    await Session.updatePart({
      id: PartID.ascending(),
      messageID: n.id,
      sessionID: input.sessionID,
      type: "text",
      text: `Next TODO: ${input.item}`,
      synthetic: true,
    } satisfies MessageV2.TextPart)
    await markAutonomous({
      sessionID: input.sessionID,
      messageID: n.id,
    })
  }

  async function injectStallBreakDirective(input: {
    sessionID: SessionID
    user: MessageV2.User
    item: string
    stallTurns: number
    orchestrator: boolean
    delegationAllowed: boolean
  }): Promise<void> {
    const n: MessageV2.User = {
      id: MessageID.ascending(),
      sessionID: input.sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: input.user.agent,
      model: input.user.model,
    }
    await Session.updateMessage(n)
    await Session.updatePart({
      id: PartID.ascending(),
      messageID: n.id,
      sessionID: input.sessionID,
      type: "text",
      text: `Still on TODO after ${input.stallTurns} turns: ${input.item}. Split, unblock, delegate, or move to the next clear task.`,
      synthetic: true,
    } satisfies MessageV2.TextPart)
    await markAutonomous({
      sessionID: input.sessionID,
      messageID: n.id,
    })
  }

  async function injectUserProxyDirective(input: {
    sessionID: SessionID
    user: MessageV2.User
    item: string
    doneCriteria?: string
    instruction: string
    orchestrator: boolean
    delegationAllowed: boolean
  }): Promise<void> {
    const n: MessageV2.User = {
      id: MessageID.ascending(),
      sessionID: input.sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: input.user.agent,
      model: input.user.model,
    }
    await Session.updateMessage(n)
    await Session.updatePart({
      id: PartID.ascending(),
      messageID: n.id,
      sessionID: input.sessionID,
      type: "text",
      text: [
        input.instruction,
        `Current TODO: ${input.item}${input.doneCriteria ? `. Done: ${input.doneCriteria}` : ""}`,
      ].join("\n"),
      synthetic: true,
    } satisfies MessageV2.TextPart)
    await markAutonomous({
      sessionID: input.sessionID,
      messageID: n.id,
    })
  }

  function isLikelyTrueBlocker(text: string): boolean {
    const src = (text || "").toLowerCase()
    if (!src.trim()) return false
    const signals = [
      "need your decision",
      "which option",
      "missing credential",
      "missing credentials",
      "api key",
      "token",
      "permission denied",
      "blocked on",
      "need approval",
      "require user input",
      "waiting for your",
    ]
    return signals.some((s) => src.includes(s))
  }

  function shouldEscalateAskUser(input: {
    actionableHas: boolean
    rawDecision?: string
    assistantOutput: string
    proxyInstruction?: string
  }): boolean {
    if (input.rawDecision !== "ask_user") return false
    if (!input.actionableHas) return false
    return isLikelyTrueBlocker(input.assistantOutput) || isLikelyTrueBlocker(input.proxyInstruction ?? "")
  }

  function buildRecentHistoryContext(msgs: MessageV2.WithParts[], limit = 6): string {
    const chunks: string[] = []
    for (let i = msgs.length - 1; i >= 0 && chunks.length < limit; i--) {
      const m = msgs[i]
      const txt = m.parts
        .filter((p): p is MessageV2.TextPart => p.type === "text")
        .filter((p) => !p.synthetic)
        .map((p) => p.text.trim())
        .filter(Boolean)
        .join("\n")
      if (!txt) continue
      chunks.push(`${m.info.role}: ${txt.slice(0, 500)}`)
    }
    return chunks.reverse().join("\n---\n")
  }

  async function runUserProxyIntervention(input: {
    sessionID: SessionID
    user: MessageV2.User
    rootID?: SessionID
    assistantOutput: string
    historyContext?: string
    actionable: { has: boolean; item: string; doneCriteria?: string }
  }): Promise<{ decision: "continue" | "ask_user" | "skip"; instruction: string }> {
    const fallback = (reason: string): { decision: "continue" | "ask_user" | "skip"; instruction: string } => {
      log.info("user-proxy: using fallback", { reason, has: input.actionable.has })
      return {
        decision: input.actionable.has ? "continue" : "skip",
        instruction: input.actionable.has
          ? "Actionable todo remains. Continue execution now without requesting permission."
          : "No actionable todo remains.",
      }
    }

    // Resolve via RuntimeRoles binding (cfg.runtime_roles["user-proxy"] → name).
    // Defaults to "user-proxy" — preserves prior behavior.
    const agent = await RuntimeRoles.get("user-proxy")
    if (!agent) return fallback("no-agent")

    const model = await pickLoopModel(input.user)

    if (!model) return fallback("no-model")

    log.info("user-proxy: running LLM intervention", {
      sessionID: input.sessionID,
      item: input.actionable.item,
      modelID: model.id,
      providerID: model.providerID,
    })

    const req = {
      actionable: input.actionable,
      todo_context: {
        current_item: input.actionable.item,
        done_criteria: input.actionable.doneCriteria ?? "",
      },
      recent_history: input.historyContext || "",
      assistant_output: input.assistantOutput || "",
    }

    let txt = ""
    try {
      const result = await LLM.stream({
        agent,
        user: input.user,
        // NOTE: agent.prompt (user-proxy.txt) is already loaded by LLM.stream as the base system prompt.
        // This system array is appended AFTER agent.prompt — keep it minimal and non-contradictory.
        // The full rules (fan-out, keep-delegating, ask_user gate) live in user-proxy.txt.
        system: [
          'Return ONLY valid JSON with exactly two keys: decision ("continue"|"ask_user"|"skip") and instruction (string).',
          "No markdown. No explanation. No extra keys.",
        ],
        small: true,
        tools: {},
        model,
        abort: new AbortController().signal,
        sessionID: input.sessionID,
        retries: 1,
        messages: [
          {
            role: "user",
            content: JSON.stringify(req),
          },
        ],
      })
      txt = await Promise.resolve(result.text).catch((err: unknown) => {
        log.warn("user-proxy: stream text failed", { error: String(err) })
        return ""
      })
    } catch (err) {
      log.warn("user-proxy: LLM.stream failed", { error: String(err) })
      return fallback("llm-error")
    }

    log.info("user-proxy: LLM response", { sessionID: input.sessionID, txt: txt.slice(0, 200) })

    let parsed: { decision?: string; instruction?: string } | null = null
    try {
      const match = txt.match(/\{[\s\S]*\}/)
      parsed = match ? JSON.parse(match[0]) : null
    } catch (err) {
      log.warn("user-proxy: JSON parse failed", { txt: txt.slice(0, 200), error: String(err) })
    }

    const rawDecision = parsed?.decision
    const decision: "continue" | "ask_user" | "skip" = shouldEscalateAskUser({
      actionableHas: input.actionable.has,
      rawDecision,
      assistantOutput: input.assistantOutput,
      proxyInstruction: parsed?.instruction,
    })
      ? "ask_user"
      : rawDecision === "skip" && !input.actionable.has
        ? "skip"
        : "continue"
    const instruction =
      typeof parsed?.instruction === "string" && parsed.instruction.trim()
        ? parsed.instruction.trim()
        : decision === "continue"
          ? "Actionable todo remains. Continue execution now without requesting permission."
          : decision === "ask_user"
            ? "True blocker detected. Ask the user one concrete question for the missing input, then continue autonomously."
            : "No actionable todo remains."

    await appendLoopReview({
      rootID: input.rootID,
      agent: "user-proxy",
      user: input.user,
      model: {
        providerID: model.providerID,
        modelID: model.id,
      },
      req,
      res: { decision, instruction },
    }).catch(() => null)

    log.info("user-proxy: decision", { sessionID: input.sessionID, decision, instruction: instruction.slice(0, 100) })
    return { decision, instruction }
  }

  async function runHaltAuditorIntervention(input: {
    sessionID: SessionID
    user: MessageV2.User
    rootID?: SessionID
    assistantOutput: string
    historyContext?: string
    actionable: { has: boolean; item: string; doneCriteria?: string }
  }): Promise<{ decision: "continue" | "approve"; instruction: string }> {
    const fallback = (reason: string): { decision: "continue" | "approve"; instruction: string } => {
      log.info("halt-auditor: using fallback", { reason, has: input.actionable.has })
      return {
        decision: input.actionable.has ? "continue" : "approve",
        instruction: input.actionable.has
          ? "Actionable todo remains. Continue immediately without asking permission."
          : "No actionable todo remains. Halt approved.",
      }
    }

    // Resolve via RuntimeRoles binding (cfg.runtime_roles["halt-auditor"] → name).
    // Defaults to "halt-auditor" — preserves prior behavior.
    const agent = await RuntimeRoles.get("halt-auditor")
    if (!agent) return fallback("no-agent")

    const model = await pickLoopModel(input.user)
    if (!model) return fallback("no-model")

    const req = {
      actionable: input.actionable,
      todo_context: {
        current_item: input.actionable.item,
        done_criteria: input.actionable.doneCriteria ?? "",
      },
      recent_history: input.historyContext || "",
      assistant_output: input.assistantOutput || "",
    }

    let txt = ""
    try {
      const result = await LLM.stream({
        agent,
        user: input.user,
        system: [
          'Return ONLY valid JSON with exactly two keys: decision ("approve"|"continue") and instruction (string).',
          "No markdown. No explanation. No extra keys.",
        ],
        small: true,
        tools: {},
        model,
        abort: new AbortController().signal,
        sessionID: input.sessionID,
        retries: 1,
        messages: [
          {
            role: "user",
            content: JSON.stringify(req),
          },
        ],
      })
      txt = await Promise.resolve(result.text).catch((err: unknown) => {
        log.warn("halt-auditor: stream text failed", { error: String(err) })
        return ""
      })
    } catch (err) {
      log.warn("halt-auditor: LLM.stream failed", { error: String(err) })
      return fallback("llm-error")
    }

    log.info("halt-auditor: LLM response", { sessionID: input.sessionID, txt: txt.slice(0, 200) })

    let parsed: { decision?: string; instruction?: string } | null = null
    try {
      const match = txt.match(/\{[\s\S]*\}/)
      parsed = match ? JSON.parse(match[0]) : null
    } catch (err) {
      log.warn("halt-auditor: JSON parse failed", { txt: txt.slice(0, 200), error: String(err) })
    }

    const decision: "continue" | "approve" =
      parsed?.decision === "approve" && !input.actionable.has ? "approve" : "continue"
    const instruction =
      typeof parsed?.instruction === "string" && parsed.instruction.trim()
        ? parsed.instruction.trim()
        : decision === "continue"
          ? "Actionable todo remains. Continue immediately without asking permission."
          : "No actionable todo remains. Halt approved."

    await appendLoopReview({
      rootID: input.rootID,
      agent: "halt-auditor",
      user: input.user,
      model: {
        providerID: model.providerID,
        modelID: model.id,
      },
      req,
      res: { decision, instruction },
    }).catch(() => null)

    log.info("halt-auditor: decision", { sessionID: input.sessionID, decision, instruction: instruction.slice(0, 100) })
    return { decision, instruction }
  }

  function textFromParts(parts: MessageV2.Part[]): string {
    return parts
      .filter((p): p is MessageV2.TextPart => p.type === "text")
      .map((p) => p.text)
      .join("\n")
      .trim()
  }

  async function suppressAssistantStopMessage(input: { sessionID: SessionID; messageID: MessageID }): Promise<void> {
    await Session.removeMessage({
      sessionID: input.sessionID,
      messageID: input.messageID,
    }).catch(() => null)
  }

  async function getActionableTodo(
    _sessionID: SessionID,
  ): Promise<{ has: boolean; item: string; doneCriteria: string }> {
    // Hidden task parsing/autocontinue is intentionally disabled. Agents should
    // inspect task files explicitly with bash and continue only from visible
    // conversation/tool state, not from an implicit task-note parser.
    return { has: false, item: "", doneCriteria: "" }
  }

  async function shouldAutocontinue(input: {
    sessionID: SessionID
    messageID: MessageID
    autoTurns: number
    maxAutoTurns: number
  }): Promise<{ next: boolean; why: string }> {
    const actionable = await getActionableTodo(input.sessionID)
    if (!actionable.has) return { next: false, why: "no-actionable" }
    if (input.autoTurns >= input.maxAutoTurns) return { next: false, why: "max_auto_turns" }
    return { next: true, why: "actionable-remaining" }
  }

  export const __test = {
    AUTONOMOUS_MARKER,
    hasAutonomousMarker,
    mergeLoopInstruction,
    ensureLoopSession,
    shouldAutocontinue,
    injectNextTodoDirective,
    injectUserProxyDirective,
    runUserProxyIntervention,
    runHaltAuditorIntervention,
    isLikelyTrueBlocker,
    shouldEscalateAskUser,
    injectStallBreakDirective,
    suppressAssistantStopMessage,
    normalizeItem: (s: string) =>
      s
        .replace(/^-\s*\[[\s\S]\]\s*/, "")
        .replace(/\[[^\]]*\]/g, "")
        .trim(),
  }

  export interface Interface {
    readonly assertNotBusy: (sessionID: SessionID) => Effect.Effect<void, Session.BusyError>
    readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
    readonly prompt: (input: PromptInput) => Effect.Effect<MessageV2.WithParts>
    readonly loop: (input: { sessionID: SessionID; loopMode?: boolean }) => Effect.Effect<MessageV2.WithParts>
    readonly shell: (input: ShellInput) => Effect.Effect<MessageV2.WithParts>
    readonly command: (input: CommandInput) => Effect.Effect<MessageV2.WithParts>
    readonly resolvePromptParts: (template: string) => Effect.Effect<PromptInput["parts"]>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/SessionPrompt") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const status = yield* SessionStatus.Service
      const sessions = yield* Session.Service
      const agents = yield* Agent.Service
      const provider = yield* Provider.Service
      const processor = yield* SessionProcessor.Service
      const compaction = yield* SessionCompaction.Service
      const commands = yield* Command.Service
      const permission = yield* Permission.Service
      const fsys = yield* AppFileSystem.Service
      const filetime = yield* FileTime.Service
      const registry = yield* ToolRegistry.Service
      const truncate = yield* Truncate.Service
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const scope = yield* Scope.Scope

      const state = yield* InstanceState.make(
        Effect.fn("SessionPrompt.state")(function* () {
          const runners = new Map<string, Runner<MessageV2.WithParts>>()
          yield* Effect.addFinalizer(
            Effect.fnUntraced(function* () {
              yield* Effect.forEach(runners.values(), (r) => r.cancel, { concurrency: "unbounded", discard: true })
              runners.clear()
            }),
          )
          return { runners }
        }),
      )

      const getRunner = (runners: Map<string, Runner<MessageV2.WithParts>>, sessionID: SessionID) => {
        const existing = runners.get(sessionID)
        if (existing) return existing
        const worker = Runner.make<MessageV2.WithParts>(scope, {
          onIdle: Effect.gen(function* () {
            runners.delete(sessionID)
            yield* status.set(sessionID, { type: "idle" })
          }),
          onBusy: status.set(sessionID, { type: "busy" }),
          onInterrupt: lastAssistant(sessionID),
          busy: () => {
            throw new Session.BusyError(sessionID)
          },
        })
        runners.set(sessionID, worker)
        return worker
      }

      const assertNotBusy: (sessionID: SessionID) => Effect.Effect<void, Session.BusyError> = Effect.fn(
        "SessionPrompt.assertNotBusy",
      )(function* (sessionID: SessionID) {
        const s = yield* InstanceState.get(state)
        const worker = s.runners.get(sessionID)
        if (worker?.busy) throw new Session.BusyError(sessionID)
      })

      const cancel = Effect.fn("SessionPrompt.cancel")(function* (sessionID: SessionID) {
        log.info("cancel", { sessionID })
        notifyCancelListeners(sessionID, "user.cancel")
        const s = yield* InstanceState.get(state)
        const worker = s.runners.get(sessionID)
        if (!worker || !worker.busy) {
          yield* status.set(sessionID, { type: "idle" })
          return
        }
        yield* worker.cancel
      })

      const resolvePromptParts = Effect.fn("SessionPrompt.resolvePromptParts")(function* (template: string) {
        const ctx = yield* InstanceState.context
        const parts: PromptInput["parts"] = [{ type: "text", text: template }]
        const files = ConfigMarkdown.files(template)
        const seen = new Set<string>()
        yield* Effect.forEach(
          files,
          Effect.fnUntraced(function* (match) {
            const name = match[1]
            if (seen.has(name)) return
            seen.add(name)
            const filepath = name.startsWith("~/")
              ? path.join(os.homedir(), name.slice(2))
              : path.resolve(ctx.worktree, name)

            const info = yield* fsys.stat(filepath).pipe(Effect.option)
            if (Option.isNone(info)) {
              const found = yield* agents.get(name)
              if (found) parts.push({ type: "agent", name: found.name })
              return
            }
            const stat = info.value
            parts.push({
              type: "file",
              url: pathToFileURL(filepath).href,
              filename: name,
              mime: stat.type === "Directory" ? "application/x-directory" : "text/plain",
            })
          }),
          { concurrency: "unbounded", discard: true },
        )
        return parts
      })

      const title = Effect.fn("SessionPrompt.ensureTitle")(function* (input: {
        session: Session.Info
        history: MessageV2.WithParts[]
        providerID: ProviderID
        modelID: ModelID
      }) {
        if (input.session.parentID) return
        if (!Session.isDefaultTitle(input.session.title)) return

        const real = (m: MessageV2.WithParts) =>
          m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic)
        const idx = input.history.findIndex(real)
        if (idx === -1) return
        if (input.history.filter(real).length !== 1) return

        const context = input.history.slice(0, idx + 1)
        const firstUser = context[idx]
        if (!firstUser || firstUser.info.role !== "user") return
        const firstInfo = firstUser.info

        const subtasks = firstUser.parts.filter((p): p is MessageV2.SubtaskPart => p.type === "subtask")
        const onlySubtasks = subtasks.length > 0 && firstUser.parts.every((p) => p.type === "subtask")

        // Resolve via RuntimeRoles binding (cfg.runtime_roles.title → name).
        // Defaults to "title" — preserves prior behavior.
        const titleAgentName = yield* Effect.promise(() => RuntimeRoles.resolve("title"))
        const ag = yield* agents.get(titleAgentName)
        if (!ag) return
        const mdl = ag.model
          ? yield* provider.getModel(ag.model.providerID, ag.model.modelID)
          : ((yield* provider.getSmallModel(input.providerID)) ??
            (yield* provider.getModel(input.providerID, input.modelID)))
        const msgs = onlySubtasks
          ? [{ role: "user" as const, content: subtasks.map((p) => p.prompt).join("\n") }]
          : yield* MessageV2.toModelMessagesEffect(context, mdl)
        const text = yield* Effect.promise(async (signal) => {
          const result = await LLM.stream({
            agent: ag,
            user: firstInfo,
            system: [],
            small: true,
            tools: {},
            model: mdl,
            abort: signal,
            sessionID: input.session.id,
            retries: 2,
            messages: [{ role: "user", content: "Generate a title for this conversation:\n" }, ...msgs],
          })
          return result.text
        })
        const cleaned = text
          .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
          .split("\n")
          .map((line) => line.trim())
          .find((line) => line.length > 0)
        if (!cleaned) return
        const t = cleaned.length > 100 ? cleaned.substring(0, 97) + "..." : cleaned
        yield* sessions
          .setTitle({ sessionID: input.session.id, title: t })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => log.error("failed to generate title", { error: Cause.squash(cause) })),
            ),
          )
      })

      const insertReminders = Effect.fn("SessionPrompt.insertReminders")(function* (input: {
        messages: MessageV2.WithParts[]
        agent: Agent.Info
        session: Session.Info
      }) {
        const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
        if (!userMessage) return input.messages

        // Plan-mode set is config-driven (cfg.plan_mode_agents); defaults to
        // {"planner"}. Replaces literal name checks.
        // checks scattered through this function.
        const planNames = yield* Effect.promise(() => AgentRoles.getPlanModeNames())
        const isCurrentPlan = planNames.has(input.agent.name)

        // Bundled session prompt loading: no notes-vault/file dependency.
        const promptPlan = yield* Effect.promise(() => loadSessionPrompt("plan"))

        if (!Flag.OPENCODE_EXPERIMENTAL_PLAN_MODE) {
          if (isCurrentPlan) {
            userMessage.parts.push({
              id: PartID.ascending(),
              messageID: userMessage.info.id,
              sessionID: userMessage.info.sessionID,
              type: "text",
              text: promptPlan,
              synthetic: true,
            })
          }
          return input.messages
        }

        const assistantMessage = input.messages.findLast((msg) => msg.info.role === "assistant")
        const lastAssistantWasPlan = assistantMessage ? planNames.has(assistantMessage.info.agent) : false
        if (!isCurrentPlan || lastAssistantWasPlan) return input.messages

        userMessage.parts.push({
          id: PartID.ascending(),
          messageID: userMessage.info.id,
          sessionID: userMessage.info.sessionID,
          type: "text",
          text: promptPlan,
          synthetic: true,
        })
        return input.messages
      })

      const resolveTools = Effect.fn("SessionPrompt.resolveTools")(function* (input: {
        agent: Agent.Info
        model: Provider.Model
        session: Session.Info
        tools?: Record<string, boolean>
        processor: Pick<SessionProcessor.Handle, "message" | "partFromToolCall">
        bypassAgentCheck: boolean
        messages: MessageV2.WithParts[]
        trajectory: TrajectoryRegulator.State
      }) {
        using _ = log.time("resolveTools")
        const tools: Record<string, AITool> = {}

        // gap-3-followup-2a: per-resolveTools readers-writers lock that
        // gates concurrent-unsafe tools (edit, bash, write, …) to
        // exclusive access while still allowing concurrent-safe tools
        // (read, grep, glob, lsp, …) to run in parallel under the AI
        // SDK's parallel dispatch. See tool/concurrency-lock.ts for the
        // semantics and tool/concurrency.ts for the safety classifier.
        const concurrencyLock = new ConcurrencyLock.Lock()

        const webRichOutputSystem = input.messages.findLast(
          (msg): msg is MessageV2.WithParts & { info: MessageV2.User } => msg.info.role === "user",
        )?.info.system

        const context = (args: any, options: ToolExecutionOptions): Tool.Context => ({
          sessionID: input.session.id,
          abort: options.abortSignal!,
          messageID: input.processor.message.id,
          callID: options.toolCallId,
          extra: {
            model: input.model,
            bypassAgentCheck: input.bypassAgentCheck,
            webRichOutputSystem: webRichOutputSystem?.includes("OpenCode web UI rich output:")
              ? webRichOutputSystem
              : undefined,
          },
          agent: input.agent.name,
          permissionMode: input.session.permissionMode,
          messages: input.messages,
          metadata: (val) =>
            Effect.runPromise(
              Effect.gen(function* () {
                const match = input.processor.partFromToolCall(options.toolCallId)
                if (!match || !["running", "pending"].includes(match.state.status)) return
                yield* sessions.updatePart({
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
              permission.ask({
                ...req,
                sessionID: input.session.id,
                tool: { messageID: input.processor.message.id, callID: options.toolCallId },
                ruleset: Permission.merge(input.agent.permission, input.session.permission ?? []),
                mode: input.session.permissionMode,
              }),
            ),
        })

        for (const item of yield* registry.tools(
          { modelID: ModelID.make(input.model.api.id), providerID: input.model.providerID },
          input.agent,
        )) {
          const schema = ProviderTransform.schema(input.model, z.toJSONSchema(item.parameters))
          tools[item.id] = tool({
            id: item.id as any, // AI SDK Tool type only declares `id` on the `provider` variant; runtime accepts it for all tools
            description: item.description,
            inputSchema: jsonSchema(schema as any), // ProviderTransform.schema returns Record<string,unknown>; jsonSchema() expects JSONSchema7
            execute(args, options) {
              return Effect.runPromise(
                Effect.gen(function* () {
                  // Lifecycle hook (extended) — `tool.execute.before` now
                  // supports a `deny` return value. When set, opencode
                  // short-circuits the tool with a synthetic error so the
                  // model sees the deny reason as a normal tool failure.
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
                  const blocked = input.trajectory.blockRepeatedCall({ tool: item.id, args: toolArgs })
                  if (blocked) {
                    yield* Effect.promise(() =>
                      ProviderPluginHooks.notify("tool.execute.failure", {
                        tool: item.id,
                        sessionID: ctx.sessionID,
                        callID: ctx.callID ?? "",
                        args: toolArgs,
                        error: { message: blocked.message },
                      }),
                    ).pipe(Effect.ignore)
                    throw blocked
                  }
                  // gap-3-followup-2a: gate the tool body behind the
                  // per-session readers-writers lock. Safe tools enter
                  // as readers (multiple may run at once); unsafe tools
                  // enter as writers (exclusive). The classifier below
                  // uses the tool's `concurrencySafe` annotation, then
                  // the curated DEFAULTS table, then default-deny.
                  const safe = Concurrency.isSafe(item.id, item, toolArgs)
                  try {
                    const result = yield* Effect.promise(() =>
                      concurrencyLock.run(safe, () => item.execute(toolArgs, ctx)),
                    )
                    const output = input.trajectory.recordSuccess({
                      tool: item.id,
                      args: toolArgs,
                      result: {
                        ...result,
                        attachments: result.attachments?.map((attachment) => ({
                          ...attachment,
                          id: PartID.ascending(),
                          sessionID: ctx.sessionID,
                          messageID: input.processor.message.id,
                        })),
                      },
                    })
                    yield* ProviderPluginHooks.triggerEffect(
                      "tool.execute.after",
                      { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID, args: toolArgs },
                      output,
                    )
                    return output
                  } catch (err) {
                    const regulatedError = input.trajectory.recordFailure({ tool: item.id, args: toolArgs, error: err })
                    // Lifecycle hook — fires when a tool throws.
                    yield* Effect.promise(() =>
                      ProviderPluginHooks.notify("tool.execute.failure", {
                        tool: item.id,
                        sessionID: ctx.sessionID,
                        callID: ctx.callID ?? "",
                        args: toolArgs,
                        error: { message: regulatedError.message },
                      }),
                    ).pipe(Effect.ignore)
                    throw regulatedError
                  }
                }),
              )
            },
          })
        }

        return tools
      })

      const handleSubtask = Effect.fn("SessionPrompt.handleSubtask")(function* (input: {
        task: MessageV2.SubtaskPart
        model: Provider.Model
        lastUser: MessageV2.User
        sessionID: SessionID
        session: Session.Info
        msgs: MessageV2.WithParts[]
      }) {
        const { task, model, lastUser, sessionID, session, msgs } = input
        const ctx = yield* InstanceState.context
        const taskTool = yield* Effect.promise(() => registry.named.task.init())
        const taskModel = task.model ? yield* getModel(task.model.providerID, task.model.modelID, sessionID) : model
        const assistantMessage: MessageV2.Assistant = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          parentID: lastUser.id,
          sessionID,
          mode: task.agent,
          agent: task.agent,
          variant: lastUser.variant,
          path: { cwd: ctx.directory, root: ctx.worktree },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: taskModel.id,
          providerID: taskModel.providerID,
          time: { created: Date.now() },
        })

        yield* Effect.promise(() =>
          markAutonomous({
            sessionID,
            messageID: lastUser.id,
          }),
        )
        const taskArgs = subtaskTaskArgs(task)
        let part: MessageV2.ToolPart = yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: assistantMessage.id,
          sessionID: assistantMessage.sessionID,
          type: "tool",
          callID: ulid(),
          tool: registry.named.task.id,
          state: {
            status: "running",
            input: taskArgs,
            time: { start: Date.now() },
          },
        })
        yield* ProviderPluginHooks.triggerEffect(
          "tool.execute.before",
          { tool: "task", sessionID, callID: part.id },
          { args: taskArgs },
        )

        const taskAgent = yield* agents.get(task.agent)
        if (!taskAgent) {
          const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
          const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
          const error = new NamedError.Unknown({ message: `Agent not found: "${task.agent}".${hint}` })
          yield* bus.publish(Session.Event.Error, {
            sessionID,
            error: MessageV2.AssistantError.parse(error.toObject()),
          })
          throw error
        }

        let error: Error | undefined
        const result = yield* Effect.promise((signal) =>
          taskTool
            .execute(taskArgs, {
              agent: lastUser.agent,
              permissionMode: session.permissionMode,
              messageID: assistantMessage.id,
              sessionID,
              abort: signal,
              callID: part.callID,
              extra: { bypassAgentCheck: true },
              messages: msgs,
              metadata(val: { title?: string; metadata?: Record<string, any> }) {
                return Effect.runPromise(
                  Effect.gen(function* () {
                    part = yield* sessions.updatePart({
                      ...part,
                      type: "tool",
                      state: { ...part.state, ...val },
                    } satisfies MessageV2.ToolPart)
                  }),
                )
              },
              ask(req: any) {
                return Effect.runPromise(
                  permission.ask({
                    ...req,
                    sessionID,
                    ruleset: Permission.merge(taskAgent.permission, session.permission ?? []),
                    mode: session.permissionMode,
                  }),
                )
              },
            })
            .catch((e) => {
              error = e instanceof Error ? e : new Error(String(e))
              log.error("subtask execution failed", { error, agent: task.agent, description: task.description })
              return undefined
            }),
        ).pipe(
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              assistantMessage.finish = "tool-calls"
              assistantMessage.time.completed = Date.now()
              yield* sessions.updateMessage(assistantMessage)
              if (part.state.status === "running") {
                yield* sessions.updatePart({
                  ...part,
                  state: {
                    status: "error",
                    error: "Cancelled",
                    time: { start: part.state.time.start, end: Date.now() },
                    metadata: part.state.metadata,
                    input: part.state.input,
                  },
                } satisfies MessageV2.ToolPart)
              }
            }),
          ),
        )

        const attachments = result?.attachments?.map((attachment) => ({
          ...attachment,
          id: PartID.ascending(),
          sessionID,
          messageID: assistantMessage.id,
        }))

        yield* ProviderPluginHooks.triggerEffect(
          "tool.execute.after",
          { tool: "task", sessionID, callID: part.id, args: taskArgs },
          result,
        )

        // Lifecycle hook — fires when a subagent task tool returns. The
        // task tool internally manages its own child sessionID; for the
        // subagent.stop event we report the parent's sessionID and use
        // the part.id as a stand-in for the child session reference.
        // Plugins that need the actual child sessionID can correlate via
        // the matching subagent.start event (parent + agent + description).
        yield* Effect.promise(() =>
          ProviderPluginHooks.notify("subagent.stop", {
            parentSessionID: sessionID,
            sessionID: part.id,
            result: result?.output,
            error: error ? { message: error.message } : undefined,
          }),
        ).pipe(Effect.ignore)

        assistantMessage.finish = "tool-calls"
        assistantMessage.time.completed = Date.now()
        yield* sessions.updateMessage(assistantMessage)

        if (result && part.state.status === "running") {
          yield* sessions.updatePart({
            ...part,
            state: {
              status: "completed",
              input: part.state.input,
              title: result.title,
              metadata: result.metadata,
              output: result.output,
              attachments,
              time: { ...part.state.time, end: Date.now() },
            },
          } satisfies MessageV2.ToolPart)
        }

        if (!result) {
          yield* sessions.updatePart({
            ...part,
            state: {
              status: "error",
              error: error ? `Tool execution failed: ${error.message}` : "Tool execution failed",
              time: {
                start: part.state.status === "running" ? part.state.time.start : Date.now(),
                end: Date.now(),
              },
              metadata: part.state.status === "pending" ? undefined : part.state.metadata,
              input: part.state.input,
            },
          } satisfies MessageV2.ToolPart)
        }

        if (!task.command) return

        const summaryUserMsg: MessageV2.User = {
          id: MessageID.ascending(),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: lastUser.agent,
          model: lastUser.model,
        }
        yield* sessions.updateMessage(summaryUserMsg)
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: summaryUserMsg.id,
          sessionID,
          type: "text",
          text: "Summarize the task tool output above and continue with your task.",
          synthetic: true,
        } satisfies MessageV2.TextPart)
      })

      const shellImpl = Effect.fn("SessionPrompt.shellImpl")(function* (input: ShellInput, signal: AbortSignal) {
        const ctx = yield* InstanceState.context
        const session = yield* sessions.get(input.sessionID)
        if (session.revert) {
          yield* Effect.promise(() => SessionRevert.cleanup(session))
        }
        const agent = yield* agents.get(input.agent)
        if (!agent) {
          const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
          const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
          const error = new NamedError.Unknown({ message: `Agent not found: "${input.agent}".${hint}` })
          yield* bus.publish(Session.Event.Error, {
            sessionID: input.sessionID,
            error: MessageV2.AssistantError.parse(error.toObject()),
          })
          throw error
        }
        const model = input.model ?? agent.model ?? (yield* lastModel(input.sessionID))
        const userMsg: MessageV2.User = {
          id: input.messageID ?? MessageID.ascending(),
          sessionID: input.sessionID,
          time: { created: Date.now() },
          role: "user",
          agent: input.agent,
          model: { providerID: model.providerID, modelID: model.modelID },
        }
        yield* sessions.updateMessage(userMsg)
        const userPart: MessageV2.Part = {
          type: "text",
          id: PartID.ascending(),
          messageID: userMsg.id,
          sessionID: input.sessionID,
          text: "The following tool was executed by the user",
          synthetic: true,
        }
        yield* sessions.updatePart(userPart)

        const msg: MessageV2.Assistant = {
          id: MessageID.ascending(),
          sessionID: input.sessionID,
          parentID: userMsg.id,
          mode: input.agent,
          agent: input.agent,
          cost: 0,
          path: { cwd: ctx.directory, root: ctx.worktree },
          time: { created: Date.now() },
          role: "assistant",
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: model.modelID,
          providerID: model.providerID,
        }
        yield* sessions.updateMessage(msg)
        const part: MessageV2.ToolPart = {
          type: "tool",
          id: PartID.ascending(),
          messageID: msg.id,
          sessionID: input.sessionID,
          tool: "bash",
          callID: ulid(),
          state: {
            status: "running",
            time: { start: Date.now() },
            input: { command: input.command },
          },
        }
        yield* sessions.updatePart(part)

        const sh = Shell.preferred()
        const shellName = (
          process.platform === "win32" ? path.win32.basename(sh, ".exe") : path.basename(sh)
        ).toLowerCase()
        const invocations: Record<string, { args: string[] }> = {
          nu: { args: ["-c", input.command] },
          fish: { args: ["-c", input.command] },
          zsh: {
            args: [
              "-l",
              "-c",
              `
                __oc_cwd=$PWD
                [[ -f ~/.zshenv ]] && source ~/.zshenv >/dev/null 2>&1 || true
                [[ -f "\${ZDOTDIR:-$HOME}/.zshrc" ]] && source "\${ZDOTDIR:-$HOME}/.zshrc" >/dev/null 2>&1 || true
                cd "$__oc_cwd"
                eval ${JSON.stringify(input.command)}
              `,
            ],
          },
          bash: {
            args: [
              "-l",
              "-c",
              `
                __oc_cwd=$PWD
                shopt -s expand_aliases
                [[ -f ~/.bashrc ]] && source ~/.bashrc >/dev/null 2>&1 || true
                cd "$__oc_cwd"
                eval ${JSON.stringify(input.command)}
              `,
            ],
          },
          cmd: { args: ["/c", input.command] },
          powershell: { args: ["-NoProfile", "-Command", input.command] },
          pwsh: { args: ["-NoProfile", "-Command", input.command] },
          "": { args: ["-c", input.command] },
        }

        const args = (invocations[shellName] ?? invocations[""]).args
        const cwd = ctx.directory
        const shellEnv = yield* ProviderPluginHooks.triggerEffect(
          "shell.env",
          { cwd, sessionID: input.sessionID, callID: part.callID },
          { env: {} },
        )

        const cmd = ChildProcess.make(sh, args, {
          cwd,
          extendEnv: true,
          env: { ...shellEnv.env, TERM: "dumb" },
          stdin: "ignore",
          forceKillAfter: "3 seconds",
        })

        let output = ""
        let aborted = false

        const finish = Effect.uninterruptible(
          Effect.gen(function* () {
            if (aborted) {
              output += "\n\n" + ["<metadata>", "User aborted the command", "</metadata>"].join("\n")
            }
            if (!msg.time.completed) {
              msg.time.completed = Date.now()
              yield* sessions.updateMessage(msg)
            }
            if (part.state.status === "running") {
              part.state = {
                status: "completed",
                time: { ...part.state.time, end: Date.now() },
                input: part.state.input,
                title: "",
                metadata: { output, description: "" },
                output,
              }
              yield* sessions.updatePart(part)
            }
          }),
        )

        const exit = yield* Effect.gen(function* () {
          const handle = yield* spawner.spawn(cmd)
          yield* Stream.runForEach(Stream.decodeText(handle.all), (chunk) =>
            Effect.sync(() => {
              output += chunk
              if (part.state.status === "running") {
                part.state.metadata = { output, description: "" }
                void Effect.runFork(sessions.updatePart(part))
              }
            }),
          )
          yield* handle.exitCode
        }).pipe(
          Effect.scoped,
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              aborted = true
            }),
          ),
          Effect.orDie,
          Effect.ensuring(finish),
          Effect.exit,
        )

        if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
          return yield* Effect.failCause(exit.cause)
        }

        return { info: msg, parts: [part] }
      })

      const getModel = Effect.fn("SessionPrompt.getModel")(function* (
        providerID: ProviderID,
        modelID: ModelID,
        sessionID: SessionID,
      ) {
        const exit = yield* provider.getModel(providerID, modelID).pipe(Effect.exit)
        if (Exit.isSuccess(exit)) return exit.value
        const err = Cause.squash(exit.cause)
        if (Provider.ModelNotFoundError.isInstance(err)) {
          const hint = err.data.suggestions?.length ? ` Did you mean: ${err.data.suggestions.join(", ")}?` : ""
          yield* bus.publish(Session.Event.Error, {
            sessionID,
            error: MessageV2.AssistantError.parse(
              new NamedError.Unknown({
                message: `Model not found: ${err.data.providerID}/${err.data.modelID}.${hint}`,
              }).toObject(),
            ),
          })
        }
        return yield* Effect.failCause(exit.cause)
      })

      const lastModel = Effect.fnUntraced(function* (sessionID: SessionID) {
        const model = yield* Effect.promise(async () => {
          for await (const item of MessageV2.stream(sessionID)) {
            if (item.info.role === "user" && item.info.model) return item.info.model
          }
        })
        if (model) return model
        return yield* provider.defaultModel()
      })

      const createUserMessage = Effect.fn("SessionPrompt.createUserMessage")(function* (input: PromptInput) {
        const agentName = input.agent || (yield* agents.defaultAgent())
        const ag = yield* agents.get(agentName)
        if (!ag) {
          const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
          const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
          const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
          yield* bus.publish(Session.Event.Error, {
            sessionID: input.sessionID,
            error: MessageV2.AssistantError.parse(error.toObject()),
          })
          throw error
        }

        const model = input.model ?? ag.model ?? (yield* lastModel(input.sessionID))
        const same = ag.model && model.providerID === ag.model.providerID && model.modelID === ag.model.modelID
        const full =
          !input.variant && ag.variant && same
            ? yield* provider
                .getModel(model.providerID, model.modelID)
                .pipe(Effect.catch(() => Effect.succeed(undefined)))
            : undefined
        const variant = input.variant ?? (ag.variant && full?.variants?.[ag.variant] ? ag.variant : undefined)

        const info: MessageV2.Info = {
          id: input.messageID ?? MessageID.ascending(),
          role: "user",
          sessionID: input.sessionID,
          time: { created: Date.now() },
          tools: input.tools,
          agent: ag.name,
          model,
          system: input.system,
          format: input.format,
          variant,
        }

        type Draft<T> = T extends MessageV2.Part ? Omit<T, "id"> & { id?: string } : never
        const assign = (part: Draft<MessageV2.Part>): MessageV2.Part => ({
          ...part,
          id: part.id ? PartID.make(part.id) : PartID.ascending(),
        })

        const resolvePart: (part: PromptInput["parts"][number]) => Effect.Effect<Draft<MessageV2.Part>[]> = Effect.fn(
          "SessionPrompt.resolveUserPart",
        )(function* (part) {
          if (part.type === "file") {
            if (part.source?.type === "resource") {
              const { clientName, uri } = part.source
              log.info("external resource skipped (disabled)", { clientName, uri, mime: part.mime })
              return [
                {
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: `External resource inputs are disabled in this build. Skipped resource: ${part.filename ?? uri}`,
                },
                { ...part, messageID: info.id, sessionID: input.sessionID },
              ]
            }
            const url = new URL(part.url)
            switch (url.protocol) {
              case "data:":
                if (part.mime === "text/plain") {
                  return [
                    {
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `Loaded text data URL attachment: ${JSON.stringify({ filePath: part.filename })}`,
                    },
                    {
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: decodeDataUrl(part.url),
                    },
                    { ...part, messageID: info.id, sessionID: input.sessionID },
                  ]
                }
                break
              case "file:": {
                log.info("file", { mime: part.mime })
                const filepath = fileURLToPath(part.url)
                if (yield* fsys.isDir(filepath)) part.mime = "application/x-directory"

                if (part.mime === "text/plain") {
                  let offset: number | undefined
                  let limit: number | undefined
                  const range = { start: url.searchParams.get("start"), end: url.searchParams.get("end") }
                  if (range.start != null) {
                    let start = parseInt(range.start)
                    let end = range.end ? parseInt(range.end) : undefined
                    if (start === end) {
                      end = start
                    }
                    offset = Math.max(start, 1)
                    if (end !== undefined) limit = Math.max(end - (offset - 1), 1)
                  }
                  const args = { path: filepath, offset, limit }
                  const pieces: Draft<MessageV2.Part>[] = [
                    {
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `Loaded file attachment with the following input: ${JSON.stringify(args)}`,
                    },
                  ]
                  const loaded = yield* Effect.promise(() => loadAttachmentFile(filepath, { offset, limit })).pipe(
                    Effect.exit,
                  )
                  if (Exit.isSuccess(loaded)) {
                    pieces.push({
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: loaded.value,
                    })
                    yield* filetime.read(input.sessionID, filepath).pipe(Effect.ignore)
                    pieces.push({ ...part, messageID: info.id, sessionID: input.sessionID })
                  } else {
                    const error = Cause.squash(loaded.cause)
                    log.error("failed to load file attachment", { error })
                    const message = error instanceof Error ? error.message : String(error)
                    yield* bus.publish(Session.Event.Error, {
                      sessionID: input.sessionID,
                      error: MessageV2.AssistantError.parse(new NamedError.Unknown({ message }).toObject()),
                    })
                    pieces.push({
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `Failed to load file attachment ${filepath}: ${message}`,
                    })
                  }
                  return pieces
                }

                if (part.mime === "application/x-directory") {
                  const args = { path: filepath }
                  const loaded = yield* Effect.promise(() => listAttachmentDirectory(filepath)).pipe(Effect.exit)
                  if (Exit.isSuccess(loaded)) {
                    return [
                      {
                        messageID: info.id,
                        sessionID: input.sessionID,
                        type: "text",
                        synthetic: true,
                        text: `Listed directory attachment with the following input: ${JSON.stringify(args)}`,
                      },
                      {
                        messageID: info.id,
                        sessionID: input.sessionID,
                        type: "text",
                        synthetic: true,
                        text: loaded.value,
                      },
                      { ...part, messageID: info.id, sessionID: input.sessionID },
                    ]
                  }
                  const error = Cause.squash(loaded.cause)
                  log.error("failed to list directory attachment", { error })
                  const message = error instanceof Error ? error.message : String(error)
                  yield* bus.publish(Session.Event.Error, {
                    sessionID: input.sessionID,
                    error: MessageV2.AssistantError.parse(new NamedError.Unknown({ message }).toObject()),
                  })
                  return [
                    {
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `Failed to list directory attachment ${filepath}: ${message}`,
                    },
                    { ...part, messageID: info.id, sessionID: input.sessionID },
                  ]
                }

                yield* filetime.read(input.sessionID, filepath)
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Loaded binary file attachment: ${JSON.stringify({ filePath: filepath })}`,
                  },
                  {
                    id: part.id,
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "file",
                    url:
                      `data:${part.mime};base64,` +
                      Buffer.from(yield* fsys.readFile(filepath).pipe(Effect.catch(Effect.die))).toString("base64"),
                    mime: part.mime,
                    filename: part.filename!,
                    source: part.source,
                  },
                ]
              }
            }
          }

          if (part.type === "agent") {
            const perm = Permission.evaluate("task", part.name, ag.permission)
            const hint = perm.action === "deny" ? " . Invoked by user; guaranteed to exist." : ""
            return [
              { ...part, messageID: info.id, sessionID: input.sessionID },
              {
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text:
                  " Use the above message and context to generate a prompt and call the task tool with subagent: " +
                  part.name +
                  hint,
              },
            ]
          }

          return [{ ...part, messageID: info.id, sessionID: input.sessionID }]
        })

        const parts = yield* Effect.forEach(input.parts, resolvePart, { concurrency: "unbounded" }).pipe(
          Effect.map((x) => x.flat().map(assign)),
        )

        yield* ProviderPluginHooks.triggerEffect(
          "chat.message",
          {
            sessionID: input.sessionID,
            agent: input.agent,
            model: input.model,
            messageID: input.messageID,
            variant: input.variant,
          },
          { message: info, parts },
        )

        const parsed = MessageV2.Info.safeParse(info)
        if (!parsed.success) {
          log.error("invalid user message before save", {
            sessionID: input.sessionID,
            messageID: info.id,
            agent: info.agent,
            model: info.model,
            issues: parsed.error.issues,
          })
        }
        parts.forEach((part, index) => {
          const p = MessageV2.Part.safeParse(part)
          if (p.success) return
          log.error("invalid user part before save", {
            sessionID: input.sessionID,
            messageID: info.id,
            partID: part.id,
            partType: part.type,
            index,
            issues: p.error.issues,
            part,
          })
        })

        yield* sessions.updateMessage(info)
        for (const part of parts) yield* sessions.updatePart(part)

        return { info, parts }
      }, Effect.scoped)

      const prompt: (input: PromptInput) => Effect.Effect<MessageV2.WithParts> = Effect.fn("SessionPrompt.prompt")(
        function* (input: PromptInput) {
          const session = yield* sessions.get(input.sessionID)
          yield* Effect.promise(() => SessionRevert.cleanup(session))
          const message = yield* createUserMessage(input)
          yield* sessions.touch(input.sessionID)

          const permissions: Permission.Ruleset = []
          for (const [t, enabled] of Object.entries(input.tools ?? {})) {
            permissions.push({ permission: t, action: enabled ? "allow" : "deny", pattern: "*" })
          }
          if (permissions.length > 0) {
            session.permission = permissions
            yield* sessions.setPermission({ sessionID: session.id, permission: permissions })
          }

          if (input.noReply === true) return message
          return yield* loop({ sessionID: input.sessionID, loopMode: false })
        },
      )

      const lastAssistant = (sessionID: SessionID) =>
        Effect.promise(async () => {
          let latest: MessageV2.WithParts | undefined
          for await (const item of MessageV2.stream(sessionID)) {
            latest ??= item
            if (item.info.role !== "user") return item
          }
          if (latest) return latest
          throw new Error("Impossible")
        })

      const runLoop: (sessionID: SessionID, loopMode?: boolean) => Effect.Effect<MessageV2.WithParts, never | null> =
        Effect.fn("SessionPrompt.run")(function* (sessionID: SessionID, loopMode = false) {
          const ctx = yield* InstanceState.context
          let structured: unknown | undefined
          let step = 0
          let autoTurns = 0
          let blocked = 0
          let lastActionableItem = ""
          let stallTurns = 0
          const STALL_THRESHOLD = 3
          const cfg = yield* Effect.promise(() => Config.get())
          const maxAutoTurns = cfg.experimental?.autocontinue_max_turns ?? 10000
          const session = yield* sessions.get(sessionID)
          // Phase 1c — token-budget tracker. One per runLoop invocation. Subagent
          // sessions skip the tracker entirely; the parent session owns the budget.
          const budgetTracker = TokenBudget.create()
          const trajectory = TrajectoryRegulator.create()
          const isSubagent = Boolean(session.parentID)
          // Cumulative session tokens (input+output+reasoning+cache) accumulated
          // across every step for optional session-level budget checks.
          let sessionTotalTokens = 0
          // Circuit breaker: stop auto-compaction after 3 consecutive failures.
          // Without this, a permanently overflowed context triggers compaction
          // every loop step, wasting API quota indefinitely.
          let consecutiveCompactionFailures = 0
          const MAX_CONSECUTIVE_COMPACTION_FAILURES = 3
          // Lifecycle hooks — track whether session.start has fired and
          // capture the exit reason for session.end / session.stop /
          // session.stop.failure when the loop terminates. The flag prevents
          // duplicate fires if runLoop is re-entered (shouldn't happen but
          // defensive).
          let sessionStartFired = false
          let lastUserMessageIDFired: string | undefined

          // Helper: fire session.end + session.stop on a clean exit. Called
          // from any `break` site that represents a successful termination.
          const fireSessionEnd = (reason: "complete" | "no-actionable" | "max-turns" | "direct-chat-idle") =>
            Effect.promise(async () => {
              await ProviderPluginHooks.notify("session.end", { sessionID, reason })
              await ProviderPluginHooks.notify("session.stop", { sessionID, reason })
            }).pipe(Effect.ignore)

          while (true) {
            yield* status.set(sessionID, { type: "busy" })
            log.info("loop tick", { step, autoTurns, maxAutoTurns, stallTurns, sessionID })

            let msgs = yield* MessageV2.filterCompactedEffect(sessionID)

            const { lastUser, lastUserWithParts, lastAssistant, lastFinished, tasks } = scanLoopHistory(msgs)

            // Lifecycle hooks — fire `session.start` once per runLoop
            // (now that we have the agent + model from lastUser) and
            // `chat.user.submit` whenever we observe a NEW user message
            // entering the loop. The lastUserMessageIDFired guard prevents
            // duplicate submit events when the loop iterates without a new
            // user message (e.g. tool-call continuation).
            if (!sessionStartFired) {
              sessionStartFired = true
              yield* Effect.promise(() =>
                ProviderPluginHooks.notify("session.start", {
                  sessionID,
                  agent: lastUser!.agent,
                  model: { providerID: lastUser!.model.providerID, modelID: lastUser!.model.modelID },
                }),
              ).pipe(Effect.ignore)
            }
            if (lastUser.id !== lastUserMessageIDFired) {
              lastUserMessageIDFired = lastUser.id
              const userText =
                lastUserWithParts?.parts
                  .filter((p): p is MessageV2.TextPart => p.type === "text" && !p.synthetic && !p.ignored)
                  .map((p) => p.text ?? "")
                  .join("\n")
                  .trim() ?? ""
              yield* Effect.promise(() =>
                ProviderPluginHooks.notify("chat.user.submit", {
                  sessionID,
                  messageID: lastUser!.id,
                  agent: lastUser!.agent,
                  text: userText,
                }),
              ).pipe(Effect.ignore)
            }

            const autonomous = loopMode || hasAutonomousMarker(lastUserWithParts?.parts ?? [])
            const actionableState = yield* Effect.promise(() => getActionableTodo(sessionID))

            // Compute hasToolCalls early so exit checks can guard against premature
            // loop termination when the assistant has pending tool calls.
            const lastAssistantMsgEarly = msgs.findLast(
              (msg) => msg.info.role === "assistant" && msg.info.id === lastAssistant?.id,
            )
            const hasToolCallsEarly = lastAssistantMsgEarly?.parts.some((part) => part.type === "tool") ?? false

            if (
              !autonomous &&
              lastAssistant?.finish &&
              !["tool-calls", "unknown"].includes(lastAssistant.finish) &&
              !hasToolCallsEarly &&
              lastUser.id < lastAssistant.id
            ) {
              log.info("exiting loop: direct-chat idle", { sessionID, step, autoTurns })
              yield* fireSessionEnd("direct-chat-idle")
              break
            }

            if (
              autonomous &&
              lastAssistant?.finish &&
              !["tool-calls", "unknown"].includes(lastAssistant.finish) &&
              !hasToolCallsEarly &&
              lastUser.id < lastAssistant.id
            ) {
              if (!actionableState.has) {
                yield* Effect.sync(() => markPacketStale(sessionID, "loop-stop:no-actionable", true))
                log.info("exiting loop: all todos cleared", {
                  sessionID,
                  reason: "no-actionable",
                  autoTurns,
                  maxAutoTurns,
                })
                yield* fireSessionEnd("no-actionable")
                break
              }
              if (autoTurns >= maxAutoTurns) {
                yield* Effect.sync(() => markPacketStale(sessionID, "loop-stop:max_auto_turns", true))
                log.info("exiting loop: safety cap reached", {
                  sessionID,
                  reason: "max_auto_turns",
                  autoTurns,
                  maxAutoTurns,
                  item: actionableState.item,
                })
                yield* fireSessionEnd("max-turns")
                break
              }
              // Todos remain and cap not reached — fall through to run the model.
              log.info("loop: previous turn finished, todos remain — continuing", {
                sessionID,
                autoTurns,
                item: actionableState.item,
              })
            }

            const lastAssistantMsg = lastAssistantMsgEarly
            // Some providers return "stop" even when the assistant message contains tool calls.
            // Keep the loop running so tool results can be sent back to the model.
            const hasToolCalls = hasToolCallsEarly

            if (
              lastAssistant?.finish &&
              !["tool-calls"].includes(lastAssistant.finish) &&
              !hasToolCalls &&
              lastUser.id < lastAssistant.id
            ) {
              log.info("exiting loop", { sessionID })
              yield* fireSessionEnd("complete")
              break
            }

            step++
            if (step === 1)
              yield* title({
                session,
                modelID: lastUser.model.modelID,
                providerID: lastUser.model.providerID,
                history: msgs,
              }).pipe(Effect.ignore, Effect.forkIn(scope))

            const model = yield* getModel(lastUser.model.providerID, lastUser.model.modelID, sessionID)

            const task = tasks.pop()

            if (task?.type === "subtask") {
              yield* handleSubtask({ task, model, lastUser, sessionID, session, msgs })
              continue
            }

            if (task?.type === "compaction") {
              const result = yield* compaction.process({
                messages: msgs,
                parentID: lastUser.id,
                sessionID,
                auto: task.auto,
                overflow: task.overflow,
              })
              if (result === "stop") {
                // Only exit if no actionable todos remain — compaction stop must not
                // terminate the loop while work is still pending.
                const postCompact = yield* Effect.promise(() => getActionableTodo(sessionID))
                if (!postCompact.has) {
                  log.info("exiting loop after compaction stop", {
                    sessionID,
                    reason: "compaction-stop:no-actionable",
                    autoTurns,
                  })
                  break
                }
                if (!autonomous) continue
                // Todos remain — force packet rebuild and inject directive, then continue.
                yield* Effect.sync(() => markPacketStale(sessionID, "autocontinue:compaction-stop-todos-remain", true))
                if (postCompact.item === lastActionableItem) {
                  stallTurns++
                  if (stallTurns >= STALL_THRESHOLD) {
                    const ag = yield* agents.get(lastUser.agent)
                    yield* Effect.promise(() =>
                      injectStallBreakDirective({
                        sessionID,
                        user: lastUser!,
                        item: postCompact.item,
                        stallTurns,
                        orchestrator: ag?.mode === "primary",
                        delegationAllowed: ag?.tier !== "2",
                      }),
                    )
                    stallTurns = 0
                  } else {
                    yield* Effect.promise(() =>
                      injectNextTodoDirective({ sessionID, user: lastUser!, item: postCompact.item }),
                    )
                  }
                } else {
                  stallTurns = 0
                  lastActionableItem = postCompact.item
                  yield* Effect.promise(() =>
                    injectNextTodoDirective({ sessionID, user: lastUser!, item: postCompact.item }),
                  )
                }
                autoTurns++
                log.info("autocontinue: todos remain after compaction stop", {
                  sessionID,
                  item: postCompact.item,
                  autoTurns,
                  maxAutoTurns,
                })
              }
              continue
            }

            if (
              lastFinished &&
              lastFinished.summary !== true &&
              (yield* compaction.isOverflow({ tokens: lastFinished.tokens, model }))
            ) {
              if (consecutiveCompactionFailures >= MAX_CONSECUTIVE_COMPACTION_FAILURES) {
                log.warn("compaction circuit breaker open — skipping auto-compaction", {
                  sessionID,
                  consecutiveCompactionFailures,
                })
              } else {
                yield* compaction
                  .create({ sessionID, agent: lastUser.agent, model: lastUser.model, auto: loopMode })
                  .pipe(
                    Effect.tap(() =>
                      Effect.sync(() => {
                        consecutiveCompactionFailures = 0
                      }),
                    ),
                    Effect.tapCause(() =>
                      Effect.sync(() => {
                        consecutiveCompactionFailures++
                      }),
                    ),
                    Effect.orDie,
                  )
              }
              continue
            }

            const agent = yield* agents.get(lastUser.agent)
            if (!agent) {
              const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
              const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
              const error = new NamedError.Unknown({ message: `Agent not found: "${lastUser.agent}".${hint}` })
              yield* bus.publish(Session.Event.Error, {
                sessionID,
                error: MessageV2.AssistantError.parse(error.toObject()),
              })
              throw error
            }
            const maxSteps = agent.steps ?? Infinity
            const isLastStep = step >= maxSteps
            msgs = yield* insertReminders({ messages: msgs, agent, session })

            const msg: MessageV2.Assistant = {
              id: MessageID.ascending(),
              parentID: lastUser.id,
              role: "assistant",
              mode: agent.name,
              agent: agent.name,
              variant: lastUser.variant,
              path: { cwd: ctx.directory, root: ctx.worktree },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: model.id,
              providerID: model.providerID,
              time: { created: Date.now() },
              sessionID,
            }
            yield* sessions.updateMessage(msg)

            // Build runtime fallback chain for silent model failover.
            // Precedence:
            //   1) model_routing ranked candidates for this agent (health-aware)
            //   2) static agent.models fallbacks
            // Current active model is excluded from the fallback list.
            const modelFallbacks = yield* resolveModelFallbacks({ model, agent, config: cfg })

            const handle = yield* processor.create({
              assistantMessage: msg,
              sessionID,
              model,
              modelFallbacks,
            })

            const outcome: "break" | "continue" = yield* Effect.onExit(
              Effect.gen(function* () {
                const lastUserMsg = msgs.findLast((m) => m.info.role === "user")
                const bypassAgentCheck = lastUserMsg?.parts.some((p) => p.type === "agent") ?? false

                const tools = yield* resolveTools({
                  agent,
                  session,
                  model,
                  tools: lastUser.tools,
                  processor: handle,
                  bypassAgentCheck,
                  messages: msgs,
                  trajectory,
                })

                if (lastUser.format?.type === "json_schema") {
                  tools["StructuredOutput"] = createStructuredOutputTool({
                    schema: lastUser.format.schema,
                    onSuccess(output) {
                      structured = output
                    },
                  })
                }

                if (step === 1) SessionSummary.summarize({ sessionID, messageID: lastUser.id })

                yield* ProviderPluginHooks.triggerEffect("experimental.chat.messages.transform", {}, { messages: msgs })

                // Action 2 — split environment into stable + volatile so the
                // date doesn't invalidate the cached prefix at midnight.
                // The stable part lands FIRST in the system array (cacheable);
                // the volatile date string lands LAST so it falls AFTER any
                // cache marker the provider applies. Most providers cache up
                // to (and including) the last-marked block, so trailing volatile
                // content stays outside the cached prefix.
                const [envStable, modelMsgs] = yield* Effect.all([
                  Effect.promise(() => SystemPrompt.environmentStable(model)),
                  Effect.promise(() => MessageV2.toModelMessages(msgs, model)),
                ])
                const envVolatile = SystemPrompt.environmentVolatile()
                const system = [...envStable, envVolatile]

                // experimental.chat.system.transform — lets plugins append,
                // prepend, or rewrite the system array before it reaches the
                // model. Mutates `system` in-place via the trigger output.
                // Ported from qcode's system-transform hook pattern.
                yield* Effect.promise(async () => {
                  const out = await ProviderPluginHooks.trigger(
                    "experimental.chat.system.transform",
                    { sessionID, model },
                    { system },
                  )
                  system.length = 0
                  system.push(...out.system)
                }).pipe(Effect.ignore)

                // Lifecycle hook — fires when the system prompt is rebuilt
                // for a step. Plugins use this for system-prompt audit, IDE
                // display, telemetry on prompt drift, etc.
                yield* Effect.promise(() =>
                  ProviderPluginHooks.notify("instructions.loaded", {
                    sessionID,
                    agent: agent.name,
                    model: { providerID: model.providerID, modelID: model.id },
                    system,
                  }),
                ).pipe(Effect.ignore)

                // Keep orchestrator/system prompt cache-stable across loop turns.
                // Context packets are now rebuilt only from explicit stale events
                // (todo/task-note mutations, switches, compaction follow-ups), not
                // from a fixed step interval.

                const format = lastUser.format ?? { type: "text" as const }
                if (format.type === "json_schema") system.push(STRUCTURED_OUTPUT_SYSTEM_PROMPT)

                // Phase 1d — proactive overflow gate. Run a cheap pre-call
                // estimate; if it predicts the request would overflow the
                // model's usable context window, schedule a compaction
                // turn instead of letting the call fail. The estimator is
                // a string-length heuristic so it can over-estimate; we
                // still attempt the call when the gap is small but log
                // visibly so users can tune cfg.compaction.reserved.
                const maxStepsPrompt = isLastStep ? yield* Effect.promise(() => loadSessionPrompt("max-steps")) : ""
                if (maxStepsPrompt) {
                  // Do not append this as an assistant message. Some providers/models
                  // reject assistant prefill and require the request conversation to
                  // end with a user message. Keep the max-steps instruction in the
                  // system prompt instead so normal chat, including todo-agent chat
                  // sessions, can continue after an agent turn.
                  system.push(maxStepsPrompt)
                }
                const finalMessages = modelMsgs
                if (!handle.message.summary) {
                  const estimate = TokenEstimate.wouldOverflow({
                    system,
                    messages: finalMessages,
                    tools,
                    model,
                    reservedTokens: cfg.compaction?.reserved,
                  })
                  if (estimate.overflow) {
                    if (consecutiveCompactionFailures >= MAX_CONSECUTIVE_COMPACTION_FAILURES) {
                      log.warn("compaction circuit breaker open — skipping proactive compaction", {
                        sessionID,
                        consecutiveCompactionFailures,
                        estimated: estimate.estimated,
                        usable: estimate.usable,
                      })
                    } else {
                      log.info("pre-call overflow predicted — triggering proactive compaction", {
                        sessionID,
                        estimated: estimate.estimated,
                        usable: estimate.usable,
                      })
                      yield* compaction
                        .create({
                          sessionID,
                          agent: lastUser.agent,
                          model: lastUser.model,
                          auto: loopMode,
                        })
                        .pipe(
                          Effect.tap(() =>
                            Effect.sync(() => {
                              consecutiveCompactionFailures = 0
                            }),
                          ),
                          Effect.tapCause(() =>
                            Effect.sync(() => {
                              consecutiveCompactionFailures++
                            }),
                          ),
                          Effect.orDie,
                        )
                      return "continue" as const
                    }
                  }
                }

                const result = yield* handle.process({
                  user: lastUser,
                  agent,
                  permission: session.permission,
                  sessionID,
                  parentSessionID: session.parentID,
                  system,
                  messages: finalMessages,
                  tools,
                  model,
                  toolChoice: format.type === "json_schema" ? "required" : undefined,
                })

                // Post-sampling hook — fires once per LLM turn after the
                // assistant message is fully streamed and persisted.
                // Ported from qcode's executePostSamplingHooks pattern.
                ProviderPluginHooks.notify("chat.assistant.complete", {
                  sessionID,
                  messageID: handle.message.id,
                  agent: agent.name,
                  model: { providerID: model.providerID, modelID: model.id },
                  stopReason: handle.message.finish ?? "unknown",
                  usage: handle.message.tokens
                    ? {
                        inputTokens: handle.message.tokens.input ?? 0,
                        outputTokens: handle.message.tokens.output ?? 0,
                        cacheReadTokens: handle.message.tokens.cache?.read ?? 0,
                        cacheWriteTokens: handle.message.tokens.cache?.write ?? 0,
                      }
                    : undefined,
                })

                if (structured !== undefined) {
                  handle.message.structured = structured
                  handle.message.finish = handle.message.finish ?? "stop"
                  yield* sessions.updateMessage(handle.message)
                  return "break" as const
                }

                const finished = handle.message.finish && !["tool-calls", "unknown"].includes(handle.message.finish)
                if (finished && !handle.message.error) {
                  if (format.type === "json_schema") {
                    handle.message.error = MessageV2.AssistantError.parse(
                      new MessageV2.StructuredOutputError({
                        message: "Model did not produce structured output",
                        retries: 0,
                      }).toObject(),
                    )
                    yield* sessions.updateMessage(handle.message)
                    return "break" as const
                  }
                }

                if (result === "stop") {
                  if (handle.message.error && actionableState.has) {
                    blocked++
                  } else {
                    blocked = 0
                  }

                  const turnHalted = Boolean(!handle.message.finish || handle.message.error)
                  if (turnHalted) {
                    const assistantMsg = yield* Effect.try({
                      try: () =>
                        MessageV2.get({
                          sessionID,
                          messageID: handle.message.id,
                        }),
                      catch: () => null as null,
                    }).pipe(Effect.orElseSucceed(() => null))
                    const assistantOutput = textFromParts(assistantMsg?.parts ?? [])
                    if (!autonomous) {
                      log.info("exiting loop: direct-chat halt", { sessionID, step, autoTurns })
                      return "break" as const
                    }

                    if (!actionableState.has) {
                      log.info("exiting loop: halt detected with no actionable todo", { sessionID, step, autoTurns })
                      return "break" as const
                    }

                    yield* Effect.sync(() => markPacketStale(sessionID, "autocontinue:halt-with-todos", true))

                    const normalizeItem = (s: string) =>
                      s
                        .replace(/^-\s*\[[\s\S]\]\s*/, "")
                        .replace(/\[[^\]]*\]/g, "")
                        .trim()
                    const currentItemNorm = normalizeItem(actionableState.item)
                    const lastItemNorm = normalizeItem(lastActionableItem)

                    if (currentItemNorm && currentItemNorm === lastItemNorm) {
                      stallTurns++
                      if (stallTurns >= STALL_THRESHOLD || blocked >= 3) {
                        yield* Effect.promise(() =>
                          suppressAssistantStopMessage({ sessionID, messageID: handle.message.id }),
                        )
                        yield* Effect.promise(() =>
                          injectStallBreakDirective({
                            sessionID,
                            user: lastUser!,
                            item: actionableState.item,
                            stallTurns: Math.max(stallTurns, blocked),
                            orchestrator: agent.mode === "primary",
                            delegationAllowed: agent.tier !== "2",
                          }),
                        )
                        stallTurns = 0
                        blocked = 0
                        autoTurns++
                        return "continue" as const
                      }
                    } else {
                      stallTurns = 0
                      lastActionableItem = actionableState.item
                    }

                    // Fast-path: explicit blocker phrasing (api key, decision needed,
                    // permission denied, …) → respect immediately, no auditor LLM call.
                    if (isLikelyTrueBlocker(assistantOutput)) {
                      log.info("halt detector: explicit blocker phrasing — break", {
                        sessionID,
                        item: actionableState.item,
                        step,
                      })
                      return "break" as const
                    }

                    // Otherwise consult halt-auditor: it returns continue whenever
                    // actionable todos remain, which forces the orchestrator to keep
                    // delegating instead of asking the user "go ahead?".
                    const audit = yield* Effect.promise(() =>
                      runHaltAuditorIntervention({
                        sessionID,
                        user: lastUser!,
                        rootID: session.parentID ? session.parentID : sessionID,
                        assistantOutput,
                        actionable: actionableState,
                      }),
                    )

                    if (audit.decision === "approve") {
                      log.info("halt detector: auditor approved halt", {
                        sessionID,
                        item: actionableState.item,
                        step,
                      })
                      return "break" as const
                    }

                    log.info("halt detector: auditor rejected halt, auto-continuing", {
                      sessionID,
                      item: actionableState.item,
                      instruction: audit.instruction,
                    })

                    yield* Effect.promise(() =>
                      suppressAssistantStopMessage({ sessionID, messageID: handle.message.id }),
                    )
                    yield* Effect.promise(() =>
                      injectUserProxyDirective({
                        sessionID,
                        user: lastUser!,
                        item: actionableState.item,
                        doneCriteria: actionableState.doneCriteria,
                        instruction: audit.instruction,
                        orchestrator: agent.mode === "primary",
                        delegationAllowed: agent.tier !== "2",
                      }),
                    )
                    autoTurns++
                    return "continue" as const
                  }
                  return "break" as const
                }
                if (result === "compact") {
                  if (consecutiveCompactionFailures < MAX_CONSECUTIVE_COMPACTION_FAILURES) {
                    yield* compaction
                      .create({
                        sessionID,
                        agent: lastUser.agent,
                        model: lastUser.model,
                        auto: loopMode,
                        overflow: !handle.message.finish,
                      })
                      .pipe(
                        Effect.tap(() =>
                          Effect.sync(() => {
                            consecutiveCompactionFailures = 0
                          }),
                        ),
                        Effect.tapCause(() =>
                          Effect.sync(() => {
                            consecutiveCompactionFailures++
                          }),
                        ),
                        Effect.orDie,
                      )
                  } else {
                    log.warn("compaction circuit breaker open — skipping reactive compaction", {
                      sessionID,
                      consecutiveCompactionFailures,
                    })
                  }
                }
                return "continue" as const
              }),
              Effect.fnUntraced(function* (exit) {
                if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) yield* handle.abort()
              }),
            )
            // Phase 1c — token-budget gate. After each step, look up the
            // per-task budget (or fall back to the session-level budget if
            // configured) and ask the tracker whether the loop should keep
            // iterating. The tracker is no-op for subagents and for
            // sessions where neither budget is configured.
            //
            // Per-step accumulation: roll the just-finished assistant's
            // tokens into sessionTotalTokens BEFORE the gate fires so the
            // session-budget fallback sees up-to-date numbers.
            if (handle.message.tokens) {
              const t = handle.message.tokens
              const delta =
                (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
              sessionTotalTokens += delta
            }
            // Cache break detection — fire-and-forget observability.
            // Records a per-turn snapshot so CacheBreakDetector can attribute
            // sharp drops in cache_read ratio to model/system/tools drift or
            // proxy-side cache eviction. Logged as warn when drop > 40pp.
            if (handle.message.tokens) {
              const t = handle.message.tokens
              const inputTok = t.input ?? 0
              const cachedTok = t.cache?.read ?? 0
              CacheBreakDetector.record({
                sessionID,
                turnNumber: step,
                timestamp: Date.now(),
                inputTokens: inputTok,
                cachedTokens: cachedTok,
                cachedRatio: inputTok > 0 ? cachedTok / inputTok : 0,
                systemHash: "0",
                toolsHash: "0",
                modelID: lastUser?.model?.modelID ?? "",
                providerID: lastUser?.model?.providerID ?? "",
              })
            }
            if (!isSubagent && outcome === "continue") {
              const budgetDecision = yield* Effect.promise(async () => {
                // Session-level cumulative budget. Only fires when
                // cfg.compaction.session_budget_tokens is set.
                const sessionCap = cfg.compaction?.session_budget_tokens
                if (sessionCap && sessionCap > 0) {
                  return TokenBudget.check(budgetTracker, false, sessionCap, sessionTotalTokens)
                }
                return null
              })
              if (budgetDecision && budgetDecision.action === "stop") {
                log.info("token-budget stop", {
                  sessionID,
                  reason: budgetDecision.reason,
                  event: budgetDecision.completionEvent,
                })
                break
              }
            }
            if (outcome === "break") break
            continue
          }

          yield* compaction.prune({ sessionID }).pipe(Effect.ignore, Effect.forkIn(scope))
          return yield* lastAssistant(sessionID)
        })

      const loop: (input: { sessionID: SessionID; loopMode?: boolean }) => Effect.Effect<MessageV2.WithParts> =
        Effect.fn("SessionPrompt.loop")(function* (input: { sessionID: SessionID; loopMode?: boolean }) {
          const s = yield* InstanceState.get(state)
          const sessionID = input.sessionID
          const loopMode = input.loopMode ?? false
          const worker = getRunner(s.runners, sessionID)
          const exit = yield* worker
            .ensureRunning(
              runLoop(sessionID, loopMode).pipe(
                Effect.tapCause((cause) =>
                  Effect.promise(() => {
                    const err = Cause.squash(cause)
                    return ProviderPluginHooks.notify("session.stop.failure", {
                      sessionID,
                      error: {
                        message: err instanceof Error ? err.message : String(err),
                        stack: err instanceof Error ? err.stack : undefined,
                      },
                    })
                  }).pipe(Effect.ignore),
                ),
                Effect.orDie,
              ),
            )
            .pipe(Effect.exit)

          if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) return yield* exit
          return yield* exit
        })

      const shell: (input: ShellInput) => Effect.Effect<MessageV2.WithParts> = Effect.fn("SessionPrompt.shell")(
        function* (input: ShellInput) {
          const s = yield* InstanceState.get(state)
          const worker = getRunner(s.runners, input.sessionID)
          return yield* worker.startShell((signal) => shellImpl(input, signal))
        },
      )

      const command = Effect.fn("SessionPrompt.command")(function* (input: CommandInput) {
        log.info("command", input)

        // Hardcoded /loop command — activates loop mode for the session.
        // Creates a user message with the prompt text, then runs the loop
        // with loopMode=true so autonomous continuation is enabled.
        if (input.command === "loop") {
          const promptText = input.arguments?.trim() ?? ""
          yield* prompt({
            sessionID: input.sessionID,
            agent: input.agent,
            model: input.model ? Provider.parseModel(input.model) : undefined,
            noReply: true,
            parts: promptText ? [{ type: "text" as const, text: promptText }] : [],
          })
          return yield* loop({ sessionID: input.sessionID, loopMode: true })
        }

        const cmd = yield* commands.get(input.command)
        if (!cmd) {
          const available = (yield* commands.list()).map((c) => c.name)
          const hint = available.length ? ` Available commands: ${available.join(", ")}` : ""
          const error = new NamedError.Unknown({ message: `Command not found: "${input.command}".${hint}` })
          yield* bus.publish(Session.Event.Error, {
            sessionID: input.sessionID,
            error: MessageV2.AssistantError.parse(error.toObject()),
          })
          throw error
        }
        const agentName = cmd.agent ?? input.agent ?? (yield* agents.defaultAgent())

        const raw = input.arguments.match(argsRegex) ?? []
        const args = raw.map((arg) => arg.replace(quoteTrimRegex, ""))
        const templateCommand = yield* Effect.promise(async () => cmd.template)

        const placeholders = templateCommand.match(placeholderRegex) ?? []
        let last = 0
        for (const item of placeholders) {
          const value = Number(item.slice(1))
          if (value > last) last = value
        }

        const withArgs = templateCommand.replaceAll(placeholderRegex, (_, index) => {
          const position = Number(index)
          const argIndex = position - 1
          if (argIndex >= args.length) return ""
          if (position === last) return args.slice(argIndex).join(" ")
          return args[argIndex]
        })
        const usesArgumentsPlaceholder = templateCommand.includes("$ARGUMENTS")
        let template = withArgs.replaceAll("$ARGUMENTS", input.arguments)

        if (placeholders.length === 0 && !usesArgumentsPlaceholder && input.arguments.trim()) {
          template = template + "\n\n" + input.arguments
        }

        const shellMatches = ConfigMarkdown.shell(template)
        if (shellMatches.length > 0) {
          const sh = Shell.preferred()
          const results = yield* Effect.promise(() =>
            Promise.all(
              shellMatches.map(async ([, cmd]) => (await Process.text([cmd], { shell: sh, nothrow: true })).text),
            ),
          )
          let index = 0
          template = template.replace(bashRegex, () => results[index++])
        }
        template = template.trim()

        const taskModel = yield* Effect.gen(function* () {
          if (cmd.model) return Provider.parseModel(cmd.model)
          if (cmd.agent) {
            const cmdAgent = yield* agents.get(cmd.agent)
            if (cmdAgent?.model) return cmdAgent.model
          }
          if (input.model) return Provider.parseModel(input.model)
          return yield* lastModel(input.sessionID)
        })

        yield* getModel(taskModel.providerID, taskModel.modelID, input.sessionID)

        const agent = yield* agents.get(agentName)
        if (!agent) {
          const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
          const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
          const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
          yield* bus.publish(Session.Event.Error, {
            sessionID: input.sessionID,
            error: MessageV2.AssistantError.parse(error.toObject()),
          })
          throw error
        }

        const templateParts = yield* resolvePromptParts(template)
        const isSubtask = (agent.mode === "subagent" && cmd.subtask !== false) || cmd.subtask === true
        const parts = isSubtask
          ? [
              {
                type: "subtask" as const,
                agent: agent.name,
                description: cmd.description ?? "",
                command: input.command,
                model: { providerID: taskModel.providerID, modelID: taskModel.modelID },
                prompt: templateParts.find((y) => y.type === "text")?.text ?? "",
              },
            ]
          : [...templateParts, ...(input.parts ?? [])]

        const userAgent = isSubtask ? (input.agent ?? (yield* agents.defaultAgent())) : agentName
        const userModel = isSubtask
          ? input.model
            ? Provider.parseModel(input.model)
            : yield* lastModel(input.sessionID)
          : taskModel

        yield* ProviderPluginHooks.triggerEffect(
          "command.execute.before",
          { command: input.command, sessionID: input.sessionID, arguments: input.arguments },
          { parts },
        )

        const result = yield* prompt({
          sessionID: input.sessionID,
          messageID: input.messageID,
          model: userModel,
          agent: userAgent,
          parts,
          system: input.system,
          variant: input.variant,
        })
        yield* bus.publish(Command.Event.Executed, {
          name: input.command,
          sessionID: input.sessionID,
          arguments: input.arguments,
          messageID: result.info.id,
        })
        return result
      })

      return Service.of({
        assertNotBusy,
        cancel,
        prompt,
        loop,
        shell,
        command,
        resolvePromptParts,
      })
    }),
  )

  const defaultLayer = Layer.unwrap(
    Effect.sync(() =>
      layer.pipe(
        Layer.provide(SessionStatus.layer),
        Layer.provide(SessionCompaction.defaultLayer),
        Layer.provide(SessionProcessor.defaultLayer),
        Layer.provide(Command.defaultLayer),
        Layer.provide(Permission.defaultLayer),
        Layer.provide(FileTime.defaultLayer),
        Layer.provide(ToolRegistry.defaultLayer),
        Layer.provide(Truncate.layer),
        Layer.provide(Provider.defaultLayer),
        Layer.provide(AppFileSystem.defaultLayer),
        Layer.provide(Session.defaultLayer),
        Layer.provide(Agent.defaultLayer),
        Layer.provide(Bus.layer),
        Layer.provide(CrossSpawnSpawner.defaultLayer),
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(Config.defaultLayer),
      ),
    ),
  )
  const { runPromise } = makeRuntime(Service, defaultLayer)

  export async function assertNotBusy(sessionID: SessionID) {
    return runPromise((svc) => svc.assertNotBusy(SessionID.zod.parse(sessionID)))
  }

  export const PromptInput = z.object({
    sessionID: SessionID.zod,
    messageID: MessageID.zod.optional(),
    model: z
      .object({
        providerID: ProviderID.zod,
        modelID: ModelID.zod,
      })
      .optional(),
    agent: z.string().optional(),
    noReply: z.boolean().optional(),
    tools: z
      .record(z.string(), z.boolean())
      .optional()
      .describe(
        "@deprecated tools and permissions have been merged, you can set permissions on the session itself now",
      ),
    format: MessageV2.Format.optional(),
    system: z.string().optional(),
    variant: z.string().optional(),
    parts: z.array(
      z.discriminatedUnion("type", [
        MessageV2.TextPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "TextPartInput",
          }),
        MessageV2.FilePart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "FilePartInput",
          }),
        MessageV2.AgentPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "AgentPartInput",
          }),
        MessageV2.SubtaskPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "SubtaskPartInput",
          }),
      ]),
    ),
  })
  export type PromptInput = z.infer<typeof PromptInput>

  export async function prompt(input: PromptInput) {
    return runPromise((svc) => svc.prompt(PromptInput.parse(input)))
  }

  export async function resolvePromptParts(template: string) {
    return runPromise((svc) => svc.resolvePromptParts(z.string().parse(template)))
  }

  export async function cancel(sessionID: SessionID) {
    return runPromise((svc) => svc.cancel(SessionID.zod.parse(sessionID)))
  }

  // ---------------------------------------------------------------------------
  // onCancel — subscribe to hard-cancel events for a parent session.
  // Returns an unsubscribe function. Callback receives the cancel reason string.
  // Used by BG subagent lifecycle to propagate hard-cancel without coupling to
  // the parent's AbortSignal (which also fires on soft aborts like compaction).
  // ---------------------------------------------------------------------------
  const cancelListeners = new Map<string, Set<(reason: string) => void>>()

  export function onCancel(parentSessionID: string, cb: (reason: string) => void): () => void {
    let set = cancelListeners.get(parentSessionID)
    if (!set) {
      set = new Set()
      cancelListeners.set(parentSessionID, set)
    }
    set.add(cb)
    return () => {
      cancelListeners.get(parentSessionID)?.delete(cb)
    }
  }

  export function notifyCancelListeners(parentSessionID: string, reason: string) {
    cancelListeners.get(parentSessionID)?.forEach((cb) => cb(reason))
  }

  export const LoopInput = z.object({
    sessionID: SessionID.zod,
    loopMode: z.boolean().optional().default(false),
  })

  export async function loop(input: { sessionID: SessionID; loopMode?: boolean }) {
    return runPromise((svc) => svc.loop(LoopInput.parse(input)))
  }

  export const ShellInput = z.object({
    sessionID: SessionID.zod,
    messageID: MessageID.zod.optional(),
    agent: z.string(),
    model: z
      .object({
        providerID: ProviderID.zod,
        modelID: ModelID.zod,
      })
      .optional(),
    command: z.string(),
  })
  export type ShellInput = z.infer<typeof ShellInput>

  export async function shell(input: ShellInput) {
    return runPromise((svc) => svc.shell(ShellInput.parse(input)))
  }

  export const CommandInput = z.object({
    messageID: MessageID.zod.optional(),
    sessionID: SessionID.zod,
    agent: z.string().optional(),
    model: z.string().optional(),
    arguments: z.string(),
    command: z.string(),
    system: z.string().optional(),
    variant: z.string().optional(),
    parts: z
      .array(
        z.discriminatedUnion("type", [
          MessageV2.FilePart.omit({
            messageID: true,
            sessionID: true,
          }).partial({
            id: true,
          }),
        ]),
      )
      .optional(),
  })
  export type CommandInput = z.infer<typeof CommandInput>

  export async function command(input: CommandInput) {
    return runPromise((svc) => svc.command(CommandInput.parse(input)))
  }

  /** @internal Exported for testing */
  export function createStructuredOutputTool(input: {
    schema: Record<string, any>
    onSuccess: (output: unknown) => void
  }): AITool {
    // Remove $schema property if present (not needed for tool input)
    const { $schema, ...toolSchema } = input.schema

    return tool({
      id: "StructuredOutput" as any, // AI SDK Tool type only declares `id` on the `provider` variant; runtime accepts it for all tools
      description: STRUCTURED_OUTPUT_DESCRIPTION,
      inputSchema: jsonSchema(toolSchema as any), // toolSchema is Record<string,unknown>; jsonSchema() expects JSONSchema7
      async execute(args) {
        // AI SDK validates args against inputSchema before calling execute()
        input.onSuccess(args)
        return {
          output: "Structured output captured successfully.",
          title: "Structured Output",
          metadata: { valid: true },
        }
      },
      toModelOutput({ output }) {
        return {
          type: "text",
          value: output.output,
        }
      },
    })
  }
  const bashRegex = /!`([^`]+)`/g
  // Match [Image N] as single token, quoted strings, or non-space sequences
  const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
  const placeholderRegex = /\$(\d+)/g
  const quoteTrimRegex = /^["']|["']$/g
}
