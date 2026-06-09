import type {
  Event,
  createOpencodeClient,
  Project,
  Model,
  Provider,
  Permission,
  UserMessage,
  Message,
  Part,
  Auth,
  Config as SDKConfig,
} from "@opencode-ai/sdk"
import type { Provider as ProviderV2, Model as ModelV2 } from "@opencode-ai/sdk/v2"

import type { BunShell } from "./shell.js"
import { type ToolDefinition } from "./tool.js"

export * from "./tool.js"

export type ProviderContext = {
  source: "env" | "config" | "custom" | "api"
  info: Provider
  options: Record<string, any>
}

export type PluginInput = {
  client: ReturnType<typeof createOpencodeClient>
  project: Project
  directory: string
  worktree: string
  serverUrl: URL
  $: BunShell
}

export type PluginOptions = Record<string, unknown>

export type Config = Omit<SDKConfig, "plugin"> & {
  plugin?: Array<string | [string, PluginOptions]>
}

export type Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>

export type PluginModule = {
  id?: string
  server: Plugin
  tui?: never
}

type Rule = {
  key: string
  op: "eq" | "neq"
  value: string
}

export type AuthHook = {
  provider: string
  loader?: (auth: () => Promise<Auth>, provider: Provider) => Promise<Record<string, any>>
  methods: (
    | {
        type: "oauth"
        label: string
        prompts?: Array<
          | {
              type: "text"
              key: string
              message: string
              placeholder?: string
              validate?: (value: string) => string | undefined
              /** @deprecated Use `when` instead */
              condition?: (inputs: Record<string, string>) => boolean
              when?: Rule
            }
          | {
              type: "select"
              key: string
              message: string
              options: Array<{
                label: string
                value: string
                hint?: string
              }>
              /** @deprecated Use `when` instead */
              condition?: (inputs: Record<string, string>) => boolean
              when?: Rule
            }
        >
        authorize(inputs?: Record<string, string>): Promise<AuthOAuthResult>
      }
    | {
        type: "api"
        label: string
        prompts?: Array<
          | {
              type: "text"
              key: string
              message: string
              placeholder?: string
              validate?: (value: string) => string | undefined
              /** @deprecated Use `when` instead */
              condition?: (inputs: Record<string, string>) => boolean
              when?: Rule
            }
          | {
              type: "select"
              key: string
              message: string
              options: Array<{
                label: string
                value: string
                hint?: string
              }>
              /** @deprecated Use `when` instead */
              condition?: (inputs: Record<string, string>) => boolean
              when?: Rule
            }
        >
        authorize?(inputs?: Record<string, string>): Promise<
          | {
              type: "success"
              key: string
              provider?: string
            }
          | {
              type: "failed"
            }
        >
      }
  )[]
}

export type AuthOAuthResult = { url: string; instructions: string } & (
  | {
      method: "auto"
      callback(): Promise<
        | ({
            type: "success"
            provider?: string
          } & (
            | {
                refresh: string
                access: string
                expires: number
                accountId?: string
                enterpriseUrl?: string
              }
            | { key: string }
          ))
        | {
            type: "failed"
          }
      >
    }
  | {
      method: "code"
      callback(code: string): Promise<
        | ({
            type: "success"
            provider?: string
          } & (
            | {
                refresh: string
                access: string
                expires: number
                accountId?: string
                enterpriseUrl?: string
              }
            | { key: string }
          ))
        | {
            type: "failed"
          }
      >
    }
)

export type ProviderHookContext = {
  auth?: Auth
}

export type ProviderHook = {
  id: string
  models?: (provider: ProviderV2, ctx: ProviderHookContext) => Promise<Record<string, ModelV2>>
}

/** @deprecated Use AuthOAuthResult instead. */
export type AuthOuathResult = AuthOAuthResult

