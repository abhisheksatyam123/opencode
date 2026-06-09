import { Show, createEffect, createMemo, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useNavigate } from "@solidjs/router"
import { useSpring } from "@opencode-ai/ui/motion-spring"
import { useLayout } from "@/context/layout"
import { PromptInput } from "@/components/prompt-input"
import { useLanguage } from "@/context/language"
import { usePrompt } from "@/context/prompt"
import { useSync } from "@/context/sync"
import { getSessionHandoff, setSessionHandoff } from "@/pages/session/handoff"
import { useSessionKey } from "@/pages/session/session-layout"
import { SessionFollowupDock } from "@/pages/session/composer/session-followup-dock"
import { SessionRevertDock } from "@/pages/session/composer/session-revert-dock"
import type { SessionComposerState } from "@/pages/session/composer/session-composer-state"
import { SessionTodoDock } from "@/pages/session/composer/session-todo-dock"
import type { FollowupDraft } from "@/components/prompt-input/submit"
import { createResizeObserver } from "@solid-primitives/resize-observer"

export function SessionComposerRegion(props: {
  state: SessionComposerState
  ready: boolean
  centered: boolean
  inputRef: (el: HTMLDivElement) => void
  newSessionWorktree: string
  onNewSessionWorktreeReset: () => void
  onSubmit: () => void
  followup?: {
    queue: () => boolean
    items: { id: string; text: string }[]
    sending?: string
    edit?: { id: string; prompt: FollowupDraft["prompt"]; context: FollowupDraft["context"] }
    onQueue: (draft: FollowupDraft) => void
    onAbort: () => void
    onSend: (id: string) => void
    onEdit: (id: string) => void
    onEditLoaded: () => void
  }
  revert?: {
    items: { id: string; text: string }[]
    restoring?: string
    disabled?: boolean
    onRestore: (id: string) => void
  }
  setPromptDockRef: (el: HTMLDivElement) => void
  sessionIDOverride?: string
  sessionKeyOverride?: string
}) {
  const navigate = useNavigate()
  const layout = useLayout()
  const prompt = usePrompt()
  const language = useLanguage()
  const route = useSessionKey()
  const sync = useSync()
  const sessionID = createMemo(() => props.sessionIDOverride ?? route.params.id)
  const sessionKey = createMemo(() => props.sessionKeyOverride ?? route.sessionKey())
  const view = layout.view(sessionKey)

  const handoffPrompt = createMemo(() => getSessionHandoff(sessionKey())?.prompt)
  const info = createMemo(() => (sessionID() ? sync.session.get(sessionID()!) : undefined))
  const parentID = createMemo(() => info()?.parentID)
  const child = createMemo(() => !!parentID())
  // Child sessions are first-class chat sessions too. Keep the composer visible
  // and render the child-session navigation chrome inside it. Previously this
  // hid the entire prompt dock for todo/subagent sessions, making Open chat
  // look like a read-only transcript with no input box.
  const showComposer = createMemo(() => true)
  const siblingChildren = createMemo(() => {
    const parent = parentID()
    if (!parent) return []
    return sync.data.session
      .filter((session) => session.parentID === parent)
      .toSorted((left, right) => (left.time.created ?? 0) - (right.time.created ?? 0))
  })
  const siblingIndex = createMemo(() => siblingChildren().findIndex((session) => session.id === sessionID()))
  const siblingCount = createMemo(() => siblingChildren().length)

  const previewPrompt = () =>
    prompt
      .current()
      .map((part) => {
        if (part.type === "file") return `[file:${part.path}]`
        if (part.type === "agent") return `@${part.name}`
        if (part.type === "image") return `[image:${part.filename}]`
        return part.content
      })
      .join("")
      .trim()

  createEffect(() => {
    if (!prompt.ready()) return
    setSessionHandoff(sessionKey(), { prompt: previewPrompt() })
  })

  const [store, setStore] = createStore({
    ready: false,
    height: 320,
    body: undefined as HTMLDivElement | undefined,
  })
  let timer: number | undefined
  let frame: number | undefined

  const clear = () => {
    if (timer !== undefined) {
      window.clearTimeout(timer)
      timer = undefined
    }
    if (frame !== undefined) {
      cancelAnimationFrame(frame)
      frame = undefined
    }
  }

  createEffect(() => {
    sessionKey()
    const ready = props.ready
    const delay = 140

    clear()
    setStore("ready", false)
    if (!ready) return

    frame = requestAnimationFrame(() => {
      frame = undefined
      timer = window.setTimeout(() => {
        setStore("ready", true)
        timer = undefined
      }, delay)
    })
  })

  onCleanup(clear)

  const open = createMemo(() => store.ready && props.state.dock() && !props.state.closing())
  const progress = useSpring(() => (open() ? 1 : 0), { visualDuration: 0.3, bounce: 0 })
  const value = createMemo(() => Math.max(0, Math.min(1, progress())))
  const dock = createMemo(() => (store.ready && props.state.dock()) || value() > 0.001)
  const rolled = createMemo(() => (props.revert?.items.length ? props.revert : undefined))
  const lift = createMemo(() => (rolled() ? 18 : 36 * value()))
  const full = createMemo(() => Math.max(78, store.height))

  const openParent = () => {
    const id = parentID()
    if (!id) return
    navigate(`/${route.params.dir}/session/${id}`)
  }

  const openSibling = (delta: -1 | 1) => {
    const list = siblingChildren()
    if (list.length === 0) return
    const index = siblingIndex()
    if (index < 0) return
    const next = list[index + delta]
    if (!next) return
    navigate(`/${route.params.dir}/session/${next.id}`)
  }

  createEffect(() => {
    const el = store.body
    if (!el) return
    const update = () => setStore("height", el.getBoundingClientRect().height)
    createResizeObserver(store.body, update)
    update()
  })

  return (
    <div
      ref={props.setPromptDockRef}
      data-component="session-prompt-dock"
      class="shrink-0 w-full pb-3 flex flex-col justify-center items-center bg-background-stronger pointer-events-none"
    >
      <div
        classList={{
          "w-full px-3 pointer-events-auto": true,
          "md:max-w-200 md:mx-auto 2xl:max-w-[1000px]": props.centered,
        }}
      >
        <Show when={showComposer()}>
          <Show
            when={true}
            fallback={
              <>
                <Show when={rolled()} keyed>
                  {(revert) => (
                    <div class="pb-2">
                      <SessionRevertDock
                        items={revert.items}
                        restoring={revert.restoring}
                        disabled={revert.disabled}
                        onRestore={revert.onRestore}
                      />
                    </div>
                  )}
                </Show>
                <div class="w-full min-h-32 md:min-h-40 rounded-md border border-border-weak-base bg-background-base/50 px-4 py-3 text-text-weak whitespace-pre-wrap pointer-events-none">
                  {handoffPrompt() || language.t("prompt.loading")}
                </div>
              </>
            }
          >
            <Show when={dock()}>
              <div
                classList={{
                  "overflow-hidden": true,
                  "pointer-events-none": value() < 0.98,
                }}
                style={{
                  "max-height": `${full() * value()}px`,
                }}
              >
                <div ref={(el) => setStore("body", el)}>
                  <SessionTodoDock
                    sessionID={sessionID()}
                    todos={props.state.todos()}
                    collapsed={view.todoCollapsed.get()}
                    onToggle={() => view.todoCollapsed.set(!view.todoCollapsed.get())}
                    collapseLabel={language.t("session.todo.collapse")}
                    expandLabel={language.t("session.todo.expand")}
                    dockProgress={value()}
                  />
                </div>
              </div>
            </Show>
            <Show when={rolled()} keyed>
              {(revert) => (
                <div
                  style={{
                    "margin-top": `${-36 * value()}px`,
                  }}
                >
                  <SessionRevertDock
                    items={revert.items}
                    restoring={revert.restoring}
                    disabled={revert.disabled}
                    onRestore={revert.onRestore}
                  />
                </div>
              )}
            </Show>
            <div
              classList={{
                "relative z-10": true,
              }}
              style={{
                "margin-top": `${-lift()}px`,
              }}
            >
              <Show when={props.followup?.items.length}>
                <SessionFollowupDock
                  items={props.followup!.items}
                  sending={props.followup!.sending}
                  onSend={props.followup!.onSend}
                  onEdit={props.followup!.onEdit}
                />
              </Show>
              <Show
                when={child()}
                fallback={
                  <PromptInput
                    ref={props.inputRef}
                    newSessionWorktree={props.newSessionWorktree}
                    onNewSessionWorktreeReset={props.onNewSessionWorktreeReset}
                    edit={props.followup?.edit}
                    onEditLoaded={props.followup?.onEditLoaded}
                    shouldQueue={props.followup?.queue}
                    onQueue={props.followup?.onQueue}
                    onAbort={props.followup?.onAbort}
                    onSubmit={props.onSubmit}
                    sessionIDOverride={props.sessionIDOverride}
                  />
                }
              >
                <div class="flex flex-col gap-2">
                  <div class="w-full rounded-[10px] border border-border-weak-base bg-surface-base/70 px-2.5 py-1.5 flex items-center justify-between gap-2">
                    <div class="min-w-0 flex items-center gap-1.5 text-11-mono text-text-weak">
                      <Show when={siblingCount() > 0}>
                        <span>
                          {Math.max(0, siblingIndex() + 1)} of {siblingCount()}
                        </span>
                      </Show>
                      <span class="truncate">{info()?.title ?? "Subagent session"}</span>
                    </div>
                    <div class="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        class="h-7 px-2 rounded-md text-12-medium text-text-base hover:bg-surface-raised-base-hover disabled:opacity-50 disabled:pointer-events-none"
                        onClick={openParent}
                      >
                        {language.t("session.child.backToParent")}
                      </button>
                      <button
                        type="button"
                        class="size-7 rounded-md text-text-base hover:bg-surface-raised-base-hover disabled:opacity-50 disabled:pointer-events-none"
                        aria-label="Previous subagent session"
                        disabled={siblingIndex() <= 0}
                        onClick={() => openSibling(-1)}
                      >
                        ←
                      </button>
                      <button
                        type="button"
                        class="size-7 rounded-md text-text-base hover:bg-surface-raised-base-hover disabled:opacity-50 disabled:pointer-events-none"
                        aria-label="Next subagent session"
                        disabled={siblingIndex() < 0 || siblingIndex() >= siblingCount() - 1}
                        onClick={() => openSibling(1)}
                      >
                        →
                      </button>
                    </div>
                  </div>
                  <PromptInput
                    ref={props.inputRef}
                    newSessionWorktree={props.newSessionWorktree}
                    onNewSessionWorktreeReset={props.onNewSessionWorktreeReset}
                    edit={props.followup?.edit}
                    onEditLoaded={props.followup?.onEditLoaded}
                    shouldQueue={props.followup?.queue}
                    onQueue={props.followup?.onQueue}
                    onAbort={props.followup?.onAbort}
                    onSubmit={props.onSubmit}
                    sessionIDOverride={props.sessionIDOverride}
                  />
                </div>
              </Show>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  )
}
