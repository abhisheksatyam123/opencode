import { Prompt, type PromptRef } from "@tui/component/prompt"
import { createEffect, createSignal, createMemo, For, Show } from "solid-js"
import { Logo } from "@/surface/cli/cmd/tui/component/logo"
import { useSync } from "@/surface/cli/cmd/tui/context/sync"
import { Toast } from "@/surface/cli/cmd/tui/ui/toast"
import { useArgs } from "@/surface/cli/cmd/tui/context/args"
import { useRouteData } from "@tui/context/route"
import { usePromptRef } from "@/surface/cli/cmd/tui/context/prompt"
import { useLocal } from "@/surface/cli/cmd/tui/context/local"
import { useTheme } from "@/surface/cli/cmd/tui/context/theme"
import { TuiPluginRuntime } from "@/surface/cli/cmd/tui/plugin"

// WONTFIX: module-level once guard is intentional; React context overhead not justified for static placeholder
let once = false
const placeholder = {
  normal: ["Fix a TODO in the codebase", "What is the tech stack of this project?", "Fix broken tests"],
  shell: ["ls -la", "git status", "pwd"],
}

function WorkspaceTodoPanel() {
  const sync = useSync()
  const { theme } = useTheme()
  const todos = createMemo(() => sync.data.workspace_todos ?? [])

  function statusIcon(status: string) {
    if (status === "completed") return "✓"
    if (status === "in_progress") return "●"
    if (status === "cancelled") return "~"
    return "○"
  }

  function statusColor(status: string) {
    if (status === "in_progress") return theme.warning
    if (status === "completed") return theme.success
    if (status === "cancelled") return theme.textMuted
    return theme.text
  }

  return (
    <Show when={todos().length > 0}>
      <box flexDirection="column" gap={0} paddingX={1} width="100%" maxWidth={75}>
        <text fg={theme.text}>
          <b>Todos</b>
        </text>
        <For each={todos()}>
          {(todo) => (
            <box flexDirection="row" gap={1}>
              <text fg={statusColor(todo.status)}>{statusIcon(todo.status)}</text>
              <text fg={theme.text} wrapMode="word" flexGrow={1}>
                {todo.content}
              </text>
            </box>
          )}
        </For>
      </box>
    </Show>
  )
}

export function Home() {
  const sync = useSync()
  const route = useRouteData("home")
  const promptRef = usePromptRef()
  const [ref, setRef] = createSignal<PromptRef | undefined>()
  const args = useArgs()
  const local = useLocal()
  let sent = false

  const bind = (r: PromptRef | undefined) => {
    setRef(r)
    promptRef.set(r)
    if (once || !r) return
    if (route.initialPrompt) {
      r.set(route.initialPrompt)
      once = true
      return
    }
    if (!args.prompt) return
    r.set({ input: args.prompt, parts: [] })
    once = true
  }

  // Wait for sync and model store to be ready before auto-submitting --prompt
  createEffect(() => {
    const r = ref()
    if (sent) return
    if (!r) return
    if (!sync.ready || !local.model.ready) return
    if (!args.prompt) return
    if (r.current.input !== args.prompt) return
    sent = true
    r.submit()
  })

  return (
    <>
      <box flexGrow={1} alignItems="center" paddingLeft={2} paddingRight={2}>
        <box flexGrow={1} minHeight={0} />
        <box height={4} minHeight={0} flexShrink={1} />
        <box flexShrink={0}>
          <TuiPluginRuntime.Slot name="home_logo" mode="replace">
            <Logo />
          </TuiPluginRuntime.Slot>
        </box>
        <box height={1} minHeight={0} flexShrink={1} />
        <box width="100%" maxWidth={75} zIndex={1000} paddingTop={1} flexShrink={0}>
          <TuiPluginRuntime.Slot name="home_prompt" mode="replace" workspace_id={route.workspaceID} ref={bind}>
            <Prompt
              ref={bind}
              workspaceID={route.workspaceID}
              right={<TuiPluginRuntime.Slot name="home_prompt_right" workspace_id={route.workspaceID} />}
              placeholders={placeholder}
            />
          </TuiPluginRuntime.Slot>
        </box>
        <TuiPluginRuntime.Slot name="home_bottom" />
        <WorkspaceTodoPanel />
        <box flexGrow={1} minHeight={0} />
        <Toast />
      </box>
      <box width="100%" flexShrink={0}>
        <TuiPluginRuntime.Slot name="home_footer" mode="single_winner" />
      </box>
    </>
  )
}