export interface Hooks {
  event?: (input: { event: Event }) => Promise<void>
  config?: (input: Config) => Promise<void>
  tool?: {
    [key: string]: ToolDefinition
  }
  auth?: AuthHook
  provider?: ProviderHook
  /**
   * Called when a new message is received
   */
  "chat.message"?: (
    input: {
      sessionID: string
      agent?: string
      model?: { providerID: string; modelID: string }
      messageID?: string
      variant?: string
    },
    output: { message: UserMessage; parts: Part[] },
  ) => Promise<void>
  /**
   * Modify parameters sent to LLM
   */
  "chat.params"?: (
    input: { sessionID: string; agent: string; model: Model; provider: ProviderContext; message: UserMessage },
    output: {
      temperature: number
      topP: number
      topK: number
      maxOutputTokens: number | undefined
      options: Record<string, any>
    },
  ) => Promise<void>
  "chat.headers"?: (
    input: { sessionID: string; agent: string; model: Model; provider: ProviderContext; message: UserMessage },
    output: { headers: Record<string, string> },
  ) => Promise<void>
  "permission.ask"?: (input: Permission, output: { status: "ask" | "deny" | "allow" }) => Promise<void>
  "command.execute.before"?: (
    input: { command: string; sessionID: string; arguments: string },
    output: { parts: Part[] },
  ) => Promise<void>
  /**
   * Fires immediately before a tool executes. Plugins can:
   *   - Inspect or rewrite `output.args` (the arguments the tool will receive)
   *   - DENY the execution by setting `output.deny = "<reason>"`. When deny
   *     is non-empty, opencode short-circuits the tool and surfaces the reason
   *     as a synthetic tool-result error to the model. Use this for audit
   *     gates, dynamic permission decisions, secret-leak prevention, etc.
   */
  "tool.execute.before"?: (
    input: { tool: string; sessionID: string; callID: string },
    output: { args: any; deny?: string },
  ) => Promise<void>
  "shell.env"?: (
    input: { cwd: string; sessionID?: string; callID?: string },
    output: { env: Record<string, string> },
  ) => Promise<void>
  "tool.execute.after"?: (
    input: { tool: string; sessionID: string; callID: string; args: any },
    output: {
      title: string
      output: string
      metadata: any
    },
  ) => Promise<void>
  "experimental.chat.messages.transform"?: (
    input: {},
    output: {
      messages: {
        info: Message
        parts: Part[]
      }[]
    },
  ) => Promise<void>
  "experimental.chat.system.transform"?: (
    input: { sessionID?: string; model: Model },
    output: {
      system: string[]
    },
  ) => Promise<void>
  /**
   * Called before session compaction starts. Allows plugins to customize
   * the compaction prompt.
   *
   * - `context`: Additional context strings appended to the default prompt
   * - `prompt`: If set, replaces the default compaction prompt entirely
   */
  "experimental.session.compacting"?: (
    input: { sessionID: string },
    output: { context: string[]; prompt?: string },
  ) => Promise<void>
  "experimental.text.complete"?: (
    input: { sessionID: string; messageID: string; partID: string },
    output: { text: string },
  ) => Promise<void>
  /**
   * Modify tool definitions (description and parameters) sent to LLM
   */
  "tool.definition"?: (input: { toolID: string }, output: { description: string; parameters: any }) => Promise<void>

  /**
   * Fires after each LLM turn completes (post-sampling hook, ported from qcode).
   * Fires once per model call — after the assistant message is fully streamed
   * and persisted, before the next iteration of the run loop. Use for:
   *   - session memory extraction triggers
   *   - per-turn telemetry / cost tracking
   *   - automatic note-taking / summarisation
   *   - external notification (Slack, webhook) on turn end
   *
   * `stopReason` mirrors the AI SDK stop_reason:
   *   "end_turn"   — model finished naturally
   *   "tool_use"   — model emitted tool calls (loop continues)
   *   "max_tokens" — output was truncated
   */
  "chat.assistant.complete"?: (
    input: {
      sessionID: string
      messageID: string
      agent: string
      model: { providerID: string; modelID: string }
      stopReason: "end_turn" | "tool_use" | "max_tokens" | string
      usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
    },
    output: void,
  ) => Promise<void>

