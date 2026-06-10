import {
  createContext,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  on,
  onMount,
  Show,
  Switch,
  useContext,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import path from "path"
import { readFile, writeFile } from "node:fs/promises"
import { createTwoFilesPatch } from "diff"
import { useRoute, useRouteData } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { SplitBorder } from "@tui/component/border"
import { Spinner } from "@tui/component/spinner"
import { selectedForeground, useTheme } from "@tui/context/theme"
import { extractThemeTokens } from "@tui/context/theme-tokens"
import { contentWidth as getContentWidth } from "@tui/context/terminal-breakpoints"
import { BoxRenderable, ScrollBoxRenderable, addDefaultParsers, TextAttributes, RGBA } from "@opentui/core"
import { Prompt, type PromptRef } from "@tui/component/prompt"
import type {
  AssistantMessage,
  Part,
  Provider,
  SessionTokenStats,
  ToolPart,
  UserMessage,
  TextPart,
  ReasoningPart,
} from "@opencode-ai/sdk/v2"
import { useLocal } from "@tui/context/local"
import { Locale } from "@/foundation/util/locale"
import {
  type BashToolInput,
  type BashToolMetadata,
  type TaskToolInput,
  type TaskToolMetadata,
  type GenericToolInput,
  type GenericToolMetadata,
} from "@tui/context/tool-port"
import { TodoItem, type TodoItemData } from "@tui/component/todo-item"
import { useKeyboard, useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
import { useSDK } from "@tui/context/sdk"
import { useCommandDialog } from "@tui/component/dialog-command"
import type { DialogContext } from "@tui/ui/dialog"
import { useKeybind } from "@tui/context/keybind"
import { parsePatch } from "diff"
import { useDialog } from "@/surface/cli/cmd/tui/ui/dialog"
import { DialogMessage } from "@/surface/cli/cmd/tui/routes/session/dialog-message"
import type { PromptInfo } from "@/surface/cli/cmd/tui/component/prompt/history"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { DialogTimeline } from "@/surface/cli/cmd/tui/routes/session/dialog-timeline"
import { DialogForkFromTimeline } from "@/surface/cli/cmd/tui/routes/session/dialog-fork-from-timeline"
import { DialogSessionRename } from "@/surface/cli/cmd/tui/component/dialog-session-rename"
import { SubagentFooter } from "@/surface/cli/cmd/tui/routes/session/subagent-footer.tsx"
import { Flag } from "@/foundation/flag/flag"
import { LANGUAGE_EXTENSIONS } from "@/surface/ide/language"
import parsers from "../../../../../../../parsers-config.ts"
import { Clipboard } from "@/surface/cli/cmd/tui/util/clipboard"
import { Toast, useToast } from "@/surface/cli/cmd/tui/ui/toast"
import { useKV } from "@/surface/cli/cmd/tui/context/kv.tsx"
import { Editor } from "@/surface/cli/cmd/tui/util/editor"
import { usePromptRef } from "@/surface/cli/cmd/tui/context/prompt"
import { useExit } from "@/surface/cli/cmd/tui/context/exit"
import { DialogPrompt } from "@/surface/cli/cmd/tui/ui/dialog-prompt"
import { Filesystem } from "@/foundation/util/filesystem"
import { Global } from "@/filesystem/global"
import { PermissionPrompt } from "@/surface/cli/cmd/tui/routes/session/permission"
import { DialogExportOptions } from "@/surface/cli/cmd/tui/ui/dialog-export-options"
import * as Model from "@/surface/cli/cmd/tui/util/model"
import { formatTranscript } from "@/surface/cli/cmd/tui/util/transcript"
import { UI } from "@/surface/cli/ui.ts"
import { useTuiConfig } from "@/surface/cli/cmd/tui/context/tui-config"
import { getScrollAcceleration } from "@/surface/cli/cmd/tui/util/scroll"
import { TuiPluginRuntime } from "@/surface/cli/cmd/tui/plugin"
import {
  appendTodoAgentResponse,
  markTodoAgentCommentResolved,
  parseTodoAgentTasks,
  pendingTodoAgentComments,
  type TodoAgentTask,
} from "@/process/session/todo-agent-protocol"

addDefaultParsers(parsers.parsers)

const context = createContext<{
  width: number
  sessionID: string
  conceal: () => boolean
  showThinking: () => boolean
  showTimestamps: () => boolean
  showDetails: () => boolean
  showGenericToolOutput: () => boolean
  diffWrapMode: () => "word" | "none"
  providers: () => ReadonlyMap<string, Provider>
  sync: ReturnType<typeof useSync>
  tui: ReturnType<typeof useTuiConfig>
}>()

function use() {
  const ctx = useContext(context)
  if (!ctx) throw new Error("useContext must be used within a Session component")
  return ctx
}

type TokenCountsLike = {
  total?: number
  input: number
  output: number
  reasoning: number
  cache: {
    read: number
    write: number
  }
}

type ContextWindowStats = {
  providerID?: string
  modelID?: string
  modelName?: string
  hardLimit?: number
  inputLimit?: number
  outputReserve?: number
  softLimit?: number
  used: number
  availableHard?: number
  availableInput?: number
  availableSoft?: number
  usedPctHard?: number
  usedPctInput?: number
  usedPctSoft?: number
  estimatedTotal: number
  components: Array<{ name: string; tokens: number; pct: number; detail?: string }>
  tools: Array<{ name: string; calls: number; inputTokens: number; outputTokens: number; totalTokens: number }>
  callCount: number
  avgCallTokens: number
  totalToolCalls: number
  totalToolCallTokens: number
  avgToolCallsPerLLM: number
  maxToolCallsPerLLM: number
}

type SessionStatsWithContext = SessionTokenStats & { context: ContextWindowStats }

function sumTokens(tokens: TokenCountsLike) {
  return tokens.total ?? tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

export function Session() {
  const route = useRouteData("session")
  const { navigate } = useRoute()
  const sync = useSync()
  const tuiConfig = useTuiConfig()
  const kv = useKV()
  const { theme, syntax } = useTheme()
  const tokens = extractThemeTokens(theme)
  const promptRef = usePromptRef()

  // Define view signal early, before it's used in visible memo
  const [view, setView] = kv.signal<"chat" | "todo" | "files" | "stats">("session_view", "chat")

  const session = createMemo(() => sync.session.get(route.sessionID))
  const children = createMemo(() => {
    const parentID = session()?.parentID ?? session()?.id
    return sync.data.session
      .filter((x) => x.parentID === parentID || x.id === parentID)
      .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  })
  const messages = createMemo(() => sync.data.message[route.sessionID] ?? [])
  const permissions = createMemo(() => {
    if (session()?.parentID) return []
    return children().flatMap((x) => sync.data.permission[x.id] ?? [])
  })
  const visible = createMemo(() => permissions().length === 0 && view() === "chat")
  const disabled = createMemo(() => permissions().length > 0)

  const pending = createMemo(() => {
    return messages().findLast((x) => x.role === "assistant" && !x.time.completed)?.id
  })

  const lastAssistant = createMemo(() => {
    return messages().findLast((x) => x.role === "assistant")
  })

  const dimensions = useTerminalDimensions()
  const [conceal, setConceal] = createSignal(true)
  const [showThinking, setShowThinking] = kv.signal("thinking_visibility", true)
  const [timestamps, setTimestamps] = kv.signal<"hide" | "show">("timestamps", "hide")
  const [showDetails, setShowDetails] = kv.signal("tool_details_visibility", true)
  const [showAssistantMetadata, setShowAssistantMetadata] = kv.signal("assistant_metadata_visibility", true)
  const [showScrollbar, setShowScrollbar] = kv.signal("scrollbar_visible", true)
  const [diffWrapMode] = kv.signal<"word" | "none">("diff_wrap_mode", "word")
  const [animationsEnabled, setAnimationsEnabled] = kv.signal("animations_enabled", true)
  const [showGenericToolOutput, setShowGenericToolOutput] = kv.signal("generic_tool_output_visibility", false)

  const showTimestamps = createMemo(() => timestamps() === "show")
  const contentWidth = createMemo(() => getContentWidth(dimensions().width, false))
  const providers = createMemo(() => Model.index(sync.data.provider))
  const sessionCost = createMemo(() =>
    messages().reduce((sum, item) => sum + (item.role === "assistant" ? item.cost : 0), 0),
  )
  const contextUsage = createMemo(() => {
    const last = lastAssistant()
    if (!last || last.tokens.output <= 0) {
      return {
        tokens: 0,
        limit: undefined as number | undefined,
        percent: undefined as number | undefined,
        model: undefined as string | undefined,
      }
    }
    const tokens = sumTokens(last.tokens)
    const model = Model.get(providers(), last.providerID, last.modelID)
    const limit = model?.limit.context
    return {
      tokens,
      limit,
      percent: limit ? Math.round((tokens / limit) * 100) : undefined,
      model: model?.name ?? last.modelID,
    }
  })
  const contextLabel = createMemo(() => {
    const ctx = contextUsage()
    if (!ctx.tokens) return "ctx 0"
    const used = Locale.number(ctx.tokens)
    if (!ctx.limit) return `ctx ${used}`
    return `ctx ${used}/${Locale.number(ctx.limit)} (${ctx.percent}%)`
  })
  const currentFolder = createMemo(() => {
    const dir = sync.data.path.directory || process.cwd()
    const home = Global.Path.home
    const display = home && (dir === home || dir.startsWith(home + path.sep)) ? dir.replace(home, "~") : dir
    return sync.data.vcs?.branch ? `${display}:${sync.data.vcs.branch}` : display
  })
  const sessionTitle = createMemo(() =>
    Locale.truncate(session()?.title ?? "Untitled", Math.max(20, Math.min(70, contentWidth() - 45))),
  )

  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))

  createEffect(() => {
    if (session()?.workspaceID) {
      sdk.setWorkspace(session()?.workspaceID)
    }
  })

  createEffect(async () => {
    await sync.session
      .sync(route.sessionID)
      .then(() => {
        if (scroll) scroll.scrollBy(100_000)
      })
      .catch((e) => {
        console.error(e)
        toast.show({
          message: `Session not found: ${route.sessionID}`,
          variant: "error",
        })
        return navigate({ type: "home" })
      })
  })

  const toast = useToast()
  const sdk = useSDK()

  // Stats resource — refetched whenever the view switches to "stats" or messages change
  const [snapshotFetchedAt, setSnapshotFetchedAt] = createSignal<number | undefined>(undefined)
  const [now, setNow] = createSignal(Date.now())
  const [stats, { refetch: refetchStats }] = createResource<SessionStatsWithContext | undefined>(() =>
    sdk.client.session.stats({ sessionID: route.sessionID }).then((r) => {
      setSnapshotFetchedAt(Date.now())
      return r.data ?? undefined
    }),
  )
  createEffect(
    on(
      () => view() === "stats",
      (active) => {
        if (active) refetchStats()
      },
    ),
  )
  // Also refetch when a new assistant message completes while stats tab is open
  createEffect(
    on(
      () => messages().filter((m) => m.role === "assistant").length,
      () => {
        if (view() === "stats") refetchStats()
      },
    ),
  )
  // Auto-refresh stats every 30s while the stats tab is open
  createEffect(() => {
    if (view() !== "stats") return
    const id = setInterval(() => refetchStats(), 30_000)
    return () => clearInterval(id)
  })
  // Tick "now" every 5s so "last updated Xs ago" stays current
  createEffect(() => {
    if (view() !== "stats") return
    const id = setInterval(() => setNow(Date.now()), 5_000)
    return () => clearInterval(id)
  })

  // Handle initial prompt from fork
  let seeded = false
  let lastSwitch: string | undefined = undefined
  sdk.event.on("message.part.updated", (evt) => {
    const part = evt.properties.part
    if (part.type !== "tool") return
    if (part.sessionID !== route.sessionID) return
    if (part.state.status !== "completed") return
    if (part.id === lastSwitch) return

    if (part.tool === "plan_exit") {
      local.agent.set("orchestrator")
      lastSwitch = part.id
    } else if (part.tool === "plan_enter") {
      local.agent.set("planner")
      lastSwitch = part.id
    }
  })

  let scroll: ScrollBoxRenderable
  let prompt: PromptRef | undefined
  const bind = (r: PromptRef | undefined) => {
    prompt = r
    promptRef.set(r)
    if (seeded || !route.initialPrompt || !r) return
    seeded = true
    r.set(route.initialPrompt)
  }
  const keybind = useKeybind()
  const dialog = useDialog()
  const renderer = useRenderer()

  // Allow exit from child sessions as well
  const exit = useExit()

  createEffect(() => {
    const title = Locale.truncate(session()?.title ?? "", 50)
    const pad = (text: string) => text.padEnd(10, " ")
    const weak = (text: string) => UI.Style.TEXT_DIM + pad(text) + UI.Style.TEXT_NORMAL
    const logo = UI.logo("  ").split(/\r?\n/)
    return exit.message.set(
      [
        `${logo[0] ?? ""}`,
        `${logo[1] ?? ""}`,
        `${logo[2] ?? ""}`,
        `${logo[3] ?? ""}`,
        ``,
        `  ${weak("Session")}${UI.Style.TEXT_NORMAL_BOLD}${title}${UI.Style.TEXT_NORMAL}`,
        `  ${weak("Continue")}${UI.Style.TEXT_NORMAL_BOLD}opencode -s ${session()?.id}${UI.Style.TEXT_NORMAL}`,
        ``,
      ].join("\n"),
    )
  })

  useKeyboard((evt) => {
    if (!session()?.parentID) return
    if (keybind.match("app_exit", evt)) {
      exit()
    }
  })

  // Helper: Find next visible message boundary in direction
  const findNextVisibleMessage = (direction: "next" | "prev"): string | null => {
    const children = scroll.getChildren()
    const messagesList = messages()
    const scrollTop = scroll.y

    // Get visible messages sorted by position, filtering for valid non-synthetic, non-ignored content
    const visibleMessages = children
      .filter((c) => {
        if (!c.id) return false
        const message = messagesList.find((m) => m.id === c.id)
        if (!message) return false

        // Check if message has valid non-synthetic, non-ignored text parts
        const parts = sync.data.part[message.id]
        if (!parts || !Array.isArray(parts)) return false

        return parts.some((part) => part && part.type === "text" && !part.synthetic && !part.ignored)
      })
      .sort((a, b) => a.y - b.y)

    if (visibleMessages.length === 0) return null

    if (direction === "next") {
      // Find first message below current position
      return visibleMessages.find((c) => c.y > scrollTop + 10)?.id ?? null
    }
    // Find last message above current position
    return [...visibleMessages].reverse().find((c) => c.y < scrollTop - 10)?.id ?? null
  }

  // Helper: Scroll to message in direction or fallback to page scroll
  const scrollToMessage = (direction: "next" | "prev", dialog: ReturnType<typeof useDialog>) => {
    const targetID = findNextVisibleMessage(direction)

    if (!targetID) {
      scroll.scrollBy(direction === "next" ? scroll.height : -scroll.height)
      dialog.clear()
      return
    }

    const child = scroll.getChildren().find((c) => c.id === targetID)
    if (child) scroll.scrollBy(child.y - scroll.y - 1)
    dialog.clear()
  }

  function toBottom() {
    setTimeout(() => {
      if (!scroll || scroll.isDestroyed) return
      scroll.scrollTo(scroll.scrollHeight)
    }, 50)
  }

  const local = useLocal()

  function moveFirstChild() {
    if (children().length === 1) return
    const next = children().find((x) => !!x.parentID)
    if (next) {
      navigate({
        type: "session",
        sessionID: next.id,
      })
    }
  }

  function moveChild(direction: number) {
    if (children().length === 1) return

    const sessions = children().filter((x) => !!x.parentID)
    let next = sessions.findIndex((x) => x.id === session()?.id) - direction

    if (next >= sessions.length) next = 0
    if (next < 0) next = sessions.length - 1
    if (sessions[next]) {
      navigate({
        type: "session",
        sessionID: sessions[next].id,
      })
    }
  }

  function childSessionHandler(func: (dialog: DialogContext) => void) {
    return (dialog: DialogContext) => {
      if (!session()?.parentID || dialog.stack.length > 0) return
      func(dialog)
    }
  }

  const command = useCommandDialog()
  command.register(() => [
    {
      title: view() === "stats" ? "Switch to chat view" : "Show stats",
      value: "session.view.stats",
      category: "Session",
      slash: {
        name: "stats-view",
        aliases: ["stats"],
      },
      onSelect: (dialog) => {
        setView((x) => (x === "stats" ? "chat" : "stats"))
        dialog.clear()
      },
    },
    {
      title: view() === "files" ? "Switch to chat view" : "Show changed files",
      value: "session.view.files",
      category: "Session",
      slash: {
        name: "files-view",
        aliases: ["files", "diff"],
      },
      onSelect: (dialog) => {
        setView((x) => (x === "files" ? "chat" : "files"))
        dialog.clear()
      },
    },
    {
      title: session()?.share?.url ? "Copy share link" : "Share session",
      value: "session.share",
      suggested: route.type === "session",
      keybind: "session_share",
      category: "Session",
      enabled: sync.data.config.share !== "disabled",
      slash: {
        name: "share",
      },
      onSelect: async (dialog) => {
        const copy = (url: string) =>
          Clipboard.copy(url)
            .then(() => toast.show({ message: "Share URL copied to clipboard!", variant: "success" }))
            .catch(() => toast.show({ message: "Failed to copy URL to clipboard", variant: "error" }))
        const url = session()?.share?.url
        if (url) {
          await copy(url)
          dialog.clear()
          return
        }
        if (!kv.get("share_consent", false)) {
          const ok = await DialogConfirm.show(dialog, "Share Session", "Are you sure you want to share it?")
          if (ok !== true) return
          kv.set("share_consent", true)
        }
        await sdk.client.session
          .share({
            sessionID: route.sessionID,
          })
          .then((res) => copy(res.data!.share!.url))
          .catch((error) => {
            toast.show({
              message: error instanceof Error ? error.message : "Failed to share session",
              variant: "error",
            })
          })
        dialog.clear()
      },
    },
    {
      title: "Rename session",
      value: "session.rename",
      keybind: "session_rename",
      category: "Session",
      slash: {
        name: "rename",
      },
      onSelect: (dialog) => {
        dialog.replace(() => <DialogSessionRename session={route.sessionID} />)
      },
    },
    {
      title: "Jump to message",
      value: "session.timeline",
      keybind: "session_timeline",
      category: "Session",
      slash: {
        name: "timeline",
      },
      onSelect: (dialog) => {
        dialog.replace(() => (
          <DialogTimeline
            onMove={(messageID) => {
              const child = scroll.getChildren().find((child) => {
                return child.id === messageID
              })
              if (child) scroll.scrollBy(child.y - scroll.y - 1)
            }}
            sessionID={route.sessionID}
            setPrompt={(promptInfo) => prompt?.set(promptInfo)}
          />
        ))
      },
    },
    {
      title: "Fork from message",
      value: "session.fork",
      keybind: "session_fork",
      category: "Session",
      slash: {
        name: "fork",
      },
      onSelect: (dialog) => {
        dialog.replace(() => (
          <DialogForkFromTimeline
            onMove={(messageID) => {
              const child = scroll.getChildren().find((child) => {
                return child.id === messageID
              })
              if (child) scroll.scrollBy(child.y - scroll.y - 1)
            }}
            sessionID={route.sessionID}
          />
        ))
      },
    },
    {
      title: "Compact session",
      value: "session.compact",
      keybind: "session_compact",
      category: "Session",
      slash: {
        name: "compact",
        aliases: ["summarize"],
      },
      onSelect: (dialog) => {
        const selectedModel = local.model.current()
        if (!selectedModel) {
          toast.show({
            variant: "warning",
            message: "Connect a provider to summarize this session",
            duration: 3000,
          })
          return
        }
        sdk.client.session.summarize({
          sessionID: route.sessionID,
          modelID: selectedModel.modelID,
          providerID: selectedModel.providerID,
        })
        dialog.clear()
      },
    },
    {
      title: "Unshare session",
      value: "session.unshare",
      keybind: "session_unshare",
      category: "Session",
      enabled: !!session()?.share?.url,
      slash: {
        name: "unshare",
      },
      onSelect: async (dialog) => {
        await sdk.client.session
          .unshare({
            sessionID: route.sessionID,
          })
          .then(() => toast.show({ message: "Session unshared successfully", variant: "success" }))
          .catch((error) => {
            toast.show({
              message: error instanceof Error ? error.message : "Failed to unshare session",
              variant: "error",
            })
          })
        dialog.clear()
      },
    },
    {
      title: "Undo previous message",
      value: "session.undo",
      keybind: "messages_undo",
      category: "Session",
      slash: {
        name: "undo",
      },
      onSelect: async (dialog) => {
        const status = sync.data.session_status?.[route.sessionID]
        if (status?.type !== "idle") await sdk.client.session.abort({ sessionID: route.sessionID }).catch(() => {})
        const revert = session()?.revert?.messageID
        const message = messages().findLast((x) => (!revert || x.id < revert) && x.role === "user")
        if (!message) return
        sdk.client.session
          .revert({
            sessionID: route.sessionID,
            messageID: message.id,
          })
          .then(() => {
            toBottom()
          })
        const parts = sync.data.part[message.id]
        prompt?.set(
          parts.reduce(
            (agg, part) => {
              if (part.type === "text") {
                if (!part.synthetic) agg.input += part.text
              }
              if (part.type === "file") agg.parts.push(part)
              return agg
            },
            { input: "", parts: [] as PromptInfo["parts"] },
          ),
        )
        dialog.clear()
      },
    },
    {
      title: "Redo",
      value: "session.redo",
      keybind: "messages_redo",
      category: "Session",
      enabled: !!session()?.revert?.messageID,
      slash: {
        name: "redo",
      },
      onSelect: (dialog) => {
        dialog.clear()
        const messageID = session()?.revert?.messageID
        if (!messageID) return
        const message = messages().find((x) => x.role === "user" && x.id > messageID)
        if (!message) {
          sdk.client.session.unrevert({
            sessionID: route.sessionID,
          })
          prompt?.set({ input: "", parts: [] })
          return
        }
        sdk.client.session.revert({
          sessionID: route.sessionID,
          messageID: message.id,
        })
      },
    },
    {
      title: conceal() ? "Disable code concealment" : "Enable code concealment",
      value: "session.toggle.conceal",
      keybind: "messages_toggle_conceal",
      category: "Session",
      onSelect: (dialog) => {
        setConceal((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: showTimestamps() ? "Hide timestamps" : "Show timestamps",
      value: "session.toggle.timestamps",
      category: "Session",
      slash: {
        name: "timestamps",
        aliases: ["toggle-timestamps"],
      },
      onSelect: (dialog) => {
        setTimestamps((prev) => (prev === "show" ? "hide" : "show"))
        dialog.clear()
      },
    },
    {
      title: showThinking() ? "Hide thinking" : "Show thinking",
      value: "session.toggle.thinking",
      keybind: "display_thinking",
      category: "Session",
      slash: {
        name: "thinking",
        aliases: ["toggle-thinking"],
      },
      onSelect: (dialog) => {
        setShowThinking((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: showDetails() ? "Hide tool details" : "Show tool details",
      value: "session.toggle.actions",
      keybind: "tool_details",
      category: "Session",
      onSelect: (dialog) => {
        setShowDetails((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: "Toggle session scrollbar",
      value: "session.toggle.scrollbar",
      keybind: "scrollbar_toggle",
      category: "Session",
      onSelect: (dialog) => {
        setShowScrollbar((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: showGenericToolOutput() ? "Hide generic tool output" : "Show generic tool output",
      value: "session.toggle.generic_tool_output",
      category: "Session",
      onSelect: (dialog) => {
        setShowGenericToolOutput((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: "Page up",
      value: "session.page.up",
      keybind: "messages_page_up",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollBy(-scroll.height / 2)
        dialog.clear()
      },
    },
    {
      title: "Page down",
      value: "session.page.down",
      keybind: "messages_page_down",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollBy(scroll.height / 2)
        dialog.clear()
      },
    },
    {
      title: "Line up",
      value: "session.line.up",
      keybind: "messages_line_up",
      category: "Session",
      disabled: true,
      onSelect: (dialog) => {
        scroll.scrollBy(-1)
        dialog.clear()
      },
    },
    {
      title: "Line down",
      value: "session.line.down",
      keybind: "messages_line_down",
      category: "Session",
      disabled: true,
      onSelect: (dialog) => {
        scroll.scrollBy(1)
        dialog.clear()
      },
    },
    {
      title: "Half page up",
      value: "session.half.page.up",
      keybind: "messages_half_page_up",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollBy(-scroll.height / 4)
        dialog.clear()
      },
    },
    {
      title: "Half page down",
      value: "session.half.page.down",
      keybind: "messages_half_page_down",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollBy(scroll.height / 4)
        dialog.clear()
      },
    },
    {
      title: "First message",
      value: "session.first",
      keybind: "messages_first",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollTo(0)
        dialog.clear()
      },
    },
    {
      title: "Last message",
      value: "session.last",
      keybind: "messages_last",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollTo(scroll.scrollHeight)
        dialog.clear()
      },
    },
    {
      title: "Jump to last user message",
      value: "session.messages_last_user",
      keybind: "messages_last_user",
      category: "Session",
      hidden: true,
      onSelect: () => {
        const messages = sync.data.message[route.sessionID]
        if (!messages || !messages.length) return

        // Find the most recent user message with non-ignored, non-synthetic text parts
        for (let i = messages.length - 1; i >= 0; i--) {
          const message = messages[i]
          if (!message || message.role !== "user") continue

          const parts = sync.data.part[message.id]
          if (!parts || !Array.isArray(parts)) continue

          const hasValidTextPart = parts.some(
            (part) => part && part.type === "text" && !part.synthetic && !part.ignored,
          )

          if (hasValidTextPart) {
            const child = scroll.getChildren().find((child) => {
              return child.id === message.id
            })
            if (child) scroll.scrollBy(child.y - scroll.y - 1)
            break
          }
        }
      },
    },
    {
      title: "Next message",
      value: "session.message.next",
      keybind: "messages_next",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => scrollToMessage("next", dialog),
    },
    {
      title: "Previous message",
      value: "session.message.previous",
      keybind: "messages_previous",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => scrollToMessage("prev", dialog),
    },
    {
      title: "Copy last assistant message",
      value: "messages.copy",
      keybind: "messages_copy",
      category: "Session",
      onSelect: (dialog) => {
        const revertID = session()?.revert?.messageID
        const lastAssistantMessage = messages().findLast(
          (msg) => msg.role === "assistant" && (!revertID || msg.id < revertID),
        )
        if (!lastAssistantMessage) {
          toast.show({ message: "No assistant messages found", variant: "error" })
          dialog.clear()
          return
        }

        const parts = sync.data.part[lastAssistantMessage.id] ?? []
        const textParts = parts.filter((part) => part.type === "text")
        if (textParts.length === 0) {
          toast.show({ message: "No text parts found in last assistant message", variant: "error" })
          dialog.clear()
          return
        }

        const text = textParts
          .map((part) => part.text)
          .join("\n")
          .trim()
        if (!text) {
          toast.show({
            message: "No text content found in last assistant message",
            variant: "error",
          })
          dialog.clear()
          return
        }

        Clipboard.copy(text)
          .then(() => toast.show({ message: "Message copied to clipboard!", variant: "success" }))
          .catch(() => toast.show({ message: "Failed to copy to clipboard", variant: "error" }))
        dialog.clear()
      },
    },
    {
      title: "Copy session transcript",
      value: "session.copy",
      category: "Session",
      slash: {
        name: "copy",
      },
      onSelect: async (dialog) => {
        try {
          const sessionData = session()
          if (!sessionData) return
          const sessionMessages = messages()
          const transcript = formatTranscript(
            sessionData,
            sessionMessages.map((msg) => ({ info: msg, parts: sync.data.part[msg.id] ?? [] })),
            {
              thinking: showThinking(),
              toolDetails: showDetails(),
              assistantMetadata: showAssistantMetadata(),
              providers: sync.data.provider,
            },
          )
          await Clipboard.copy(transcript)
          toast.show({ message: "Session transcript copied to clipboard!", variant: "success" })
        } catch (error) {
          toast.show({ message: "Failed to copy session transcript", variant: "error" })
        }
        dialog.clear()
      },
    },
    {
      title: "Export session transcript",
      value: "session.export",
      keybind: "session_export",
      category: "Session",
      slash: {
        name: "export",
      },
      onSelect: async (dialog) => {
        try {
          const sessionData = session()
          if (!sessionData) return
          const sessionMessages = messages()

          const defaultFilename = `session-${sessionData.id.slice(0, 8)}.md`

          const options = await DialogExportOptions.show(
            dialog,
            defaultFilename,
            showThinking(),
            showDetails(),
            showAssistantMetadata(),
            false,
          )

          if (options === null) return

          const transcript = formatTranscript(
            sessionData,
            sessionMessages.map((msg) => ({ info: msg, parts: sync.data.part[msg.id] ?? [] })),
            {
              thinking: options.thinking,
              toolDetails: options.toolDetails,
              assistantMetadata: options.assistantMetadata,
              providers: sync.data.provider,
            },
          )

          if (options.openWithoutSaving) {
            // Just open in editor without saving
            await Editor.open({ value: transcript, renderer })
          } else {
            const exportDir = process.cwd()
            const filename = options.filename.trim()
            const filepath = path.join(exportDir, filename)

            await Filesystem.write(filepath, transcript)

            // Open with EDITOR if available
            const result = await Editor.open({ value: transcript, renderer })
            if (result !== undefined) {
              await Filesystem.write(filepath, result)
            }

            toast.show({ message: `Session exported to ${filename}`, variant: "success" })
          }
        } catch (error) {
          toast.show({ message: "Failed to export session", variant: "error" })
        }
        dialog.clear()
      },
    },
    // gap-slash-commands-1: parity with Claude Code's /cost command.
    // Reads the same per-message cost field displayed in the Stats tab.
    // Currency is hard-coded en-US USD because that's the
    // billing currency for every supported provider.
    {
      title: "Show session cost",
      value: "session.cost",
      category: "Session",
      slash: {
        name: "cost",
        aliases: ["spent", "spend"],
      },
      onSelect: (dialog) => {
        const total = messages().reduce(
          (sum, item) => sum + (item.role === "assistant" ? (item as AssistantMessage).cost : 0),
          0,
        )
        const formatted = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(total)
        const messageCount = messages().filter((m) => m.role === "assistant").length
        toast.show({
          variant: "info",
          message: `${formatted} spent across ${messageCount} assistant message${messageCount === 1 ? "" : "s"}`,
          duration: 5000,
        })
        dialog.clear()
      },
    },
    // gap-slash-commands-4: parity with Claude Code's /usage command.
    // Shows a per-tool call-count breakdown for the active session.
    // Walks every tool part attached to this session's messages, groups
    // by tool name, sorts by call count desc, and takes the top 5.
    // Output is a multi-line toast (≤6 lines) sized to fit the 60-char
    // toast width comfortably.
    //
    // We deliberately count CALLS not estimated tokens here — token
    // estimates require the gap-12 TokenAttribution helper which takes
    // the internal MessageV2.WithParts shape, but the TUI uses SDK
    // shapes and adapting between them in a slash command would add
    // ~30 lines of plumbing for marginal extra signal. The /cost slash
    // already covers the dollar dimension; /usage covers the call
    // dimension; together they answer "how much did this session
    // cost and where did the calls go?"
    //
    // Aliases: /tools, /tool-usage (for users who think in terms of
    // tools rather than usage stats).
    {
      title: "Show per-tool usage breakdown",
      value: "session.usage",
      category: "Session",
      slash: {
        name: "usage",
        aliases: ["tools", "tool-usage"],
      },
      onSelect: (dialog) => {
        const allParts = messages().flatMap((m) => sync.data.part[m.id] ?? [])
        const counts = new Map<string, number>()
        let totalCalls = 0
        for (const part of allParts) {
          if (part.type !== "tool") continue
          const name = part.tool || "unknown"
          counts.set(name, (counts.get(name) ?? 0) + 1)
          totalCalls += 1
        }
        if (totalCalls === 0) {
          toast.show({
            variant: "info",
            message: "No tool calls in this session yet",
            duration: 4000,
          })
          dialog.clear()
          return
        }
        const sorted = Array.from(counts.entries()).sort(([, a], [, b]) => b - a)
        const top = sorted.slice(0, 5)
        const lines = top.map(([name, count]) => `${name}: ${count} call${count === 1 ? "" : "s"}`)
        if (sorted.length > 5) {
          const rest = sorted.slice(5).reduce((sum, [, count]) => sum + count, 0)
          lines.push(`+ ${sorted.length - 5} more (${rest} call${rest === 1 ? "" : "s"})`)
        }
        lines.push(`──────────`)
        lines.push(
          `total: ${totalCalls} call${totalCalls === 1 ? "" : "s"} across ${sorted.length} tool${sorted.length === 1 ? "" : "s"}`,
        )
        toast.show({
          variant: "info",
          message: lines.join("\n"),
          duration: 10000,
        })
        dialog.clear()
      },
    },
    {
      title: "Go to child session",
      value: "session.child.first",
      keybind: "session_child_first",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        moveFirstChild()
        dialog.clear()
      },
    },
    {
      title: "Go to parent session",
      value: "session.parent",
      keybind: "session_parent",
      category: "Session",
      hidden: true,
      enabled: !!session()?.parentID,
      onSelect: childSessionHandler((dialog) => {
        const parentID = session()?.parentID
        if (parentID) {
          navigate({
            type: "session",
            sessionID: parentID,
          })
        }
        dialog.clear()
      }),
    },
    {
      title: "Next child session",
      value: "session.child.next",
      keybind: "session_child_cycle",
      category: "Session",
      hidden: true,
      enabled: !!session()?.parentID,
      onSelect: childSessionHandler((dialog) => {
        moveChild(1)
        dialog.clear()
      }),
    },
    {
      title: "Previous child session",
      value: "session.child.previous",
      keybind: "session_child_cycle_reverse",
      category: "Session",
      hidden: true,
      enabled: !!session()?.parentID,
      onSelect: childSessionHandler((dialog) => {
        moveChild(-1)
        dialog.clear()
      }),
    },
  ])

  const revertInfo = createMemo(() => session()?.revert)
  const revertMessageID = createMemo(() => revertInfo()?.messageID)

  const revertDiffFiles = createMemo(() => {
    const diffText = revertInfo()?.diff ?? ""
    if (!diffText) return []

    try {
      const patches = parsePatch(diffText)
      return patches.map((patch) => {
        const filename = patch.newFileName || patch.oldFileName || "unknown"
        const cleanFilename = filename.replace(/^[ab]\//, "")
        return {
          filename: cleanFilename,
          additions: patch.hunks.reduce(
            (sum, hunk) => sum + hunk.lines.filter((line) => line.startsWith("+")).length,
            0,
          ),
          deletions: patch.hunks.reduce(
            (sum, hunk) => sum + hunk.lines.filter((line) => line.startsWith("-")).length,
            0,
          ),
        }
      })
    } catch (error) {
      return []
    }
  })

  const revertRevertedMessages = createMemo(() => {
    const messageID = revertMessageID()
    if (!messageID) return []
    return messages().filter((x) => x.id >= messageID && x.role === "user")
  })

  const revert = createMemo(() => {
    const info = revertInfo()
    if (!info) return
    if (!info.messageID) return
    return {
      messageID: info.messageID,
      reverted: revertRevertedMessages(),
      diff: info.diff,
      diffFiles: revertDiffFiles(),
    }
  })

  // Last todo part metadata — full 3-layer tree, updated on tool call
  const lastTodo = createMemo(() => {
    const parts = messages().flatMap((x) => sync.data.part[x.id] ?? [])
    const list = parts.flatMap((x) =>
      x.type === "tool" && x.tool === "todo" && x.state.status === "completed" ? [x] : [],
    )
    const part = list[list.length - 1]
    if (!part || part.state.status !== "completed" || !part.state.metadata) return
    return part.state.metadata as TodoMeta
  })

  // Live flat todos from bus — updates on every task.updated event without waiting for tool call
  const liveTodos = createMemo(() => sync.data.todo[route.sessionID] ?? [])

  // Live tree from bus — full hierarchy, populated after first task.updated event
  const liveTodoTree = createMemo(() => sync.data.todo_tree?.[route.sessionID])

  // Section snapshots from bus — systems, context, open questions, verification
  const todoSections = createMemo(() => sync.data.todo_sections?.[route.sessionID])

  // Active task path snapshot — same source rendered by Web UI.
  const activeTaskSections = createMemo(() => todoSections()?.sections ?? [])
  const visibleTaskSections = createMemo(() =>
    activeTaskSections().filter((section) => shouldRenderTodoSection(section.title, section.body)),
  )
  const activeTaskNote = createMemo(
    () => todoSections()?.taskPath ?? todoSections()?.task_path ?? lastTodo()?.task_path,
  )
  const activeTaskFile = createMemo(() => {
    const note = activeTaskNote()
    if (note?.startsWith("/")) return note
    return lastTodo()?.note ?? note
  })

  function applyTodoFileSnapshot(snapshot: TodoFileSnapshot) {
    if (snapshot.todos) sync.set("todo", route.sessionID, snapshot.todos)
    if (snapshot.tree) sync.set("todo_tree", route.sessionID, snapshot.tree)
    if (snapshot.attached_todo_ids) sync.set("attached_todo_ids", route.sessionID, snapshot.attached_todo_ids)
    if (snapshot.attached_todo_labels) sync.set("attached_todo_labels", route.sessionID, snapshot.attached_todo_labels)
    if (snapshot.task_path || snapshot.taskPath || snapshot.sections) {
      sync.set("todo_sections", route.sessionID, {
        task_path: snapshot.task_path ?? snapshot.taskPath,
        taskPath: snapshot.taskPath ?? snapshot.task_path,
        sections: snapshot.sections,
      })
    }
  }

  async function createTodoFileFromPrompt() {
    const title = await DialogPrompt.show(dialog, "Create todo", {
      placeholder: "Todo title",
      description: () => <text fg={theme.textMuted}>Creates and attaches a new scratchpad todo file.</text>,
    })
    dialog.clear()
    if (!title?.trim()) return
    const response = await sdk.fetch(`${sdk.url}/session/${route.sessionID}/todo-file`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: title.trim() }),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => "")
      toast.show({ message: text || "Failed to create todo", variant: "error" })
      return
    }
    const snapshot = (await response.json()) as TodoFileSnapshot
    applyTodoFileSnapshot(snapshot)
    await refetchTodoFileSource()
    await refetchTodoAgentList()
    toast.show({ message: `Attached ${snapshot.task_path ?? snapshot.taskPath ?? "new todo"}`, variant: "success" })
  }

  async function attachTodoFileFromPrompt() {
    const value = await DialogPrompt.show(dialog, "Attach todo", {
      placeholder: "scratchpad/task/opencode/active/todo-name",
      value: activeTaskNote() ?? "",
      description: () => <text fg={theme.textMuted}>Attach an existing scratchpad todo path to this session.</text>,
    })
    dialog.clear()
    if (!value?.trim()) return
    const response = await sdk.fetch(`${sdk.url}/session/${route.sessionID}/todo-file/attach`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: value.trim() }),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => "")
      toast.show({ message: text || "Failed to attach todo", variant: "error" })
      return
    }
    const snapshot = (await response.json()) as TodoFileSnapshot
    applyTodoFileSnapshot(snapshot)
    await refetchTodoFileSource()
    await refetchTodoAgentList()
    toast.show({ message: `Attached ${snapshot.task_path ?? snapshot.taskPath ?? value.trim()}`, variant: "success" })
  }

  async function refreshAttachedTodoSnapshot() {
    const response = await sdk.fetch(`${sdk.url}/session/${route.sessionID}/todo`)
    if (!response.ok) return
    const snapshot = (await response.json()) as TodoFileSnapshot
    applyTodoFileSnapshot(snapshot)
    await refetchTodoFileSource()
    await refetchTodoAgentList()
  }

  function selectedTaskFromSource(source: string) {
    const selected = selectedTodoAgentRow()
    if (!selected) return
    const runnable = parseTodoAgentTasks(source).tasks.filter((task) => task.assignment)
    return (
      runnable.find(
        (candidate) =>
          candidate.startOffset === selected.task.startOffset && todoAgentNameForTask(candidate) === selected.agentName,
      ) ?? runnable[selectedTodoAgentIndex()]
    )
  }

  function lineNumberForOffset(source: string, offset: number) {
    return source.slice(0, Math.max(0, offset)).split(/\r?\n/).length
  }

  async function editSelectedTodoBlock() {
    const file = await readActiveTodoFileSource()
    if (!file) return
    const task = selectedTaskFromSource(file.source)
    if (!task) {
      await Editor.openFile({ filepath: file.file, renderer })
      await refreshAttachedTodoSnapshot()
      return
    }
    await Editor.openFile({ filepath: file.file, line: lineNumberForOffset(file.source, task.startOffset), renderer })
    await refreshAttachedTodoSnapshot()
  }

  async function addCommentToSelectedTodo() {
    const file = await readActiveTodoFileSource()
    if (!file) return
    const task = selectedTaskFromSource(file.source)
    if (!task) {
      toast.show({ message: "No assigned todo-agent task selected", variant: "error" })
      return
    }
    const text = await DialogPrompt.show(dialog, "Add todo comment", {
      placeholder: "Comment for the assigned agent",
      description: () => <text fg={theme.textMuted}>Adds a pending comment to the selected task conversation.</text>,
    })
    dialog.clear()
    if (!text?.trim()) return
    const latest = await readFile(file.file, "utf8").catch(() => undefined)
    if (latest !== file.source) {
      toast.show({ message: "Skipped comment; todo file changed while editing", variant: "error" })
      return
    }
    const insertAt = task.conversationEndOffset ?? task.endOffset
    const block = `  comment>\n${text
      .trim()
      .split(/\r?\n/)
      .map((line) => `  ${line}`)
      .join("\n")}\n  comment_end>\n`
    const prefix = task.conversationEndOffset ? "" : "  conversation:\n"
    const suffix = task.conversationEndOffset ? "" : "  conversation_end:\n"
    await writeFile(
      file.file,
      `${file.source.slice(0, insertAt)}${prefix}${block}${suffix}${file.source.slice(insertAt)}`,
      "utf8",
    )
    await refreshAttachedTodoSnapshot()
  }

  async function addTaskToAttachedTodo() {
    const file = await readActiveTodoFileSource()
    if (!file) return
    const title = await DialogPrompt.show(dialog, "Add task", {
      placeholder: "Task title",
      description: () => <text fg={theme.textMuted}>Adds a task block to the attached todo file.</text>,
    })
    dialog.clear()
    if (!title?.trim()) return
    const assignment = await DialogPrompt.show(dialog, "Assign task", {
      placeholder: "agent-provider::model (optional)",
      description: () => (
        <text fg={theme.textMuted}>
          Use separate lines: assign: worker, provider: qgenie, model: anthropic::claude.
        </text>
      ),
    })
    dialog.clear()
    const latest = await readFile(file.file, "utf8").catch(() => undefined)
    if (latest !== file.source) {
      toast.show({ message: "Skipped add; todo file changed while editing", variant: "error" })
      return
    }
    const lines = [`- [ ] ${title.trim()}`]
    if (assignment?.trim()) {
      lines.push(`  assign: ${assignment.trim()}`, "  prompt_end:", "  conversation:", "  conversation_end:")
    }
    const block = `${lines.join("\n")}\n`
    const systemsMatch = /^## Systems\s*$/m.exec(file.source)
    const insertAt = systemsMatch?.index ?? file.source.length
    const needsLeadingNewline = insertAt > 0 && !file.source.slice(0, insertAt).endsWith("\n\n")
    const prefix = needsLeadingNewline ? "\n" : ""
    await writeFile(
      file.file,
      `${file.source.slice(0, insertAt)}${prefix}${block}\n${file.source.slice(insertAt)}`,
      "utf8",
    )
    await refreshAttachedTodoSnapshot()
  }

  async function toggleSelectedTodoDone() {
    const file = await readActiveTodoFileSource()
    if (!file) return
    const task = selectedTaskFromSource(file.source)
    if (!task) {
      toast.show({ message: "No assigned todo-agent task selected", variant: "error" })
      return
    }
    const latest = await readFile(file.file, "utf8").catch(() => undefined)
    if (latest !== file.source) {
      toast.show({ message: "Skipped toggle; todo file changed", variant: "error" })
      return
    }
    const lineEnd = file.source.indexOf("\n", task.startOffset)
    const end = lineEnd === -1 ? file.source.length : lineEnd
    const line = file.source.slice(task.startOffset, end)
    const nextLine = line.replace(/- \[([ xX])\]/, task.checked ? "- [ ]" : "- [x]")
    if (nextLine === line) return
    await writeFile(file.file, `${file.source.slice(0, task.startOffset)}${nextLine}${file.source.slice(end)}`, "utf8")
    await refreshAttachedTodoSnapshot()
  }

  async function fetchTodoAgentList() {
    const response = await sdk.fetch(`${sdk.url}/session/${route.sessionID}/todo-agent`)
    if (!response.ok) return [] as TodoAgentInfo[]
    const data = (await response.json()) as { agents?: TodoAgentInfo[] }
    return data.agents ?? []
  }

  const [todoAgentList, { refetch: refetchTodoAgentList }] = createResource(
    () => route.sessionID,
    () => fetchTodoAgentList().catch(() => [] as TodoAgentInfo[]),
  )

  const [todoFileSource, { refetch: refetchTodoFileSource }] = createResource(activeTaskFile, async (file) => {
    if (!file) return ""
    return readFile(file, "utf8").catch(() => "")
  })

  const todoAgentByName = createMemo(() => new Map((todoAgentList() ?? []).map((agent) => [agent.name, agent])))

  const todoAgentParse = createMemo(() => parseTodoAgentTasks(todoFileSource() ?? ""))

  const todoAgentRows = createMemo((): TodoAgentFileRow[] => {
    const agents = todoAgentByName()
    return todoAgentParse()
      .tasks.filter((task) => task.assignment)
      .map((task) => {
        const agentName = todoAgentNameForTask(task)!
        const agent = agents.get(agentName)
        const status = agent ? (sync.data.session_status?.[agent.sessionID]?.type as string | undefined) : undefined
        const localRunning = runningTodoAgentNames().has(agentName)
        const hasError = agent
          ? (sync.data.message?.[agent.sessionID] ?? []).some(
              (message) => message.role === "assistant" && message.error,
            )
          : false
        return {
          task,
          agentName,
          pendingComments: pendingTodoAgentComments(task).length,
          agent,
          state: hasError
            ? "error"
            : localRunning
              ? "busy"
              : status === "busy" || status === "retry" || status === "paused"
                ? status
                : agent
                  ? "idle"
                  : "new",
        }
      })
  })

  const [selectedTodoAgentIndex, setSelectedTodoAgentIndex] = createSignal(0)
  const [runningTodoAgentNames, setRunningTodoAgentNames] = createSignal(new Set<string>())
  const selectedTodoAgentRow = createMemo(() => todoAgentRows()[selectedTodoAgentIndex()])

  createEffect(() => {
    const count = todoAgentRows().length
    setSelectedTodoAgentIndex((index) => (count === 0 ? 0 : Math.min(Math.max(index, 0), count - 1)))
  })

  // Merge live statuses into the tree so the board reflects real-time state.
  // Prefers liveTodoTree (bus tree, file-driven) over lastTodo snapshot.
  const mergedTodos = createMemo((): TodoEntry[] => {
    const live = liveTodos()
    const source = liveTodoTree() ?? lastTodo()?.todos
    const tree = ((source && source.length > 0 ? source : todoRowsToTree(live as TodoEntry[])) ?? []) as TodoEntry[]
    if (!live.length) return tree
    // Build flat maps keyed by trimmed content — live rows are always fresher than snapshot
    const statusMap = new Map<string, string>()
    const agentMap = new Map<string, string | undefined>()
    for (const t of live) {
      statusMap.set(t.content.trim(), t.status)
      if (t.agent !== undefined) agentMap.set(t.content.trim(), t.agent)
    }
    function mergeItem<T extends { content: string; status: string; agent?: string; children?: T[] }>(item: T): T {
      const s = statusMap.get(item.content.trim())
      const a = agentMap.get(item.content.trim())
      const children = (item.children ?? []).map(mergeItem) as T["children"]
      return {
        ...item,
        ...(s ? { status: s } : {}),
        ...(a !== undefined ? { agent: a } : {}),
        ...(children && children.length > 0 ? { children } : {}),
      }
    }
    return tree.map((item) => mergeItem(item))
  })

  // Whether the session is actively running (agent is working)
  const isRunning = createMemo(() => {
    const s = sync.data.session_status?.[route.sessionID]
    return s?.type !== "idle" && s?.type !== undefined
  })
  const sessionDiff = createMemo(() => sync.data.session_diff?.[route.sessionID] ?? [])
  const sessionDiffTotals = createMemo(() =>
    sessionDiff().reduce(
      (total, file) => ({ additions: total.additions + file.additions, deletions: total.deletions + file.deletions }),
      { additions: 0, deletions: 0 },
    ),
  )

  async function openChangedFile(file: { file: string }) {
    await Editor.openFile({ filepath: file.file, renderer })
  }

  function modifyChangedFile(file: { file: string }) {
    prompt?.set({ input: `Modify ${file.file}: `, parts: [] })
    setView(() => "chat")
  }

  function unifiedSessionFileDiff(file: { file: string; before?: string; after?: string }) {
    if (typeof file.before !== "string" || typeof file.after !== "string") return ""
    return createTwoFilesPatch(file.file, file.file, file.before, file.after).trimEnd()
  }

  function todoPrompt(text: string) {
    if (!prompt) return
    prompt.set({ input: text, parts: [] })
    prompt.submit()
    toBottom()
  }

  // Flash signal — pulses border when file watcher detects a user edit
  const [fileChanged, setFileChanged] = createSignal(false)

  // Watch liveTodos for changes driven by the file watcher (not tool calls)
  createEffect(
    on(liveTodos, () => {
      setFileChanged(true)
      setTimeout(() => setFileChanged(false), 800)
      void refetchTodoFileSource()
      void refetchTodoAgentList()
    }),
  )

  useKeyboard((evt) => {
    if (session()?.parentID) return
    if (view() !== "todo") return
    if (permissions().length > 0 || dialog.stack.length > 0) return
    if (evt.ctrl || evt.meta) return

    const rows = todoAgentRows()
    const moveSelection = (delta: number) => {
      if (rows.length === 0) return
      setSelectedTodoAgentIndex((index) => Math.min(Math.max(index + delta, 0), rows.length - 1))
    }

    if (evt.name === "j" || evt.name === "down") {
      evt.preventDefault()
      moveSelection(1)
      return
    }
    if (evt.name === "k" || evt.name === "up") {
      evt.preventDefault()
      moveSelection(-1)
      return
    }
    if (evt.name === "R" || (evt.name === "r" && evt.shift)) {
      evt.preventDefault()
      void runTodoAgentTasksFromFile()
      return
    }
    if (evt.name === "A" || (evt.name === "a" && evt.shift)) {
      evt.preventDefault()
      void attachTodoFileFromPrompt()
      return
    }
    if (evt.name === "a") {
      evt.preventDefault()
      void createTodoFileFromPrompt()
      return
    }
    if (evt.name === "n") {
      evt.preventDefault()
      void addTaskToAttachedTodo()
      return
    }
    if (evt.name === "e") {
      evt.preventDefault()
      void editSelectedTodoBlock()
      return
    }
    if (evt.name === "c") {
      evt.preventDefault()
      void addCommentToSelectedTodo()
      return
    }
    if (evt.name === "space" || evt.name === " ") {
      evt.preventDefault()
      void toggleSelectedTodoDone()
      return
    }
    if (evt.name === "r") {
      evt.preventDefault()
      void runSelectedTodoAgentTaskFromFile()
      return
    }
    if (evt.name === "return") {
      evt.preventDefault()
      void openSelectedTodoAgent()
    }
  })

  async function readActiveTodoFileSource() {
    const file = activeTaskFile()
    if (!file) {
      toast.show({ message: "No active task path found", variant: "error" })
      return
    }
    try {
      return { file, source: await readFile(file, "utf8") }
    } catch (error) {
      toast.show({ message: error instanceof Error ? error.message : "Failed to read todo file", variant: "error" })
      return
    }
  }

  function systemsTextFromTodoSource(source: string) {
    return source.match(/^## Systems\s*\n([\s\S]*)$/m)?.[1]
  }

  async function patchTodoAgentFollowUp(input: {
    file: string
    source: string
    task: TodoAgentTask
    responseText?: string
  }) {
    const pending = pendingTodoAgentComments(input.task)
    if (pending.length === 0 || !input.responseText?.trim()) return
    const latest = await readFile(input.file, "utf8").catch(() => undefined)
    if (latest !== input.source) {
      toast.show({
        message: `Skipped todo comment patch for ${input.task.title}; file changed while agent was running`,
        variant: "error",
      })
      return
    }
    try {
      let next = appendTodoAgentResponse(latest, input.task, input.responseText)
      for (const comment of pending) next = markTodoAgentCommentResolved(next, comment)
      await writeFile(input.file, next, "utf8")
      await refetchTodoFileSource()
    } catch (error) {
      toast.show({
        message: error instanceof Error ? error.message : `Failed to patch todo follow-up for ${input.task.title}`,
        variant: "error",
      })
    }
  }

  function todoAgentBusyReason(task: TodoAgentTask) {
    const agentName = todoAgentNameForTask(task)
    if (!agentName) return
    const agent = todoAgentByName().get(agentName)
    if (!agent) return
    const status = sync.data.session_status?.[agent.sessionID]?.type
    if (status && status !== "idle") return `@${agentName} is ${status}`
    return
  }

  async function runTodoAgentTask(task: TodoAgentTask, source: string, file: string) {
    const busy = todoAgentBusyReason(task)
    if (busy) {
      toast.show({ message: busy, variant: "error" })
      return false
    }
    const agentName = todoAgentNameForTask(task)
    if (agentName) {
      setRunningTodoAgentNames((current) => new Set([...current, agentName]))
    }
    try {
      const taskMarkdown = source.slice(task.startOffset, task.endOffset)
      const response = await sdk.fetch(`${sdk.url}/session/${route.sessionID}/todo-agent/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          taskMarkdown,
          systemsText: systemsTextFromTodoSource(source),
          mode: pendingTodoAgentComments(task).length > 0 ? "follow-up" : "initial",
          async: pendingTodoAgentComments(task).length === 0,
        }),
      })
      if (!response.ok) {
        const text = await response.text().catch(() => "")
        toast.show({ message: text || `Failed to run ${task.title}`, variant: "error" })
        return false
      }
      const data = (await response.json().catch(() => undefined)) as
        | { agent?: TodoAgentInfo; responseText?: string; accepted?: boolean }
        | undefined
      if (data?.agent?.sessionID) void sync.session.sync(data.agent.sessionID).catch(() => {})
      await patchTodoAgentFollowUp({ file, source, task, responseText: data?.responseText })
      await refetchTodoAgentList()
      return true
    } finally {
      if (agentName) {
        setRunningTodoAgentNames((current) => {
          const next = new Set(current)
          next.delete(agentName)
          return next
        })
      }
    }
  }

  async function runSelectedTodoAgentTaskFromFile() {
    const selected = selectedTodoAgentRow()
    if (!selected) {
      toast.show({ message: "No assigned todo-agent task selected", variant: "error" })
      return
    }
    const file = await readActiveTodoFileSource()
    if (!file) return
    const parsed = parseTodoAgentTasks(file.source)
    if (parsed.diagnostics.length > 0) {
      toast.show({ message: `Invalid todo-agent task: ${parsed.diagnostics.join("; ")}`, variant: "error" })
      return
    }
    const runnable = parsed.tasks.filter((task) => task.assignment)
    const task =
      runnable.find(
        (candidate) =>
          candidate.startOffset === selected.task.startOffset && todoAgentNameForTask(candidate) === selected.agentName,
      ) ?? runnable[selectedTodoAgentIndex()]
    if (!task) {
      toast.show({ message: "Selected todo-agent task no longer exists", variant: "error" })
      return
    }
    toast.show({ message: `Running @${todoAgentNameForTask(task)} from todo file...`, variant: "success" })
    const ok = await runTodoAgentTask(task, file.source, file.file)
    if (ok) {
      const followUp = pendingTodoAgentComments(task).length > 0
      toast.show({
        message: `${followUp ? "Completed" : "Dispatched"} @${todoAgentNameForTask(task)}: ${task.title}`,
        variant: "success",
      })
    }
  }

  async function runTodoAgentTasksFromFile() {
    const file = await readActiveTodoFileSource()
    if (!file) return
    const parsed = parseTodoAgentTasks(file.source)
    if (parsed.diagnostics.length > 0) {
      toast.show({ message: `Invalid todo-agent tasks: ${parsed.diagnostics.join("; ")}`, variant: "error" })
      return
    }
    const runnable = parsed.tasks.filter((task) => task.assignment)
    if (runnable.length === 0) {
      toast.show({ message: "No assigned todo-agent tasks found", variant: "error" })
      return
    }
    let completed = 0
    let skipped = 0
    const dispatchedAgents = new Set<string>()
    for (const task of runnable) {
      const agentName = todoAgentNameForTask(task)
      if (agentName && dispatchedAgents.has(agentName)) {
        skipped++
        toast.show({ message: `Skipped duplicate run for busy @${agentName}`, variant: "error" })
        continue
      }
      if (await runTodoAgentTask(task, file.source, file.file)) {
        completed++
        if (agentName) dispatchedAgents.add(agentName)
      }
    }
    toast.show({
      message: `Dispatched/completed ${completed}/${runnable.length} todo-agent task${runnable.length === 1 ? "" : "s"}${skipped ? ` (${skipped} skipped)` : ""}`,
      variant: completed + skipped === runnable.length ? "success" : "error",
    })
  }

  async function openSelectedTodoAgent() {
    const selected = selectedTodoAgentRow()
    if (!selected) {
      toast.show({ message: "No assigned todo-agent task selected", variant: "error" })
      return
    }
    let agent = selected.agent
    if (!agent) {
      await refetchTodoAgentList()
      agent = todoAgentByName().get(selected.agentName)
    }
    if (!agent) {
      toast.show({ message: `@${selected.agentName} has no session yet; run the task first`, variant: "error" })
      return
    }
    await sync.session.sync(agent.sessionID).catch(() => undefined)
    navigate({ type: "session", sessionID: agent.sessionID })
  }

  // Open the active task path in nvim (suspends TUI, resumes after editor exits)
  async function openTodoFile() {
    const file = activeTaskFile()
    if (!file) {
      toast.show({ message: "No active task path found", variant: "error" })
      return
    }
    await Editor.openFile({ filepath: file, renderer })
    await refreshAttachedTodoSnapshot()
  }

  // snap to bottom when session changes
  createEffect(on(() => route.sessionID, toBottom))

  return (
    <context.Provider
      value={{
        get width() {
          return contentWidth()
        },
        sessionID: route.sessionID,
        conceal,
        showThinking,
        showTimestamps,
        showDetails,
        showGenericToolOutput,
        diffWrapMode,
        providers,
        sync,
        tui: tuiConfig,
      }}
    >
      <box flexDirection="row">
        <box flexGrow={1} paddingBottom={1} paddingLeft={2} paddingRight={2} gap={1}>
          <Show when={session()}>
            <box flexDirection="row" justifyContent="space-between" gap={1}>
              <box flexDirection="row" gap={1} flexShrink={0}>
                <box
                  onMouseUp={() => setView(() => "chat")}
                  backgroundColor={view() === "chat" ? theme.backgroundElement : theme.backgroundPanel}
                  paddingLeft={1}
                  paddingRight={1}
                >
                  <text fg={view() === "chat" ? theme.text : theme.textMuted}>Chat</text>
                </box>
                <box
                  onMouseUp={() => setView(() => "files")}
                  backgroundColor={view() === "files" ? theme.backgroundElement : theme.backgroundPanel}
                  paddingLeft={1}
                  paddingRight={1}
                >
                  <text fg={view() === "files" ? theme.text : theme.textMuted}>
                    Files
                    <Show when={sessionDiff().length > 0}>
                      <span style={{ fg: theme.accent }}> {sessionDiff().length}</span>
                    </Show>
                  </text>
                </box>
                <box
                  onMouseUp={() => setView(() => "stats")}
                  backgroundColor={view() === "stats" ? theme.backgroundElement : theme.backgroundPanel}
                  paddingLeft={1}
                  paddingRight={1}
                >
                  <text fg={view() === "stats" ? theme.text : theme.textMuted}>Stats</text>
                </box>
              </box>
              <text fg={theme.textMuted} wrapMode="none">
                {sessionTitle()}
              </text>
            </box>
            <Show when={view() === "files"}>
              <box
                flexDirection="column"
                border={["left"]}
                customBorderChars={SplitBorder.customBorderChars}
                borderColor={sessionDiff().length > 0 ? theme.accent : theme.border}
                backgroundColor={theme.backgroundPanel}
                flexGrow={1}
              >
                <box
                  flexDirection="row"
                  justifyContent="space-between"
                  alignItems="center"
                  flexShrink={0}
                  paddingLeft={2}
                  paddingRight={2}
                  paddingTop={1}
                  paddingBottom={1}
                >
                  <box flexDirection="row" gap={2} alignItems="center">
                    <text fg={theme.text}>
                      <span style={{ bold: true }}>Modified Files</span>
                    </text>
                    <Show when={sessionDiff().length > 0}>
                      <text fg={theme.textMuted}>
                        {sessionDiff().length} changed · +{sessionDiffTotals().additions} -
                        {sessionDiffTotals().deletions}
                      </text>
                    </Show>
                  </box>
                  <box flexDirection="row" gap={1} flexShrink={0}>
                    <box
                      backgroundColor={theme.backgroundElement}
                      paddingLeft={1}
                      paddingRight={1}
                      onMouseUp={() => command.trigger("session.undo")}
                    >
                      <text fg={sessionDiff().length > 0 ? theme.warning : theme.textMuted}>Revert Changes</text>
                    </box>
                    <box
                      backgroundColor={theme.backgroundElement}
                      paddingLeft={1}
                      paddingRight={1}
                      onMouseUp={() => command.trigger("session.redo")}
                    >
                      <text fg={session()?.revert?.messageID ? theme.accent : theme.textMuted}>Undo Revert</text>
                    </box>
                  </box>
                </box>
                <box flexShrink={0} border={["top"]} borderColor={theme.border} />
                <scrollbox
                  flexGrow={1}
                  scrollbarOptions={{ visible: true }}
                  verticalScrollbarOptions={{
                    paddingLeft: 1,
                    visible: true,
                    trackOptions: {
                      backgroundColor: theme.backgroundElement,
                      foregroundColor: theme.border,
                    },
                  }}
                >
                  <box flexDirection="column" gap={1} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={2}>
                    <Show
                      when={sessionDiff().length > 0}
                      fallback={<text fg={theme.textMuted}>No file changes in this session.</text>}
                    >
                      <For each={sessionDiff()}>
                        {(file) => (
                          <box
                            flexDirection="column"
                            gap={0}
                            flexShrink={0}
                            border={["left"]}
                            customBorderChars={SplitBorder.customBorderChars}
                            borderColor={theme.border}
                            paddingLeft={1}
                          >
                            <box flexDirection="row" gap={2} flexShrink={0}>
                              <text fg={theme.text} flexGrow={1}>
                                {file.file}
                              </text>
                              <text fg={theme.textMuted} flexShrink={0}>
                                {file.status ?? "modified"}
                              </text>
                              <text fg={theme.diffAdded} flexShrink={0}>
                                +{file.additions}
                              </text>
                              <text fg={theme.diffRemoved} flexShrink={0}>
                                -{file.deletions}
                              </text>
                            </box>
                            <box flexDirection="row" gap={2} flexShrink={0}>
                              <text fg={theme.textMuted} onMouseUp={() => openChangedFile(file)}>
                                open/edit
                              </text>
                              <text fg={theme.border}>·</text>
                              <text fg={theme.accent} onMouseUp={() => modifyChangedFile(file)}>
                                ask assistant to modify
                              </text>
                            </box>
                            <Show
                              when={unifiedSessionFileDiff(file)}
                              fallback={<text fg={theme.textMuted}>No textual diff is available for this file.</text>}
                            >
                              {(diff) => (
                                <box marginTop={1}>
                                  <diff
                                    diff={diff()}
                                    filetype={filetype(file.file)}
                                    wrap={diffWrapMode() === "wrap"}
                                    addedBg={theme.diffAddedBg}
                                    removedBg={theme.diffRemovedBg}
                                    contextBg={theme.diffContextBg}
                                    hunkBg={tokens.diffHunkBg}
                                    addedFg={theme.diffAdded}
                                    removedFg={theme.diffRemoved}
                                    contextFg={theme.diffContext}
                                    hunkFg={tokens.diffHunk}
                                    lineNumberFg={theme.textMuted}
                                    addedLineNumberBg={theme.diffAddedLineNumberBg}
                                    removedLineNumberBg={theme.diffRemovedLineNumberBg}
                                    contextLineNumberBg={tokens.diffLineNumberBg}
                                    hunkLineNumberBg={tokens.diffLineNumberBg}
                                  />
                                </box>
                              )}
                            </Show>
                          </box>
                        )}
                      </For>
                    </Show>
                  </box>
                </scrollbox>
              </box>
            </Show>

            {/* ── Stats view ── */}
            <Show when={view() === "stats"}>
              <box
                flexDirection="column"
                border={["left"]}
                customBorderChars={SplitBorder.customBorderChars}
                borderColor={isRunning() ? theme.warning : theme.border}
                backgroundColor={theme.backgroundPanel}
                flexGrow={1}
              >
                <box
                  flexDirection="row"
                  justifyContent="space-between"
                  alignItems="center"
                  flexShrink={0}
                  paddingLeft={2}
                  paddingRight={2}
                  paddingTop={1}
                  paddingBottom={1}
                >
                  <box flexDirection="row" gap={2} alignItems="center">
                    <text fg={theme.text}>
                      <span style={{ bold: true }}>Stats</span>
                    </text>
                    <Show when={isRunning()}>
                      <text fg={theme.warning}>● live</text>
                    </Show>
                    <Show when={stats.loading}>
                      <text fg={theme.textMuted}>syncing…</text>
                    </Show>
                    <Show when={snapshotFetchedAt()}>
                      {(updatedAt) => (
                        <text fg={theme.textMuted}>{Math.max(0, Math.round((now() - updatedAt()) / 1000))}s ago</text>
                      )}
                    </Show>
                  </box>
                  <box
                    backgroundColor={theme.backgroundElement}
                    paddingLeft={1}
                    paddingRight={1}
                    onMouseUp={() => refetchStats()}
                  >
                    <text fg={theme.accent}>⟳ refresh</text>
                  </box>
                </box>
                <box flexShrink={0} border={["top"]} borderColor={theme.border} />

                <scrollbox
                  flexGrow={1}
                  scrollbarOptions={{ visible: true }}
                  verticalScrollbarOptions={{
                    paddingLeft: 1,
                    visible: true,
                    trackOptions: {
                      backgroundColor: theme.backgroundElement,
                      foregroundColor: theme.border,
                    },
                  }}
                >
                  {(() => {
                    const fmt = (n: number) =>
                      n >= 1_000_000
                        ? `${(n / 1_000_000).toFixed(2)}M`
                        : n >= 1000
                          ? `${(n / 1000).toFixed(1)}k`
                          : String(n)
                    const totalTokens = (tokens: SessionTokenStats["aggregate"]["tokens"]) => sumTokens(tokens)
                    const pct = (part: number, total: number) => {
                      if (total === 0 || part === 0) return 0
                      const percent = (part / total) * 100
                      if (percent < 0.1) return 0.1
                      return Math.round(percent * 10) / 10
                    }
                    const tokenBar = (filledPct: number, fg: RGBA, width = 20) => {
                      const rawFilled = Math.round((filledPct / 100) * width)
                      const filled = Math.max(0, Math.min(width, filledPct > 0 && rawFilled === 0 ? 1 : rawFilled))
                      return (
                        <box flexDirection="row" flexShrink={0}>
                          <text fg={fg}>{"█".repeat(filled)}</text>
                          <text fg={theme.backgroundElement}>{"░".repeat(width - filled)}</text>
                        </box>
                      )
                    }

                    // Helper to get consistent colors for components across TUI stats elements.
                    const getComponentColor = (name: string, index: number): RGBA => {
                      const colors = [
                        theme.accent, // tool calls
                        theme.warning, // system prompt
                        theme.success, // user input
                        theme.secondary, // assistant reasoning / text
                        theme.border, // files
                        theme.textMuted, // other
                      ]
                      if (name.includes("system")) return theme.warning
                      if (name.includes("user")) return theme.success
                      if (name.includes("tool")) return theme.accent
                      if (name.includes("text") || name.includes("reasoning") || name.includes("assistant"))
                        return theme.secondary
                      if (name.includes("file") || name.includes("patch") || name.includes("snapshot"))
                        return theme.border
                      if (name === "free" || name.includes("free space")) return theme.textMuted
                      return colors[index % colors.length]
                    }

                    // A beautiful 2D representation of the context window as colored block tiles.
                    const renderContextMap = (context: ContextWindowStats) => {
                      const totalWidth = 40
                      const totalHeight = 4
                      const totalBlocks = totalWidth * totalHeight
                      const limit =
                        context.inputLimit || context.hardLimit || context.used || context.estimatedTotal || 1
                      const used = Math.min(Math.max(0, context.used), Math.max(1, limit))

                      // Distribute blocks among different components proportionally.
                      const source = context.components.filter((c) => c.tokens > 0)
                      const componentTotal = source.reduce((sum, c) => sum + c.tokens, 0)
                      const scale = componentTotal > used && componentTotal > 0 ? used / componentTotal : 1

                      const rawDistribution = source.map((c) => ({
                        name: c.name,
                        detail: c.detail,
                        tokens: Math.max(0, Math.round(c.tokens * scale)),
                      }))

                      const represented = rawDistribution.reduce((sum, c) => sum + c.tokens, 0)
                      const unattributed = Math.max(0, used - represented)
                      if (unattributed > 0) {
                        rawDistribution.push({
                          name: "unattributed used",
                          detail: "model-reported prompt tokens",
                          tokens: unattributed,
                        })
                      }

                      const freeTokens = Math.max(0, limit - used)
                      if (freeTokens > 0) {
                        rawDistribution.push({
                          name: "free",
                          detail: "available",
                          tokens: freeTokens,
                        })
                      }

                      const segments = rawDistribution.filter((c) => c.tokens > 0)

                      // Build the 2D cells map
                      const cells: Array<{ char: string; fg: RGBA }> = []
                      const safeLimit = Math.max(1, limit)

                      const getStyle = (name: string, index: number) => {
                        if (name === "free" || name.includes("free space")) return { char: "░", fg: theme.textMuted }
                        return { char: "█", fg: getComponentColor(name, index) }
                      }

                      for (let index = 0; index < totalBlocks; index++) {
                        const cursor = ((index + 0.5) / totalBlocks) * safeLimit
                        let end = 0
                        let matchedSegment = segments[segments.length - 1] ?? { name: "free", tokens: safeLimit }
                        for (const segment of segments) {
                          end += segment.tokens
                          if (cursor <= end) {
                            matchedSegment = segment
                            break
                          }
                        }
                        const segmentIndex = segments.indexOf(matchedSegment)
                        const style = getStyle(matchedSegment.name, segmentIndex)
                        cells.push({ char: style.char, fg: style.fg })
                      }

                      // Split into lines of totalWidth
                      const lines: Array<Array<{ char: string; fg: RGBA }>> = []
                      for (let i = 0; i < totalHeight; i++) {
                        lines.push(cells.slice(i * totalWidth, (i + 1) * totalWidth))
                      }

                      return (
                        <box flexDirection="column" flexShrink={0} marginTop={1} marginBottom={1}>
                          <box
                            flexDirection="column"
                            gap={0}
                            border={["top", "bottom", "left", "right"]}
                            borderColor={theme.border}
                            paddingLeft={1}
                            paddingRight={1}
                            flexShrink={0}
                          >
                            <For each={lines}>
                              {(line) => (
                                <box flexDirection="row" gap={0}>
                                  <For each={line}>{(cell) => <text fg={compColor(cell.fg)}>{cell.char}</text>}</For>
                                </box>
                              )}
                            </For>
                          </box>
                          <box flexDirection="row" gap={2} marginTop={1} flexWrap="wrap">
                            <box flexDirection="row" gap={1}>
                              <text fg={theme.warning}>█</text>
                              <text fg={theme.textMuted}>system</text>
                            </box>
                            <box flexDirection="row" gap={1}>
                              <text fg={theme.success}>█</text>
                              <text fg={theme.textMuted}>user input</text>
                            </box>
                            <box flexDirection="row" gap={1}>
                              <text fg={theme.accent}>█</text>
                              <text fg={theme.textMuted}>tools</text>
                            </box>
                            <box flexDirection="row" gap={1}>
                              <text fg={theme.secondary}>█</text>
                              <text fg={theme.textMuted}>assistant</text>
                            </box>
                            <box flexDirection="row" gap={1}>
                              <text fg={theme.border}>█</text>
                              <text fg={theme.textMuted}>files/patches</text>
                            </box>
                            <box flexDirection="row" gap={1}>
                              <text fg={theme.textMuted}>░</text>
                              <text fg={theme.textMuted}>free space</text>
                            </box>
                          </box>
                        </box>
                      )
                    }

                    // Simple helper to avoid type errors when styling
                    const compColor = (rgba: RGBA): RGBA => rgba

                    return (
                      <box
                        flexDirection="column"
                        gap={1}
                        paddingLeft={2}
                        paddingRight={2}
                        paddingTop={1}
                        paddingBottom={2}
                      >
                        <box flexDirection="column" gap={0} flexShrink={0} marginBottom={1}>
                          <text fg={theme.textMuted}>
                            <span style={{ bold: true }}>CONTEXT</span>
                          </text>
                          <box flexDirection="row" gap={3} flexShrink={0}>
                            <text fg={theme.text}>{contextLabel()}</text>
                            <Show when={contextUsage().model}>
                              {(model) => <text fg={theme.textMuted}>{model()}</text>}
                            </Show>
                            <text fg={theme.accent}>
                              {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
                                sessionCost(),
                              )}{" "}
                              spent
                            </text>
                          </box>
                        </box>

                        <Show when={stats.error}>
                          <text fg={theme.error}>Failed to load stats: {String(stats.error)}</text>
                        </Show>

                        <Show
                          when={stats()}
                          fallback={
                            <text fg={theme.textMuted}>
                              {stats.loading ? "Loading stats…" : "No stats available for this session yet."}
                            </text>
                          }
                        >
                          {(snapshot) => {
                            const aggregate = () => snapshot().aggregate
                            const total = () => totalTokens(aggregate().tokens)
                            const cacheTotal = () => aggregate().tokens.cache.read + aggregate().tokens.cache.write
                            return (
                              <>
                                <box flexDirection="column" gap={0} flexShrink={0} marginBottom={1}>
                                  <text fg={theme.textMuted}>
                                    <span style={{ bold: true }}>CONTEXT WINDOW</span>
                                  </text>
                                  <box flexDirection="row" gap={2} flexShrink={0}>
                                    <text fg={theme.text}>
                                      {snapshot().context.providerID}/{snapshot().context.modelID}
                                    </text>
                                    <Show when={snapshot().context.modelName}>
                                      <text fg={theme.textMuted}>{snapshot().context.modelName}</text>
                                    </Show>
                                  </box>
                                  <box flexDirection="row" gap={2} flexShrink={0}>
                                    <text fg={theme.accent}>{snapshot().context.callCount} LLM calls</text>
                                    <text fg={theme.textMuted}>·</text>
                                    <text fg={theme.text}>{snapshot().context.totalToolCalls ?? 0} tool calls</text>
                                    <text fg={theme.textMuted}>·</text>
                                    <text fg={theme.text}>
                                      {snapshot().context.avgToolCallsPerLLM ?? 0} tools/LLM avg
                                    </text>
                                    <text fg={theme.textMuted}>·</text>
                                    <text fg={theme.textMuted}>max {snapshot().context.maxToolCallsPerLLM ?? 0}</text>
                                  </box>
                                  {renderContextMap(snapshot().context)}
                                  <box flexDirection="row" gap={2} flexShrink={0} alignItems="center">
                                    <text fg={theme.textMuted} width={12}>
                                      soft cap
                                    </text>
                                    <text fg={theme.text}>
                                      {fmt(snapshot().context.used)}
                                      <Show when={snapshot().context.softLimit}>
                                        {(limit) => <> / {fmt(limit())}</>}
                                      </Show>
                                    </text>
                                    <Show when={snapshot().context.availableSoft !== undefined}>
                                      <text fg={theme.textMuted}>
                                        {fmt(snapshot().context.availableSoft!)} before degradation
                                      </text>
                                    </Show>
                                  </box>
                                  <box flexDirection="row" gap={2} flexShrink={0} alignItems="center">
                                    <text fg={theme.textMuted} width={12}>
                                      max input
                                    </text>
                                    <Show when={snapshot().context.inputLimit}>
                                      {(limit) => (
                                        <text fg={theme.text}>
                                          {fmt(snapshot().context.availableInput ?? 0)} / {fmt(limit())} left
                                        </text>
                                      )}
                                    </Show>
                                    <Show when={snapshot().context.outputReserve}>
                                      <text fg={theme.textMuted}>
                                        output reserve {fmt(snapshot().context.outputReserve!)}
                                      </text>
                                    </Show>
                                  </box>
                                  <box flexDirection="row" gap={2} flexShrink={0} alignItems="center">
                                    <text fg={theme.textMuted} width={12}>
                                      hard window
                                    </text>
                                    <Show when={snapshot().context.hardLimit}>
                                      {(limit) => (
                                        <text fg={theme.text}>
                                          {fmt(snapshot().context.availableHard ?? 0)} / {fmt(limit())} left
                                        </text>
                                      )}
                                    </Show>
                                  </box>
                                  <text fg={theme.textMuted}>
                                    soft cap is 80% of max input; above it long-context quality/latency can degrade
                                    before hard limit
                                  </text>
                                  <text fg={theme.textMuted}>
                                    used is latest model-reported prompt tokens; component rows are estimates from
                                    stored messages
                                  </text>
                                  <box flexDirection="column" gap={0} flexShrink={0} marginTop={1}>
                                    <For each={snapshot().context.components}>
                                      {(component, index) => {
                                        const color = getComponentColor(component.name, index())
                                        return (
                                          <box flexDirection="row" gap={2} flexShrink={0} alignItems="center">
                                            <text fg={theme.textMuted} width={18}>
                                              {component.name}
                                            </text>
                                            {tokenBar(pct(component.tokens, snapshot().context.used), color, 20)}
                                            <text fg={theme.text} width={9}>
                                              {fmt(component.tokens)}
                                            </text>
                                            <text fg={theme.textMuted} width={7}>
                                              {component.pct}%
                                            </text>
                                            <Show when={component.detail}>
                                              <text fg={theme.textMuted}>{component.detail}</text>
                                            </Show>
                                          </box>
                                        )
                                      }}
                                    </For>
                                  </box>
                                  <Show when={snapshot().context.tools.length > 0}>
                                    <box flexDirection="column" gap={0} flexShrink={0} marginTop={1}>
                                      <text fg={theme.textMuted}>top tools</text>
                                      <For each={snapshot().context.tools}>
                                        {(tool) => (
                                          <box flexDirection="row" gap={2} flexShrink={0}>
                                            <text fg={theme.textMuted} width={18}>
                                              {tool.name}
                                            </text>
                                            <text fg={theme.text}>{fmt(tool.totalTokens)}</text>
                                            <text fg={theme.textMuted}>
                                              {tool.calls} calls · in {fmt(tool.inputTokens)} · out{" "}
                                              {fmt(tool.outputTokens)}
                                            </text>
                                          </box>
                                        )}
                                      </For>
                                    </box>
                                  </Show>
                                </box>

                                <box flexDirection="column" gap={0} flexShrink={0} marginBottom={1}>
                                  <text fg={theme.textMuted}>
                                    <span style={{ bold: true }}>SUMMARY</span>
                                  </text>
                                  <box flexDirection="row" gap={3} flexShrink={0}>
                                    <text fg={theme.accent}>${aggregate().cost.toFixed(4)} cost</text>
                                    <text fg={theme.text}>{fmt(total())} tokens</text>
                                    <text fg={theme.textMuted}>{aggregate().agentCount} agents</text>
                                    <text fg={theme.textMuted}>{aggregate().messageCount} messages</text>
                                  </box>
                                </box>

                                <box flexDirection="column" gap={0} flexShrink={0} marginBottom={1}>
                                  <text fg={theme.textMuted}>
                                    <span style={{ bold: true }}>TOKEN BREAKDOWN</span>
                                  </text>
                                  <box flexDirection="row" gap={2} flexShrink={0} alignItems="center">
                                    <text fg={theme.textMuted} width={9}>
                                      input
                                    </text>
                                    {tokenBar(pct(aggregate().tokens.input, total()), theme.accent)}
                                    <text fg={theme.text}>{fmt(aggregate().tokens.input)}</text>
                                    <text fg={theme.textMuted}>({pct(aggregate().tokens.input, total())}%)</text>
                                  </box>
                                  <box flexDirection="row" gap={2} flexShrink={0} alignItems="center">
                                    <text fg={theme.textMuted} width={9}>
                                      output
                                    </text>
                                    {tokenBar(pct(aggregate().tokens.output, total()), theme.success)}
                                    <text fg={theme.text}>{fmt(aggregate().tokens.output)}</text>
                                    <text fg={theme.textMuted}>({pct(aggregate().tokens.output, total())}%)</text>
                                  </box>
                                  <Show when={aggregate().tokens.reasoning > 0}>
                                    <box flexDirection="row" gap={2} flexShrink={0} alignItems="center">
                                      <text fg={theme.textMuted} width={9}>
                                        reason
                                      </text>
                                      {tokenBar(pct(aggregate().tokens.reasoning, total()), theme.secondary)}
                                      <text fg={theme.text}>{fmt(aggregate().tokens.reasoning)}</text>
                                      <text fg={theme.textMuted}>({pct(aggregate().tokens.reasoning, total())}%)</text>
                                    </box>
                                  </Show>
                                  <Show when={cacheTotal() > 0}>
                                    <box flexDirection="row" gap={2} flexShrink={0} alignItems="center">
                                      <text fg={theme.textMuted} width={9}>
                                        cache
                                      </text>
                                      {tokenBar(pct(cacheTotal(), total()), theme.warning)}
                                      <text fg={theme.text}>{fmt(cacheTotal())}</text>
                                      <text fg={theme.textMuted}>
                                        r:{fmt(aggregate().tokens.cache.read)} w:{fmt(aggregate().tokens.cache.write)}
                                      </text>
                                    </box>
                                  </Show>
                                </box>

                                <Show when={snapshot().agents.length > 0}>
                                  <box flexDirection="column" gap={0} flexShrink={0} marginBottom={1}>
                                    <text fg={theme.textMuted}>
                                      <span style={{ bold: true }}>AGENTS ({snapshot().agents.length})</span>
                                    </text>
                                    <For each={snapshot().agents}>
                                      {(agent) => {
                                        const agentTotal = () => totalTokens(agent.tokens)
                                        return (
                                          <box
                                            flexDirection="column"
                                            gap={0}
                                            flexShrink={0}
                                            marginTop={1}
                                            border={["left"]}
                                            customBorderChars={SplitBorder.customBorderChars}
                                            borderColor={agent.isRoot ? theme.accent : theme.border}
                                            paddingLeft={1}
                                          >
                                            <box flexDirection="row" gap={1} flexShrink={0}>
                                              <text fg={agent.isRoot ? theme.accent : theme.text}>
                                                <span style={{ bold: true }}>{agent.title}</span>
                                              </text>
                                              <Show when={agent.isRoot}>
                                                <text fg={theme.textMuted}>root</text>
                                              </Show>
                                              <Show when={agent.providerID || agent.modelID}>
                                                <text fg={theme.textMuted}>
                                                  {agent.providerID}/{agent.modelID}
                                                </text>
                                              </Show>
                                            </box>
                                            <box flexDirection="row" gap={3} flexShrink={0}>
                                              <text fg={theme.text}> {fmt(agentTotal())} tokens</text>
                                              <text fg={agent.cost > 0 ? theme.accent : theme.textMuted}>
                                                ${agent.cost.toFixed(4)}
                                              </text>
                                              <text fg={theme.textMuted}>{agent.messageCount} messages</text>
                                              <Show when={agent.contextUsagePct !== undefined}>
                                                <text fg={theme.textMuted}>ctx {agent.contextUsagePct}%</text>
                                              </Show>
                                            </box>
                                          </box>
                                        )
                                      }}
                                    </For>
                                  </box>
                                </Show>

                                <Show when={snapshot().timeline.length > 0}>
                                  <box flexDirection="column" flexShrink={0} marginBottom={1}>
                                    <text fg={theme.textMuted}>
                                      <span style={{ bold: true }}>TURN TIMELINE ({snapshot().timeline.length})</span>
                                    </text>
                                    <text fg={theme.textMuted}>
                                      Root user turns ordered by time; child-agent usage is summarized above, not
                                      repeated here.
                                    </text>
                                    <box flexDirection="row" gap={0} flexShrink={0} marginTop={1}>
                                      <text fg={theme.textMuted} width={6}>
                                        #
                                      </text>
                                      <text fg={theme.textMuted} width={14}>
                                        share
                                      </text>
                                      <text fg={theme.textMuted} width={9}>
                                        tokens
                                      </text>
                                      <text fg={theme.textMuted} width={10}>
                                        cost
                                      </text>
                                      <text fg={theme.textMuted} width={9}>
                                        in
                                      </text>
                                      <text fg={theme.textMuted} width={9}>
                                        out
                                      </text>
                                    </box>
                                    <box flexShrink={0} border={["top"]} borderColor={theme.border} />
                                    <For each={snapshot().timeline}>
                                      {(turn) => {
                                        const turnTotal = sumTokens(turn.tokens)
                                        return (
                                          <box flexDirection="row" gap={0} flexShrink={0} alignItems="center">
                                            <text fg={theme.accent} width={6}>
                                              T{turn.turnIndex + 1}
                                            </text>
                                            <box width={14}>{tokenBar(pct(turnTotal, total()), theme.accent, 12)}</box>
                                            <text fg={theme.text} width={9}>
                                              {fmt(turnTotal)}
                                            </text>
                                            <text fg={theme.text} width={10}>
                                              ${turn.cost.toFixed(4)}
                                            </text>
                                            <text fg={theme.textMuted} width={9}>
                                              {fmt(turn.tokens.input)}
                                            </text>
                                            <text fg={theme.textMuted} width={9}>
                                              {fmt(turn.tokens.output)}
                                            </text>
                                          </box>
                                        )
                                      }}
                                    </For>
                                  </box>
                                </Show>
                              </>
                            )
                          }}
                        </Show>
                      </box>
                    )
                  })()}
                </scrollbox>
              </box>
            </Show>
            <Show when={view() === "chat"}>
              <scrollbox
                ref={(r) => (scroll = r)}
                viewportOptions={{
                  paddingRight: showScrollbar() ? 1 : 0,
                }}
                verticalScrollbarOptions={{
                  paddingLeft: 1,
                  visible: showScrollbar(),
                  trackOptions: {
                    backgroundColor: theme.backgroundElement,
                    foregroundColor: theme.border,
                  },
                }}
                stickyScroll={true}
                stickyStart="bottom"
                flexGrow={1}
                scrollAcceleration={scrollAcceleration()}
              >
                <For each={messages()}>
                  {(message, index) => (
                    <Switch>
                      <Match when={message.id === revert()?.messageID}>
                        {(function () {
                          const command = useCommandDialog()
                          const [hover, setHover] = createSignal(false)
                          const dialog = useDialog()

                          const handleUnrevert = async () => {
                            const confirmed = await DialogConfirm.show(
                              dialog,
                              "Confirm Redo",
                              "Are you sure you want to restore the reverted messages?",
                            )
                            if (confirmed) {
                              command.trigger("session.redo")
                            }
                          }

                          return (
                            <box
                              onMouseOver={() => setHover(true)}
                              onMouseOut={() => setHover(false)}
                              onMouseUp={handleUnrevert}
                              marginTop={1}
                              flexShrink={0}
                              border={["left"]}
                              customBorderChars={SplitBorder.customBorderChars}
                              borderColor={theme.backgroundPanel}
                            >
                              <box
                                paddingTop={1}
                                paddingBottom={1}
                                paddingLeft={2}
                                backgroundColor={hover() ? theme.backgroundElement : theme.backgroundPanel}
                              >
                                <text fg={theme.textMuted}>{revert()!.reverted.length} message reverted</text>
                                <text fg={theme.textMuted}>
                                  <span style={{ fg: theme.text }}>{keybind.print("messages_redo")}</span> or /redo to
                                  restore
                                </text>
                                <Show when={revert()!.diffFiles?.length}>
                                  <box marginTop={1}>
                                    <For each={revert()!.diffFiles}>
                                      {(file) => (
                                        <text fg={theme.text}>
                                          {file.filename}
                                          <Show when={file.additions > 0}>
                                            <span style={{ fg: theme.diffAdded }}> +{file.additions}</span>
                                          </Show>
                                          <Show when={file.deletions > 0}>
                                            <span style={{ fg: theme.diffRemoved }}> -{file.deletions}</span>
                                          </Show>
                                        </text>
                                      )}
                                    </For>
                                  </box>
                                </Show>
                              </box>
                            </box>
                          )
                        })()}
                      </Match>
                      <Match when={revert()?.messageID && message.id >= revert()!.messageID}>
                        <></>
                      </Match>
                      <Match when={message.role === "user"}>
                        <UserMessage
                          index={index()}
                          onMouseUp={() => {
                            if (renderer.getSelection()?.getSelectedText()) return
                            dialog.replace(() => (
                              <DialogMessage
                                messageID={message.id}
                                sessionID={route.sessionID}
                                setPrompt={(promptInfo) => prompt?.set(promptInfo)}
                              />
                            ))
                          }}
                          message={message as UserMessage}
                          parts={sync.data.part[message.id] ?? []}
                          pending={pending()}
                        />
                      </Match>
                      <Match when={message.role === "assistant"}>
                        <AssistantMessage
                          last={lastAssistant()?.id === message.id}
                          message={message as AssistantMessage}
                          parts={sync.data.part[message.id] ?? []}
                        />
                      </Match>
                    </Switch>
                  )}
                </For>
              </scrollbox>
            </Show>
            <box flexShrink={0}>
              <Show when={permissions().length > 0}>
                <PermissionPrompt request={permissions()[0]} />
              </Show>
              <Show when={session()?.parentID}>
                <SubagentFooter />
              </Show>
              <Show when={visible()}>
                <TuiPluginRuntime.Slot
                  name="session_prompt"
                  mode="replace"
                  session_id={route.sessionID}
                  visible={visible()}
                  disabled={disabled()}
                  on_submit={toBottom}
                  ref={bind}
                >
                  <Prompt
                    visible={visible()}
                    ref={bind}
                    disabled={disabled()}
                    onSubmit={() => {
                      toBottom()
                    }}
                    sessionID={route.sessionID}
                    hint={
                      <box flexDirection="row" gap={2} flexShrink={1}>
                        <text fg={theme.textMuted} wrapMode="none">
                          {currentFolder()}
                        </text>
                        <text fg={theme.textMuted} wrapMode="none">
                          {contextLabel()}
                        </text>
                      </box>
                    }
                    right={<TuiPluginRuntime.Slot name="session_prompt_right" session_id={route.sessionID} />}
                  />
                </TuiPluginRuntime.Slot>
              </Show>
            </box>
          </Show>
          <Toast />
        </box>
      </box>
    </context.Provider>
  )
}

const MIME_BADGE: Record<string, string> = {
  "text/plain": "txt",
  "image/png": "img",
  "image/jpeg": "img",
  "image/gif": "img",
  "image/webp": "img",
  "application/pdf": "pdf",
  "application/x-directory": "dir",
}

function UserMessage(props: {
  message: UserMessage
  parts: Part[]
  onMouseUp: () => void
  index: number
  pending?: string
}) {
  const ctx = use()
  const local = useLocal()
  const text = createMemo(() => props.parts.flatMap((x) => (x.type === "text" && !x.synthetic ? [x] : []))[0])
  const files = createMemo(() => props.parts.flatMap((x) => (x.type === "file" ? [x] : [])))
  const { theme } = useTheme()
  const [hover, setHover] = createSignal(false)
  const queued = createMemo(() => props.pending && props.message.id > props.pending)
  const color = createMemo(() => local.agent.color(props.message.agent))
  const queuedFg = createMemo(() => selectedForeground(theme, color()))
  const metadataVisible = createMemo(() => queued() || ctx.showTimestamps())

  const compaction = createMemo(() => props.parts.find((x) => x.type === "compaction"))

  return (
    <>
      <Show when={text()}>
        <box
          id={props.message.id}
          border={["left"]}
          borderColor={color()}
          customBorderChars={SplitBorder.customBorderChars}
          marginTop={props.index === 0 ? 0 : 1}
        >
          <box
            onMouseOver={() => {
              setHover(true)
            }}
            onMouseOut={() => {
              setHover(false)
            }}
            onMouseUp={props.onMouseUp}
            paddingTop={1}
            paddingBottom={1}
            paddingLeft={2}
            backgroundColor={hover() ? theme.backgroundElement : theme.backgroundPanel}
            flexShrink={0}
          >
            <text fg={theme.text}>{text()?.text}</text>
            <Show when={files().length}>
              <box flexDirection="row" paddingBottom={metadataVisible() ? 1 : 0} paddingTop={1} gap={1} flexWrap="wrap">
                <For each={files()}>
                  {(file) => {
                    const bg = createMemo(() => {
                      if (file.mime.startsWith("image/")) return theme.accent
                      if (file.mime === "application/pdf") return theme.primary
                      return theme.secondary
                    })
                    return (
                      <text fg={theme.text}>
                        <span style={{ bg: bg(), fg: theme.background }}> {MIME_BADGE[file.mime] ?? file.mime} </span>
                        <span style={{ bg: theme.backgroundElement, fg: theme.textMuted }}> {file.filename} </span>
                      </text>
                    )
                  }}
                </For>
              </box>
            </Show>
            <Show
              when={queued()}
              fallback={
                <Show when={ctx.showTimestamps()}>
                  <text fg={theme.textMuted}>
                    <span style={{ fg: theme.textMuted }}>
                      {Locale.todayTimeOrDateTime(props.message.time.created)}
                    </span>
                  </text>
                </Show>
              }
            >
              <text fg={theme.textMuted}>
                <span style={{ bg: color(), fg: queuedFg(), bold: true }}> QUEUED </span>
              </text>
            </Show>
          </box>
        </box>
      </Show>
      <Show when={compaction()}>
        <box
          marginTop={1}
          border={["top"]}
          title=" Compaction "
          titleAlignment="center"
          borderColor={theme.borderActive}
        />
      </Show>
    </>
  )
}

function AssistantMessage(props: { message: AssistantMessage; parts: Part[]; last: boolean }) {
  const ctx = use()
  const local = useLocal()
  const { theme } = useTheme()
  const sync = useSync()
  const messages = createMemo(() => sync.data.message[props.message.sessionID] ?? [])
  const model = createMemo(() => Model.name(ctx.providers(), props.message.providerID, props.message.modelID))

  const final = createMemo(() => {
    return props.message.finish && !["tool-calls", "unknown"].includes(props.message.finish)
  })

  const duration = createMemo(() => {
    if (!final()) return 0
    if (!props.message.time.completed) return 0
    const user = messages().find((x) => x.role === "user" && x.id === props.message.parentID)
    if (!user || !user.time) return 0
    return props.message.time.completed - user.time.created
  })

  const keybind = useKeybind()

  return (
    <>
      <For each={props.parts}>
        {(part, index) => {
          const component = createMemo(() => PART_MAPPING[part.type as keyof typeof PART_MAPPING])
          return (
            <Show when={component()}>
              <Dynamic
                last={index() === props.parts.length - 1}
                component={component()}
                /* Dynamic dispatches Part union to typed component; each component expects its own subtype */
                part={part as any}
                message={props.message}
              />
            </Show>
          )
        }}
      </For>
      <Show when={props.parts.some((x) => x.type === "tool" && x.tool === "task")}>
        <box paddingTop={1} paddingLeft={3}>
          <text fg={theme.text}>
            {keybind.print("session_child_first")}
            <span style={{ fg: theme.textMuted }}> view subagents</span>
          </text>
        </box>
      </Show>
      <Show when={props.message.error && props.message.error.name !== "MessageAbortedError"}>
        <box
          border={["left"]}
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          marginTop={1}
          backgroundColor={theme.backgroundPanel}
          customBorderChars={SplitBorder.customBorderChars}
          borderColor={theme.error}
        >
          <text fg={theme.textMuted}>{props.message.error?.data.message}</text>
        </box>
      </Show>
      <Switch>
        <Match when={props.last || final() || props.message.error?.name === "MessageAbortedError"}>
          <box paddingLeft={3}>
            <text marginTop={1}>
              <span
                style={{
                  fg:
                    props.message.error?.name === "MessageAbortedError"
                      ? theme.textMuted
                      : local.agent.color(props.message.agent),
                }}
              >
                ▣{" "}
              </span>{" "}
              <span style={{ fg: theme.text }}>{Locale.titlecase(props.message.mode)}</span>
              <span style={{ fg: theme.textMuted }}> · {model()}</span>
              <Show when={duration()}>
                <span style={{ fg: theme.textMuted }}> · {Locale.duration(duration())}</span>
              </Show>
              <Show when={props.message.error?.name === "MessageAbortedError"}>
                <span style={{ fg: theme.textMuted }}> · interrupted</span>
              </Show>
            </text>
          </box>
        </Match>
      </Switch>
    </>
  )
}

const PART_MAPPING = {
  text: TextPart,
  tool: ToolPart,
  reasoning: ReasoningPart,
}

function ReasoningPart(props: { last: boolean; part: ReasoningPart; message: AssistantMessage }) {
  const { theme, subtleSyntax } = useTheme()
  const ctx = use()
  const content = createMemo(() => {
    // Filter out redacted reasoning chunks from OpenRouter
    // OpenRouter sends encrypted reasoning data that appears as [REDACTED]
    return props.part.text.replace("[REDACTED]", "").trim()
  })
  return (
    <Show when={content() && ctx.showThinking()}>
      <box
        id={"text-" + props.part.id}
        paddingLeft={2}
        marginTop={1}
        flexDirection="column"
        border={["left"]}
        customBorderChars={SplitBorder.customBorderChars}
        borderColor={theme.backgroundElement}
      >
        <code
          filetype="markdown"
          drawUnstyledText={false}
          streaming={true}
          syntaxStyle={subtleSyntax()}
          content={"_Thinking:_ " + content()}
          conceal={ctx.conceal()}
          fg={theme.textMuted}
        />
      </box>
    </Show>
  )
}

function TextPart(props: { last: boolean; part: TextPart; message: AssistantMessage }) {
  const ctx = use()
  const { theme, syntax } = useTheme()
  return (
    <Show when={props.part.text.trim()}>
      <box id={"text-" + props.part.id} paddingLeft={3} marginTop={1} flexShrink={0}>
        <Switch>
          <Match when={Flag.OPENCODE_EXPERIMENTAL_MARKDOWN}>
            <markdown
              syntaxStyle={syntax()}
              streaming={true}
              content={props.part.text.trim()}
              conceal={ctx.conceal()}
              fg={theme.markdownText}
              bg={theme.background}
            />
          </Match>
          <Match when={!Flag.OPENCODE_EXPERIMENTAL_MARKDOWN}>
            <code
              filetype="markdown"
              drawUnstyledText={false}
              streaming={true}
              syntaxStyle={syntax()}
              content={props.part.text.trim()}
              conceal={ctx.conceal()}
              fg={theme.text}
            />
          </Match>
        </Switch>
      </box>
    </Show>
  )
}

// Pending messages moved to individual tool pending functions

function ToolPart(props: { last: boolean; part: ToolPart; message: AssistantMessage }) {
  const ctx = use()
  const sync = useSync()

  // Hide tool if showDetails is false and tool completed successfully
  const shouldHide = createMemo(() => {
    if (ctx.showDetails()) return false
    if (props.part.state.status !== "completed") return false
    return true
  })

  const toolprops = {
    get metadata() {
      return props.part.state.status === "pending" ? {} : (props.part.state.metadata ?? {})
    },
    get input() {
      return props.part.state.input ?? {}
    },
    get output() {
      return props.part.state.status === "completed" ? props.part.state.output : undefined
    },
    get permission() {
      const permissions = sync.data.permission[props.message.sessionID] ?? []
      const permissionIndex = permissions.findIndex((x) => x.tool?.callID === props.part.callID)
      return permissions[permissionIndex]
    },
    get tool() {
      return props.part.tool
    },
    get part() {
      return props.part
    },
  }

  return (
    <Show when={!shouldHide()}>
      <ToolCallObservability {...toolprops} agent={props.message.agent} />
    </Show>
  )
}

type ToolProps<I = GenericToolInput, M = GenericToolMetadata> = {
  input: Partial<I>
  metadata: Partial<M>
  permission: Record<string, any>
  tool: string
  output?: string
  part: ToolPart
}

function toolDuration(part?: ToolPart) {
  if (!part || !("time" in part.state)) return 0
  const time = part.state.time
  if (!time?.start) return 0
  const end = "end" in time ? time.end : Date.now()
  return end - time.start
}

function toolBorderColor(part: ToolPart | undefined, theme: ReturnType<typeof useTheme>["theme"]) {
  switch (part?.state.status) {
    case "running":
      return theme.primary
    case "error":
      return theme.error
    case "completed":
      return theme.success
    default:
      return theme.background
  }
}

type TodoEntry = {
  content: string
  status: "pending" | "in_progress" | "completed" | "cancelled"
  priority: "high" | "medium" | "low"
  num?: string
  type?: string
  phase?: string
  acceptance_signal?: string
  depends_on?: string[]
  blocked_by?: string[]
  parallel_group?: string
  agent?: string
  comments?: string[]
  learnings?: string[]
  plans?: string[]
  children?: TodoEntry[]
}

type TodoAgentInfo = {
  rootSessionID: string
  name: string
  sessionID: string
  providerID: string
  modelID: string
  timeCreated: number
  timeUpdated: number
  source?: { type: "new" | "reuse" | "fork"; fromAgent?: string; fromSessionID?: string }
}

type TodoFileSnapshot = {
  task_path?: string
  taskPath?: string
  file?: string
  label?: string
  todos?: TodoEntry[]
  tree?: TodoEntry[]
  sections?: { title: string; body: string }[]
  attached_todo_ids?: string[]
  attached_todo_labels?: Record<string, string>
}

type TodoAgentFileRow = {
  task: TodoAgentTask
  agentName: string
  pendingComments: number
  agent?: TodoAgentInfo
  state: "new" | "idle" | "busy" | "retry" | "paused" | "error"
}

function todoAgentNameForTask(task: TodoAgentTask) {
  const assignment = task.assignment
  if (!assignment) return undefined
  return assignment.kind === "fork" ? assignment.targetAgentName : assignment.agentName
}

function todoAgentStatusColor(state: TodoAgentFileRow["state"], theme: ReturnType<typeof useTheme>["theme"]) {
  if (state === "error") return theme.error
  if (state === "busy" || state === "retry") return theme.warning
  if (state === "paused") return theme.info
  if (state === "new") return theme.textMuted
  return theme.success
}

function todoIndentDepth(content: string) {
  const indent = content.match(/^\s*/)?.[0] ?? ""
  const spaces = indent.replace(/	/g, "  ").length
  return Math.floor(spaces / 2)
}

const TODO_SCAFFOLD_PREFIXES = [
  "_no entries — agents publish facts here for concurrent peers to see._",
  "_empty — pending agent-routed work appears here._",
  "_append-only. format:",
  "_append-only audit trail",
  "_phase gate findings written by implementer",
  "_inter-agent typed messages.",
  "_bounded mistake log.",
  "_staging area.",
  "_condense only task-relevant system understanding here:",
]

function todoSectionLines(body: string) {
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

function isTodoScaffoldLine(line: string) {
  const normalized = line.trim().toLowerCase()
  return TODO_SCAFFOLD_PREFIXES.some((prefix) => normalized.startsWith(prefix))
}

function shouldRenderTodoSection(title: string, body: string) {
  if (isTaskSectionTitle(title)) return true
  const lines = todoSectionLines(body)
  if (lines.length === 0) return false
  return lines.some((line) => !isTodoScaffoldLine(line))
}

function isTaskSectionTitle(title: string) {
  const normalized = title.trim().toLowerCase()
  return normalized === "tasks" || normalized === "plan"
}

function groupTodoEntries(items: ReadonlyArray<TodoEntry>): { phase?: string; items: TodoEntry[] }[] {
  const groups: { phase?: string; items: TodoEntry[] }[] = []
  const byPhase = new Map<string, { phase?: string; items: TodoEntry[] }>()
  for (const item of items) {
    const phase = item.phase?.trim() || undefined
    const key = phase ?? "__tasks__"
    let group = byPhase.get(key)
    if (!group) {
      group = { phase, items: [] }
      byPhase.set(key, group)
      groups.push(group)
    }
    group.items.push(item)
  }
  return groups
}

function countTodoTree(items: ReadonlyArray<TodoEntry>): number {
  return items.reduce((total, item) => total + 1 + countTodoTree(item.children ?? []), 0)
}

function todoRowsToTree(rows: ReadonlyArray<TodoEntry>): TodoEntry[] {
  const roots: TodoEntry[] = []
  const stack: TodoEntry[] = []

  for (const row of rows) {
    const depth = todoIndentDepth(row.content)
    const item: TodoEntry = {
      ...row,
      content: row.content.trim(),
      comments: [...(row.comments ?? [])],
      children: [],
    }
    stack.length = depth + 1
    stack[depth] = item
    const parent = depth > 0 ? stack[depth - 1] : undefined
    if (parent) parent.children = [...(parent.children ?? []), item]
    else roots.push(item)
  }

  return roots
}

type ReservationEntry = {
  agent: string
  sessionID: string
  notePath: string
  section: string
  status: "writing" | "done" | "failed"
  acquired: string
}

type TodoMeta = {
  note?: string
  /** Server wire field. Prefer taskPath in UI code. */
  task_path?: string
  taskPath?: string
  active_note_source?: string
  progress_tail?: string[]
  todos?: TodoEntry[]
  feedback?: string | null
  reservations?: ReservationEntry[]
  goal?: string
  outcome?: string
  workflow_stage?: "planning" | "executing" | "done"
  scope_mode?: string
  multi_todo_count?: number
  budget?: { tokens_used: number; tokens_soft: number | null; tokens_hard: number | null; status: string } | null
}
function GenericTool(props: ToolProps<GenericToolInput, GenericToolMetadata>) {
  const { theme } = useTheme()
  const ctx = use()
  const output = createMemo(() => props.output?.trim() ?? "")
  const [expanded, setExpanded] = createSignal(false)
  const lines = createMemo(() => output().split("\n"))
  const maxLines = 3
  const overflow = createMemo(() => lines().length > maxLines)
  const limited = createMemo(() => {
    if (expanded() || !overflow()) return output()
    return [...lines().slice(0, maxLines), "…"].join("\n")
  })

  return (
    <Show
      when={props.output && ctx.showGenericToolOutput()}
      fallback={
        <InlineTool icon="⚙" pending="Writing command..." complete={true} part={props.part}>
          {props.tool} {input(props.input)}
        </InlineTool>
      }
    >
      <BlockTool
        title={`# ${props.tool} ${input(props.input)}`}
        part={props.part}
        onClick={overflow() ? () => setExpanded((prev) => !prev) : undefined}
      >
        <box gap={1}>
          <text fg={theme.text}>{limited()}</text>
          <Show when={overflow()}>
            <text fg={theme.textMuted}>{expanded() ? "Click to collapse" : "Click to expand"}</text>
          </Show>
        </box>
      </BlockTool>
    </Show>
  )
}

function InlineTool(props: {
  icon: string
  iconColor?: RGBA
  complete: any
  pending: string
  spinner?: boolean
  children: JSX.Element
  part: ToolPart
  onClick?: () => void
}) {
  const [margin, setMargin] = createSignal(0)
  const { theme } = useTheme()
  const ctx = use()
  const sync = useSync()
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)

  const permission = createMemo(() => {
    const callID = sync.data.permission[ctx.sessionID]?.at(0)?.tool?.callID
    if (!callID) return false
    return callID === props.part.callID
  })

  const fg = createMemo(() => {
    if (permission()) return theme.warning
    if (hover() && props.onClick) return theme.text
    if (props.complete) return theme.textMuted
    return theme.text
  })

  const error = createMemo(() => (props.part.state.status === "error" ? props.part.state.error : undefined))
  const duration = createMemo(() => toolDuration(props.part))

  const denied = createMemo(
    () =>
      error()?.includes("QuestionRejectedError") ||
      error()?.includes("rejected permission") ||
      error()?.includes("specified a rule") ||
      error()?.includes("user dismissed"),
  )

  return (
    <box
      marginTop={margin()}
      paddingLeft={3}
      onMouseOver={() => props.onClick && setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        props.onClick?.()
      }}
      renderBefore={function () {
        const el = this as BoxRenderable
        const parent = el.parent
        if (!parent) {
          return
        }
        if (el.height > 1) {
          setMargin(1)
          return
        }
        const children = parent.getChildren()
        const index = children.indexOf(el)
        const previous = children[index - 1]
        if (!previous) {
          setMargin(0)
          return
        }
        if (previous.height > 1 || previous.id.startsWith("text-")) {
          setMargin(1)
          return
        }
      }}
    >
      <Switch>
        <Match when={props.spinner}>
          <Spinner color={fg()} children={props.children} />
        </Match>
        <Match when={true}>
          <text paddingLeft={3} fg={fg()} attributes={denied() ? TextAttributes.STRIKETHROUGH : undefined}>
            <Show fallback={<>~ {props.pending}</>} when={props.complete}>
              <span style={{ fg: props.iconColor }}>{props.icon}</span> {props.children}
              <Show when={duration()}>
                <span style={{ fg: theme.textMuted }}> · {Locale.duration(duration())}</span>
              </Show>
            </Show>
          </text>
        </Match>
      </Switch>
      <Show when={error() && !denied()}>
        <text fg={theme.error}>{error()}</text>
      </Show>
    </box>
  )
}

function BlockTool(props: {
  title: string
  children: JSX.Element
  onClick?: () => void
  part?: ToolPart
  spinner?: boolean
}) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  const error = createMemo(() => (props.part?.state.status === "error" ? props.part.state.error : undefined))
  const duration = createMemo(() => toolDuration(props.part))
  const borderColor = createMemo(() => toolBorderColor(props.part, theme))
  return (
    <box
      border={["left"]}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      marginTop={1}
      gap={1}
      backgroundColor={hover() ? theme.backgroundMenu : theme.backgroundPanel}
      customBorderChars={SplitBorder.customBorderChars}
      borderColor={borderColor()}
      onMouseOver={() => props.onClick && setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        props.onClick?.()
      }}
    >
      <Show
        when={props.spinner}
        fallback={
          <text paddingLeft={3} fg={theme.textMuted}>
            {props.title}
            <Show when={duration()}>
              <span style={{ fg: theme.textMuted }}> · {Locale.duration(duration())}</span>
            </Show>
          </text>
        }
      >
        <Spinner color={theme.textMuted}>{props.title.replace(/^# /, "")}</Spinner>
      </Show>
      {props.children}
      <Show when={error()}>
        <text fg={theme.error}>{error()}</text>
      </Show>
    </box>
  )
}

const BASH_METADATA_START = "<bash_metadata>"
const BASH_METADATA_END = "</bash_metadata>"
type BashParsedOutput = {
  outputLines: string[]
  metadataLines: string[]
}

function parseBashOutput(output: string): BashParsedOutput {
  if (!output) return { outputLines: [], metadataLines: [] }

  const lines = output.split("\n")
  const outputLines: string[] = []
  const metadataLines: string[] = []
  let inMetaBlock = false

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === BASH_METADATA_START) {
      inMetaBlock = true
      continue
    }
    if (trimmed === BASH_METADATA_END) {
      inMetaBlock = false
      continue
    }
    if (inMetaBlock) metadataLines.push(line)
    else outputLines.push(line)
  }

  return { outputLines, metadataLines }
}

function looksLikeJson(text: string) {
  const trimmed = text.trim()
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) return false
  try {
    JSON.parse(trimmed)
    return true
  } catch {
    return false
  }
}

function fenceLanguage(text: string): string | undefined {
  const match = text.trimStart().match(/^```([a-zA-Z0-9_+-]+)/)
  if (!match?.[1]) return undefined
  const lang = match[1].toLowerCase()
  if (lang === "py" || lang === "python") return "python"
  if (lang === "js" || lang === "javascript") return "javascript"
  if (lang === "ts" || lang === "typescript") return "typescript"
  if (lang === "sh" || lang === "shell" || lang === "bash" || lang === "zsh") return "bash"
  if (lang === "json") return "json"
  return undefined
}

function inferBashOutputFiletype(command?: string, output?: string): string {
  const cmd = (command ?? "").toLowerCase()
  const out = output ?? ""
  const fenced = fenceLanguage(out)
  if (fenced) return fenced

  const ext = cmd.match(/\.(py|tsx?|jsx?|mjs|cjs|sh|bash|zsh|json)\b/i)?.[1]?.toLowerCase()
  if (ext === "py") return "python"
  if (ext === "ts" || ext === "tsx") return "typescript"
  if (ext === "js" || ext === "jsx" || ext === "mjs" || ext === "cjs") return "javascript"
  if (ext === "sh" || ext === "bash" || ext === "zsh") return "bash"
  if (ext === "json") return "json"

  if (/\bpython(?:3)?\b/.test(cmd)) return "python"
  if (/\b(ts-node|tsx)\b/.test(cmd)) return "typescript"
  if (/\b(node|deno|bun)\b/.test(cmd)) return "javascript"
  if (/\b(bash|sh|zsh|fish)\b/.test(cmd)) return "bash"
  if (looksLikeJson(out)) return "json"
  return "bash"
}

function stringifyToolPayload(payload: unknown): string {
  if (payload === undefined || payload === null) return ""
  if (typeof payload === "string") return payload
  try {
    return JSON.stringify(payload, null, 2)
  } catch {
    return String(payload)
  }
}

function inferToolInputFiletype(part: ToolPart): string {
  if (part.tool === "bash") return "bash"
  return "json"
}

function inferToolOutputFiletype(part: ToolPart, output: string): string {
  if (part.tool === "bash") {
    const command = typeof part.state.input?.command === "string" ? part.state.input.command : ""
    return inferBashOutputFiletype(command, output)
  }
  if (looksLikeJson(output)) return "json"
  return "none"
}

function compactPreview(text: string, max = 88): string {
  const single = text
    .replace(/\s+/g, " ")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .trim()
  if (!single) return "(empty)"
  if (single.length <= max) return single
  return single.slice(0, Math.max(1, max - 1)) + "…"
}

function compactPreviewBlock(text: string, maxLines = 3, maxCols = 92): { text: string; truncated: boolean } {
  const clean = text.replace(/\x1b\[[0-9;]*m/g, "").trim()
  if (!clean) return { text: "(empty)", truncated: false }
  const lines = clean.split(/\r?\n/)
  let truncated = false
  const clipped = lines.slice(0, maxLines).map((line) => {
    const trimmed = line.trimEnd()
    if (trimmed.length <= maxCols) return trimmed
    truncated = true
    return trimmed.slice(0, Math.max(1, maxCols - 3)) + "..."
  })
  if (lines.length > maxLines) {
    clipped.push("...")
    truncated = true
  }
  return { text: clipped.join("\n"), truncated }
}

function toolOutputText(part: ToolPart): string {
  if (part.state.status === "error") return part.state.error ?? ""
  if (part.state.status === "running") return "(running)"
  if (part.state.status !== "completed") return "(pending)"

  const raw = stringifyToolPayload(part.state.output ?? "")
  if (part.tool !== "bash") return raw

  const parsed = parseBashOutput(raw)
  const normal = parsed.outputLines.join("\n")
  if (parsed.metadataLines.length === 0) return normal
  const metadata = parsed.metadataLines.map((line) => `[meta] ${line}`).join("\n")
  if (!normal.trim()) return metadata
  return `${normal}\n\n${metadata}`
}

function Bash(props: ToolProps<BashToolInput, BashToolMetadata>) {
  const { theme, syntax } = useTheme()
  const sync = useSync()
  const isRunning = createMemo(() => props.part.state.status === "running")
  const rawOutput = createMemo(() => props.metadata.output ?? "")
  const parsed = createMemo(() => parseBashOutput(rawOutput()))
  const outputLines = createMemo(() => parsed().outputLines)
  const metadataLines = createMemo(() => parsed().metadataLines)
  const outputText = createMemo(() => outputLines().join("\n"))
  const exitCode = createMemo(() => {
    const metadata = props.metadata as Record<string, unknown>
    if (typeof metadata.exitCode === "number") return metadata.exitCode
    if (typeof metadata.exit === "number") return metadata.exit
    return undefined
  })
  const status = createMemo(() => {
    if (isRunning()) return { label: "running", color: theme.warning }
    if (props.part.state.status === "error") return { label: "failed", color: theme.error }
    if (typeof exitCode() === "number") {
      return {
        label: `exit ${exitCode()}`,
        color: exitCode() === 0 ? theme.success : theme.error,
      }
    }
    return { label: "completed", color: theme.success }
  })
  const outputFiletype = createMemo(() => inferBashOutputFiletype(props.input.command, outputText()))

  const workdirDisplay = createMemo(() => {
    const workdir = props.input.workdir
    if (!workdir || workdir === "@/surface/cli/cmd/tui/routes/session") return undefined

    const base = sync.data.path.directory
    if (!base) return undefined

    const absolute = path.resolve(base, workdir)
    if (absolute === base) return undefined

    const home = Global.Path.home
    if (!home) return absolute

    const match = absolute === home || absolute.startsWith(home + path.sep)
    return match ? absolute.replace(home, "~") : absolute
  })

  const title = createMemo(() => {
    const desc = props.input.description ?? "Shell"
    const wd = workdirDisplay()
    if (!wd) return `# ${desc}`
    if (desc.includes(wd)) return `# ${desc}`
    return `# ${desc} in ${wd}`
  })

  return (
    <Switch>
      <Match when={props.metadata.output !== undefined}>
        <BlockTool title={title()} part={props.part} spinner={isRunning()}>
          <box gap={1}>
            <text>
              <span style={{ fg: theme.primary }}>$</span>
              <span style={{ fg: theme.text }}> {props.input.command}</span>
            </text>
            <text fg={theme.textMuted}>
              <span style={{ fg: status().color }}>● {status().label}</span>
            </text>
            <Show when={outputText()}>
              <line_number fg={theme.textMuted} minWidth={3} paddingRight={1}>
                <code
                  conceal={false}
                  fg={theme.text}
                  filetype={outputFiletype()}
                  syntaxStyle={syntax()}
                  content={outputText()}
                />
              </line_number>
            </Show>
            <Show when={metadataLines().length > 0}>
              <For each={metadataLines()}>
                {(line) => (
                  <text>
                    <span style={{ fg: theme.warning }}>!</span>
                    <span style={{ fg: theme.warning }}> {line.length > 0 ? line : " "}</span>
                  </text>
                )}
              </For>
            </Show>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="$" pending="Writing command..." complete={props.input.command} part={props.part}>
          {props.input.command}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function ToolCallObservability(props: ToolProps & { agent: string }) {
  const { theme, syntax } = useTheme()
  const renderer = useRenderer()
  const [showInput, setShowInput] = createSignal(false)
  const [showOutput, setShowOutput] = createSignal(false)
  const [showPretty, setShowPretty] = createSignal(true)

  const inputText = createMemo(() => stringifyToolPayload(props.part.state.input ?? {}))
  const outputText = createMemo(() => toolOutputText(props.part))
  const inputFiletype = createMemo(() => inferToolInputFiletype(props.part))
  const outputFiletype = createMemo(() => inferToolOutputFiletype(props.part, outputText()))
  const inputPreview = createMemo(() => compactPreview(inputText()))
  const outputPreview = createMemo(() => compactPreview(outputText()))
  const prettyGlimpseSource = createMemo(() => {
    if (props.tool === "bash") {
      const cmd = typeof props.input.command === "string" ? props.input.command : ""
      const out = outputText()
      return out ? `$ ${cmd}\n${out}` : `$ ${cmd}`
    }
    if (props.tool === "task") {
      if (typeof props.input.description === "string") return props.input.description
      if (typeof props.input.operation === "string") return `workflow ${props.input.operation}`
      if (typeof props.input.op === "string") return `task ${props.input.op}`
      return "Task"
    }
    if (props.tool === "todo") return "todo updated — switch to Todo tab to view"
    if (props.output && props.output.trim()) return props.output
    return stringifyToolPayload(props.input)
  })
  const prettyGlimpse = createMemo(() => compactPreviewBlock(prettyGlimpseSource()))
  const prettyGlimpseFiletype = createMemo(() => {
    if (props.tool === "bash") {
      const cmd = typeof props.input.command === "string" ? props.input.command : ""
      return inferBashOutputFiletype(cmd, outputText())
    }
    if (props.tool === "task" || props.tool === "todo") return "markdown"
    if (looksLikeJson(prettyGlimpseSource())) return "json"
    return "none"
  })
  const callRef = createMemo(() => {
    const value = props.part.callID || props.part.id
    if (!value) return "unknown"
    return value.length > 10 ? `…${value.slice(-10)}` : value
  })

  const toggleInput = () => {
    if (renderer.getSelection()?.getSelectedText()) return
    setShowInput((prev) => !prev)
  }
  const toggleOutput = () => {
    if (renderer.getSelection()?.getSelectedText()) return
    setShowOutput((prev) => !prev)
  }
  const togglePretty = () => {
    if (renderer.getSelection()?.getSelectedText()) return
    setShowPretty((prev) => !prev)
  }

  const prettyView = createMemo(() => {
    if (props.tool === "bash") return <Bash {...(props as ToolProps<BashToolInput, BashToolMetadata>)} />
    if (props.tool === "task") return <Task {...(props as ToolProps<TaskToolInput, TaskToolMetadata>)} />
    if (props.tool === "todo") {
      return (
        <InlineTool
          icon="⚙"
          pending="Updating todo..."
          complete={props.part.state.status === "completed"}
          part={props.part}
        >
          todo updated — switch to Todo tab to view
        </InlineTool>
      )
    }
    return <GenericTool {...(props as ToolProps<GenericToolInput, GenericToolMetadata>)} />
  })

  return (
    <box paddingLeft={3} marginTop={1} gap={1} flexDirection="column">
      <box>
        <text fg={theme.textMuted}>
          ▾ Observability
          <span style={{ fg: theme.textMuted }}> · {props.part.tool}</span>
          <span style={{ fg: theme.textMuted }}> · {callRef()}</span>
        </text>
      </box>
      <box paddingLeft={2} gap={1} flexDirection="column">
        <box onMouseUp={toggleInput}>
          <text fg={theme.textMuted}>
            <span style={{ fg: theme.textMuted }}>├─ </span>
            {showInput() ? "▾" : "▸"} Agent call ({props.agent})
            <span style={{ fg: theme.textMuted }}> · {inputPreview()}</span>
          </text>
        </box>
        <Show when={showInput()}>
          <box paddingLeft={4}>
            <line_number fg={theme.textMuted} minWidth={3} paddingRight={1}>
              <code
                conceal={false}
                fg={theme.text}
                filetype={inputFiletype()}
                syntaxStyle={syntax()}
                content={inputText() || "(empty input)"}
              />
            </line_number>
          </box>
        </Show>
        <box onMouseUp={toggleOutput}>
          <text fg={theme.textMuted}>
            <span style={{ fg: theme.textMuted }}>├─ </span>
            {showOutput() ? "▾" : "▸"} Tool output to agent
            <span style={{ fg: theme.textMuted }}> · {outputPreview()}</span>
          </text>
        </box>
        <Show when={showOutput()}>
          <box paddingLeft={4}>
            <line_number fg={theme.textMuted} minWidth={3} paddingRight={1}>
              <code
                conceal={false}
                fg={theme.text}
                filetype={outputFiletype()}
                syntaxStyle={syntax()}
                content={outputText() || "(no output)"}
              />
            </line_number>
          </box>
        </Show>
        <box onMouseUp={togglePretty}>
          <text fg={theme.textMuted}>
            <span style={{ fg: theme.textMuted }}>└─ </span>
            {showPretty() ? "▾" : "▸"} Pretty view
          </text>
        </box>
        <Show when={!showPretty()}>
          <box paddingLeft={4} onMouseUp={togglePretty}>
            <line_number fg={theme.textMuted} minWidth={3} paddingRight={1}>
              <code
                conceal={false}
                fg={theme.text}
                filetype={prettyGlimpseFiletype()}
                syntaxStyle={syntax()}
                content={prettyGlimpse().text}
              />
            </line_number>
            <Show when={prettyGlimpse().truncated}>
              <text fg={theme.textMuted} onMouseUp={togglePretty}>
                ...
              </text>
            </Show>
          </box>
        </Show>
        <Show when={showPretty()}>
          <box paddingLeft={4}>{prettyView()}</box>
        </Show>
      </box>
    </box>
  )
}

function taskSessionIDFromOutput(output?: string): string | undefined {
  if (!output) return undefined
  const taskId = output.match(/(?:^|\n)task_id:\s*([^\s(]+)/)?.[1]
  if (taskId) return taskId
  return output.match(/(?:^|\n)resumable_task_id:\s*([^\s(]+)/)?.[1]
}

function Task(props: ToolProps<TaskToolInput, TaskToolMetadata>) {
  const { navigate } = useRoute()
  const sync = useSync()
  const toast = useToast()

  const taskSessionID = createMemo(() => {
    if (props.metadata.sessionId) return props.metadata.sessionId
    if (props.metadata.sessionID) return props.metadata.sessionID
    if (props.metadata.resumable_task_id) return props.metadata.resumable_task_id
    if (props.metadata.task_id) return props.metadata.task_id
    return taskSessionIDFromOutput(props.output)
  })

  createEffect(() => {
    const sessionID = taskSessionID()
    if (!sessionID || sync.data.message[sessionID]?.length) return
    void sync.session.sync(sessionID).catch(() => {})
  })

  const messages = createMemo(() => sync.data.message[taskSessionID() ?? ""] ?? [])

  const tools = createMemo(() => {
    return messages().flatMap((msg) =>
      (sync.data.part[msg.id] ?? [])
        .filter((part): part is ToolPart => part.type === "tool")
        .map((part) => ({ tool: part.tool, state: part.state })),
    )
  })

  const current = createMemo(() => tools().findLast((x) => "title" in x.state && x.state.title))
  const taskInput = createMemo(() => props.input)

  const isRunning = createMemo(() => props.part.state.status === "running")

  const duration = createMemo(() => {
    const first = messages().find((x) => x.role === "user")?.time.created
    const assistant = messages().findLast((x) => x.role === "assistant")?.time.completed
    if (!first || !assistant) return 0
    return assistant - first
  })

  const content = createMemo(() => {
    const input = taskInput()
    const op = input.op ?? (input.operation ? "workflow" : "spawn")
    const title =
      op === "spawn"
        ? `${Locale.titlecase(input.subagent_type ?? "General")} Task — ${input.description ?? "spawn"}`
        : op === "workflow"
          ? `Workflow — ${input.operation ?? "operation"}`
          : op === "result"
            ? `Task result — ${input.background_task_id ?? "unknown"}`
            : `Task ${op}`
    let content = [title]

    if (isRunning() && tools().length > 0) {
      // content[0] += ` · ${tools().length} toolcalls`
      if (current()) {
        const st = current()!.state
        const stateTitle = "title" in st ? st.title : undefined
        content.push(`↳ ${Locale.titlecase(current()!.tool)} ${stateTitle ?? ""}`)
      } else content.push(`↳ ${tools().length} toolcalls`)
    }

    if (props.part.state.status === "completed") {
      content.push(`└ ${tools().length} toolcalls · ${Locale.duration(duration())}`)
    }

    return content.join("\n")
  })

  return (
    <InlineTool
      icon="│"
      spinner={isRunning()}
      complete={Boolean(content())}
      pending="Delegating..."
      part={props.part}
      onClick={() => {
        const sessionID = taskSessionID()
        if (!sessionID) return
        if (sync.session.get(sessionID)) {
          navigate({ type: "session", sessionID })
          return
        }
        void sync.session
          .sync(sessionID)
          .then(() => {
            navigate({ type: "session", sessionID })
          })
          .catch(() => {
            toast.show({
              message: `Session not found: ${sessionID}`,
              variant: "error",
            })
          })
      }}
    >
      {content()}
    </InlineTool>
  )
}

function Diagnostics(props: { diagnostics?: Record<string, Record<string, any>[]>; filePath: string }) {
  const { theme } = useTheme()
  const errors = createMemo(() => {
    const normalized = Filesystem.normalizePath(props.filePath)
    const arr = props.diagnostics?.[normalized] ?? []
    return arr.filter((x) => x.severity === 1).slice(0, 3)
  })

  return (
    <Show when={errors().length}>
      <box>
        <For each={errors()}>
          {(diagnostic) => (
            <text fg={theme.error}>
              Error [{diagnostic.range.start.line + 1}:{diagnostic.range.start.character + 1}] {diagnostic.message}
            </text>
          )}
        </For>
      </box>
    </Show>
  )
}

function normalizePath(input?: string) {
  if (!input) return ""

  const cwd = process.cwd()
  const absolute = path.isAbsolute(input) ? input : path.resolve(cwd, input)
  const relative = path.relative(cwd, absolute)

  if (!relative) return "@/surface/cli/cmd/tui/routes/session"
  if (!relative.startsWith("@/surface/cli/cmd/tui/routes")) return relative

  // outside cwd - use absolute
  return absolute
}

function input(input: Record<string, any>, omit?: string[]): string {
  const primitives = Object.entries(input).filter(([key, value]) => {
    if (omit?.includes(key)) return false
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  })
  if (primitives.length === 0) return ""
  return `[${primitives.map(([key, value]) => `${key}=${value}`).join(", ")}]`
}

function filetype(input?: string) {
  if (!input) return "none"
  const ext = path.extname(input)
  const language = LANGUAGE_EXTENSIONS[ext]
  if (["typescriptreact", "javascriptreact", "javascript"].includes(language)) return "typescript"
  return language
}