  // ─── Lifecycle hooks (ported from Claude Code's hook taxonomy) ──────────
  //
  // These events expose the broader session lifecycle to plugins so they can
  // integrate with audit logs, notification systems, external task trackers,
  // metrics pipelines, etc. All hooks follow the same `(input, output) =>
  // Promise<void>` shape as the existing hooks. Output is `void` for events
  // that are observation-only.
  //
  // Mapping reference:
  //   session.start          ← Claude Code SessionStart
  //   session.end            ← Claude Code SessionEnd
  //   session.stop           ← Claude Code Stop
  //   session.stop.failure   ← Claude Code StopFailure
  //   chat.user.submit       ← Claude Code UserPromptSubmit
  //   session.compact.before ← Claude Code PreCompact
  //   session.compact.after  ← Claude Code PostCompact
  //   permission.request     ← Claude Code PermissionRequest
  //   permission.deny        ← Claude Code PermissionDenied
  //   subagent.start         ← Claude Code SubagentStart
  //   subagent.stop          ← Claude Code SubagentStop
  //   tool.execute.failure   ← Claude Code PostToolUseFailure
  //   task.created           ← Claude Code TaskCreated
  //   task.completed         ← Claude Code TaskCompleted
  //   config.change          ← Claude Code ConfigChange
  //   worktree.create        ← Claude Code WorktreeCreate
  //   worktree.remove        ← Claude Code WorktreeRemove
  //   instructions.loaded    ← Claude Code InstructionsLoaded
  //   file.changed           ← Claude Code FileChanged
  //   setup                  ← Claude Code Setup

  /**
   * Fires once per runLoop invocation when a session starts processing a
   * user request. Use for per-session setup, telemetry start markers, etc.
   */
  "session.start"?: (
    input: { sessionID: string; agent: string; model: { providerID: string; modelID: string } },
    output: void,
  ) => Promise<void>

  /**
   * Fires when the runLoop exits cleanly (no error). The reason indicates
   * WHY the loop stopped: "complete" (model emitted a stop reason),
   * "no-actionable" (autonomous loop ran out of actionable todos),
   * "max-turns" (autocontinue cap reached). Use for per-session teardown,
   * cost reporting, OS notifications.
   */
  "session.end"?: (
    input: { sessionID: string; reason: "complete" | "no-actionable" | "max-turns" | "direct-chat-idle" },
    output: void,
  ) => Promise<void>

  /**
   * Fires on EVERY runLoop termination (clean or error). If you only care
   * about clean exits, listen on `session.end`. If you only care about
   * errors, listen on `session.stop.failure`. This hook fires for both.
   */
  "session.stop"?: (
    input: { sessionID: string; reason: string; error?: { message: string } },
    output: void,
  ) => Promise<void>

  /**
   * Fires only when the runLoop terminates due to an unhandled error.
   * Includes the error message and stack for diagnostics. Use for error
   * reporting (Sentry/Datadog), audit logs, etc.
   */
  "session.stop.failure"?: (
    input: { sessionID: string; error: { message: string; stack?: string } },
    output: void,
  ) => Promise<void>

  /**
   * Fires when a new user message is identified as the next prompt to
   * process. Plugins can inspect the user's text but cannot modify it
   * here (use `chat.message` for modification). Use for input audit
   * logging, intent classification, etc.
   */
  "chat.user.submit"?: (
    input: { sessionID: string; messageID: string; agent: string; text: string },
    output: void,
  ) => Promise<void>

  /**
   * Fires immediately BEFORE the compaction agent runs. Use to checkpoint
   * state, snapshot context for diff-after compaction, etc. Distinct from
   * the existing `experimental.session.compacting` hook which lets you
   * customize the compaction PROMPT — this one is observation-only and
   * always fires regardless of plugin overrides.
   */
  "session.compact.before"?: (
    input: { sessionID: string; parentID: string; auto: boolean; overflow?: boolean },
    output: void,
  ) => Promise<void>

  /**
   * Fires AFTER compaction completes (success or stop). The result tells
   * you whether the compaction produced a usable summary ("compact"),
   * succeeded and the loop should continue ("continue"), or hit an error
   * and the loop should stop ("stop").
   */
  "session.compact.after"?: (
    input: { sessionID: string; result: "compact" | "continue" | "stop"; durationMs: number },
    output: void,
  ) => Promise<void>

  /**
   * Fires every time a permission check is invoked (regardless of the
   * outcome). For deny-specific listening use `permission.deny`. The
   * payload includes the requested permission, the matched pattern, and
   * the active ruleset for full audit-log context.
   */
  "permission.request"?: (
    input: { sessionID?: string; permission: string; pattern: string; ruleset: any[] },
    output: void,
  ) => Promise<void>

  /**
   * Fires when a permission check denies. Distinct from `permission.request`
   * which fires for ALL checks. Use for security alerts, audit log entries
   * that need to highlight denials specifically.
   */
  "permission.deny"?: (
    input: { sessionID?: string; permission: string; pattern: string; ruleset: any[] },
    output: void,
  ) => Promise<void>

  /**
   * Fires when the `task` tool spawns a subagent child session. Use to
   * track parent-child session relationships, surface subagent dispatch
   * in external dashboards, etc.
   */
  "subagent.start"?: (
    input: { parentSessionID: string; sessionID: string; agent: string; description: string },
    output: void,
  ) => Promise<void>

  /**
   * Fires when a subagent session terminates (success or error). Mirrors
   * `subagent.start`. The result/error fields are populated based on
   * outcome.
   */
  "subagent.stop"?: (
    input: { parentSessionID: string; sessionID: string; result?: string; error?: { message: string } },
    output: void,
  ) => Promise<void>

  /**
   * Fires when a tool execution THROWS (an exception, not a tool-result
   * error). For tool-result errors (the model's tool call returned an
   * error string), listen on `tool.execute.after` and inspect output.
   */
  "tool.execute.failure"?: (
    input: { tool: string; sessionID: string; callID: string; args: any; error: { message: string } },
    output: void,
  ) => Promise<void>

  /**
   * Fires when a new todo item is added to the active task note. Use for
   * external task tracker integration (Linear, Jira, GitHub Issues, etc).
   */
  "task.created"?: (
    input: { sessionID: string; taskNotePath: string; content: string; taskType?: string },
    output: void,
  ) => Promise<void>

  /**
   * Fires when a todo item is marked done. Includes the outcome_met flag
   * for root-level completions (root todo done requires explicit outcome
   * evaluation per opencode's completion ritual).
   */
  "task.completed"?: (
    input: { sessionID: string; taskNotePath: string; content: string; outcomeMet?: boolean },
    output: void,
  ) => Promise<void>

  /**
   * Fires when opencode detects that opencode.json content has changed
   * (via content-hash check on read). Use for plugins that need to react
   * to live config edits without restarting opencode.
   */
  "config.change"?: (input: { directory: string }, output: void) => Promise<void>

  /**
   * Fires when the `enter_worktree` tool successfully creates a new git
   * worktree. Use for external CI/CD integrations, branch tracking, etc.
   */
  "worktree.create"?: (
    input: { sessionID: string; path: string; branch: string; name?: string },
    output: void,
  ) => Promise<void>

  /**
   * Fires when the `exit_worktree` tool successfully removes a worktree
   * (either keeping or deleting the underlying branch).
   */
  "worktree.remove"?: (input: { sessionID: string; path: string; branch?: string }, output: void) => Promise<void>

  /**
   * Fires when the system prompt is rebuilt for a step. Includes the
   * fully-assembled system array (environment + skills + instructions
   * + agent prompt). Use for system prompt audit / IDE display.
   */
  "instructions.loaded"?: (
    input: { sessionID: string; agent: string; model: { providerID: string; modelID: string }; system: string[] },
    output: void,
  ) => Promise<void>

  /**
   * Fires when opencode detects file modifications (via the existing
   * snapshot/diff infrastructure). The diffs payload contains paths
   * AND optional before/after content snapshots for richer plugin use
   * cases (e.g. external file watchers, IDE refresh triggers).
   */
  "file.changed"?: (
    input: { sessionID: string; diffs: Array<{ path: string; before?: string; after?: string }> },
    output: void,
  ) => Promise<void>

  /**
   * Fires once at process startup, AFTER the plugin system finishes
   * initializing but BEFORE any session runs. Use for global one-time
   * setup work that depends on the plugin loader being ready.
   */
  setup?: (input: { directory: string }, output: void) => Promise<void>
}
