import {
  For,
  Match,
  Show,
  Suspense,
  Switch,
  createEffect,
  createMemo,
  createResource,
  lazy,
  onCleanup,
  type JSX,
} from "solid-js"
import { createStore } from "solid-js/store"
import { useBreakpoints } from "@/context/breakpoint"
import { Tabs } from "@opencode-ai/ui/tabs"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { Mark } from "@opencode-ai/ui/logo"
import { DragDropProvider, DragDropSensors, DragOverlay, SortableProvider, closestCenter } from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import type { SnapshotFileDiff, VcsFileDiff } from "@opencode-ai/sdk/v2"
import { getDirectory, getFilename } from "@opencode-ai/core/util/path"
import { ConstrainDragYAxis, getDraggableId } from "@/utils/solid-dnd"
import { useDialog } from "@opencode-ai/ui/context/dialog"

import FileTree from "@/components/file-tree"
import { SessionContextUsage } from "@/components/session-context-usage"
import { SessionContextTab, SortableTab, FileVisual } from "@/components/session"
import { useCommand } from "@/context/command"
import { useFile, type SelectedLineRange } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { useSync } from "@/context/sync"
import { createFileTabListSync } from "@/pages/session/file-tab-scroll"
import { FileTabContent } from "@/pages/session/file-tabs"
import { createOpenSessionFileTab, createSessionTabs, getTabReorderIndex, type Sizing } from "@/pages/session/helpers"
import { parseSurfaceURI } from "@/pages/session/workbench/surface-id"
import { setSessionHandoff } from "@/pages/session/handoff"
import { useSessionLayout } from "@/pages/session/session-layout"

type RenderDiff = (SnapshotFileDiff & { file: string }) | VcsFileDiff
const surfaceTabValues = new Set<string>(["files", "tasks", "stats", "notes", "intelgraph", "logs", "agents", "review"])

const SurfaceTasksTab = lazy(() =>
  import("@/pages/session/surface-tabs/tasks-tab").then((mod) => ({ default: mod.SurfaceTasksTab })),
)
const SurfaceStatsTab = lazy(() =>
  import("@/pages/session/surface-tabs/stats-tab").then((mod) => ({ default: mod.SurfaceStatsTab })),
)
const SurfaceNotesTab = lazy(() =>
  import("@/pages/session/surface-tabs/notes-tab").then((mod) => ({ default: mod.SurfaceNotesTab })),
)
const SurfaceIntelGraphTab = lazy(() =>
  import("@/pages/session/surface-tabs/intelgraph-tab").then((mod) => ({ default: mod.SurfaceIntelGraphTab })),
)
const SurfaceLogsTab = lazy(() =>
  import("@/pages/session/surface-tabs/logs-tab").then((mod) => ({ default: mod.SurfaceLogsTab })),
)

function SurfaceTabLoading(props: { label: string }) {
  return (
    <div class="flex h-full items-center justify-center p-4 text-12-regular text-text-weak" role="status">
      Loading {props.label}…
    </div>
  )
}

function renderDiff(value: SnapshotFileDiff | VcsFileDiff): value is RenderDiff {
  return typeof value.file === "string"
}

export function SessionSidePanel(props: {
  canReview: () => boolean
  diffs: () => (SnapshotFileDiff | VcsFileDiff)[]
  diffsReady: () => boolean
  empty: () => string
  hasReview: () => boolean
  reviewCount: () => number
  reviewPanel: () => JSX.Element
  sessionID?: () => string | undefined
  activeDiff?: string
  focusReviewDiff: (path: string) => void
  reviewSnap: boolean
  size: Sizing
  mobileOpen?: () => boolean
  onMobileNavigate?: (tab: "session" | "changes" | "panels") => void
}) {
  const layout = useLayout()
  const platform = usePlatform()
  const settings = useSettings()
  const sync = useSync()
  const file = useFile()
  const language = useLanguage()
  const command = useCommand()
  const dialog = useDialog()
  const { params, sessionKey, tabs, view } = useSessionLayout()

  const breakpoints = useBreakpoints()
  const isDesktop = breakpoints.isDesktop
  const shown = createMemo(
    () =>
      platform.platform !== "desktop" ||
      import.meta.env.VITE_OPENCODE_CHANNEL !== "beta" ||
      settings.general.showFileTree(),
  )

  const mobileOpen = createMemo(() => !isDesktop() && !!props.mobileOpen?.())
  const panelVisible = createMemo(() => isDesktop() || mobileOpen())
  const fileOpen = createMemo(() => shown() && layout.fileTree.opened())
  const reviewOpen = createMemo(() => (isDesktop() && view().reviewPanel.opened()) || (mobileOpen() && !fileOpen()))
  const open = createMemo(() => reviewOpen() || fileOpen())
  const reviewTab = createMemo(() => isDesktop())
  const panelWidth = createMemo(() => {
    if (!open()) return "0px"
    return "100%"
  })
  const treeWidth = createMemo(() => {
    if (!fileOpen()) return "0px"
    if (!reviewOpen()) return "100%"
    return `${layout.fileTree.width()}px`
  })

  const diffs = createMemo(() => props.diffs().filter(renderDiff))
  const diffFiles = createMemo(() => diffs().map((d) => d.file))
  const kinds = createMemo(() => {
    const merge = (a: "add" | "del" | "mix" | undefined, b: "add" | "del" | "mix") => {
      if (!a) return b
      if (a === b) return a
      return "mix" as const
    }

    const normalize = (p: string) => p.replaceAll("\\\\", "/").replace(/\/+$/, "")

    const out = new Map<string, "add" | "del" | "mix">()
    for (const diff of diffs()) {
      const file = normalize(diff.file)
      const kind = diff.status === "added" ? "add" : diff.status === "deleted" ? "del" : "mix"

      out.set(file, kind)

      const parts = file.split("/")
      for (const [idx] of parts.slice(0, -1).entries()) {
        const dir = parts.slice(0, idx + 1).join("/")
        if (!dir) continue
        out.set(dir, merge(out.get(dir), kind))
      }
    }
    return out
  })

  const empty = (msg: string) => (
    <div class="h-full flex flex-col">
      <div class="h-6 shrink-0" aria-hidden />
      <div class="flex-1 pb-64 flex items-center justify-center text-center">
        <div class="text-12-regular text-text-weak">{msg}</div>
      </div>
    </div>
  )

  const ChatTabContent = (props: { tab: string }) => {
    const sessionID = () => {
      const parsed = parseSurfaceURI(props.tab)
      return parsed?.kind === "chat" ? parsed.sessionID : props.tab.slice("chat://".length)
    }
    const src = () => `/${params.dir}/session/${encodeURIComponent(sessionID())}?view=chat&embed=chat`
    return (
      <iframe
        title={`Chat ${sessionID()}`}
        src={src()}
        class="h-full w-full border-0 bg-background-base"
        referrerPolicy="no-referrer"
        loading="eager"
      />
    )
  }

  const nofiles = createMemo(() => {
    const state = file.tree.state("")
    if (!state?.loaded) return false
    return file.tree.children("").length === 0
  })

  const normalizeTab = (tab: string) => {
    if (!tab.startsWith("file://")) return tab
    return file.tab(tab)
  }

  const openReviewPanel = () => {
    if (!view().reviewPanel.opened()) view().reviewPanel.open()
  }

  const fileTreeTab = () => layout.fileTree.tab()

  const setFileTreeTabValue = (value: string) => {
    if (value !== "changes" && value !== "all") return
    layout.fileTree.setTab(value)
  }

  const showAllFiles = () => {
    if (!layout.fileTree.opened()) layout.fileTree.open()
    if (fileTreeTab() === "all") return
    layout.fileTree.setTab("all")
  }

  const openReviewWithFileExplorer = () => {
    showAllFiles()
    openReviewPanel()
  }

  const openFileTab = createOpenSessionFileTab({
    normalizeTab,
    openTab: tabs().open,
    pathFromTab: file.pathFromTab,
    loadFile: file.load,
    openReviewPanel: openReviewWithFileExplorer,
    setActive: tabs().setActive,
  })

  const openTab = (value: string) => {
    if (surfaceTabValues.has(value) || value.startsWith("chat://")) {
      openReviewPanel()
      void tabs().open(value)
      tabs().setActive(value)
      return
    }
    openFileTab(value)
  }

  const tabState = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab,
    review: reviewTab,
    hasReview: props.canReview,
  })
  const contextOpen = tabState.contextOpen
  const openedTabs = tabState.openedTabs
  const activeTab = tabState.activeTab
  const selectedTab = createMemo(() => {
    const active = tabs().active()
    return active && (surfaceTabValues.has(active) || active.startsWith("chat://")) ? active : activeTab()
  })
  const isChatTab = (tab: string | undefined) => !!tab?.startsWith("chat://")
  const openedFileTabs = createMemo(() =>
    openedTabs().filter((tab) => !surfaceTabValues.has(tab) && !tab.startsWith("chat://")),
  )
  const activeFileTab = createMemo(() => {
    const tab = tabState.activeFileTab()
    return tab && !surfaceTabValues.has(tab) ? tab : undefined
  })
  const relationWindowDocked = createMemo(() => tabs().all().includes("intelgraph") && selectedTab() !== "intelgraph")

  const paneATabs = createMemo(() => {
    const list = openedTabs().filter((tab) => tab !== "context")
    return list.filter((tab) => !tabs().allB().includes(tab))
  })

  const paneBTabs = createMemo(() => tabs().allB())

  const paneAChatTabs = createMemo(() => paneATabs().filter(isChatTab))
  const paneBChatTabs = createMemo(() => paneBTabs().filter(isChatTab))

  function renderPaneContent(tabValue: () => string | undefined, chatTabs: () => string[]) {
    const active = () => tabValue() || "empty"
    return (
      <>
        <For each={chatTabs()}>
          {(tab) => {
            const current = () => active() === tab
            return (
              <div
                class="absolute inset-0 min-h-0 bg-background-base"
                classList={{
                  "z-10 opacity-100": current(),
                  "z-0 pointer-events-none opacity-0": !current(),
                }}
                aria-hidden={!current()}
                inert={!current()}
              >
                {renderTabContent(tab)}
              </div>
            )
          }}
        </For>
        <Show when={!isChatTab(active())}>
          <div class="absolute inset-0 min-h-0 overflow-y-auto">{renderTabContent(active())}</div>
        </Show>
      </>
    )
  }

  function renderTabContent(tabValue: string) {
    return (
      <Switch>
        <Match when={tabValue === "review"}>
          <div class="flex flex-col h-full overflow-hidden contain-strict">
            <Show when={reviewOpen()}>{props.reviewPanel()}</Show>
          </div>
        </Match>
        <Match when={tabValue === "empty"}>
          <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
            <div class="h-full px-6 pb-42 -mt-4 flex flex-col items-center justify-center text-center gap-6">
              <Mark class="w-14 opacity-10" />
              <div class="text-14-regular text-text-weak max-w-56">{language.t("session.files.selectToOpen")}</div>
            </div>
          </div>
        </Match>
        <Match when={tabValue === "context"}>
          <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
            <SessionContextTab />
          </div>
        </Match>
        <Match when={tabValue === "files"}>
          <div class="relative flex-1 min-h-0 overflow-y-auto bg-background-stronger px-3 py-3">
            <Switch>
              <Match when={nofiles() && !fileQuery()}>{empty(language.t("session.files.empty"))}</Match>
              <Match when={true}>
                <FileTree
                  path=""
                  modified={diffFiles()}
                  kinds={kinds()}
                  onFileClick={(node) => openTab(file.tab(node.path))}
                />
              </Match>
            </Switch>
          </div>
        </Match>
        <Match when={tabValue === "tasks"}>
          <Suspense fallback={<SurfaceTabLoading label="tasks" />}>
            <SurfaceTasksTab sessionID={props.sessionID?.()} />
          </Suspense>
        </Match>
        <Match when={tabValue === "stats"}>
          <Suspense fallback={<SurfaceTabLoading label="stats" />}>
            <SurfaceStatsTab sessionID={props.sessionID?.()} />
          </Suspense>
        </Match>
        <Match when={tabValue === "agents"}>
          <Suspense fallback={<SurfaceTabLoading label="stats" />}>
            <SurfaceStatsTab sessionID={props.sessionID?.()} />
          </Suspense>
        </Match>
        <Match when={tabValue === "notes"}>
          <Suspense fallback={<SurfaceTabLoading label="notes" />}>
            <SurfaceNotesTab />
          </Suspense>
        </Match>
        <Match when={tabValue === "intelgraph"}>
          <Suspense fallback={<SurfaceTabLoading label="IntelGraph" />}>
            <SurfaceIntelGraphTab />
          </Suspense>
        </Match>
        <Match when={tabValue === "logs"}>
          <Suspense fallback={<SurfaceTabLoading label="logs" />}>
            <SurfaceLogsTab />
          </Suspense>
        </Match>
        <Match when={tabValue.startsWith("chat://")}>
          <ChatTabContent tab={tabValue} />
        </Match>
        <Match when={tabValue.startsWith("file://")}>
          <FileTabContent tab={tabValue} />
        </Match>
      </Switch>
    )
  }

  const [store, setStore] = createStore({
    activeDraggable: undefined as string | undefined,
    fileQuery: "",
    paneBWidth: undefined as number | undefined,
  })

  const fileQuery = createMemo(() => store.fileQuery.trim())
  const [fileSearch] = createResource(
    fileQuery,
    async (query) => {
      if (!query) return []
      return (await file.searchFiles(query)).slice(0, 100)
    },
    { initialValue: [] as string[] },
  )
  const fileSearchResults = createMemo(() => {
    if (!fileQuery()) return []
    const latest = fileSearch.latest
    return latest ?? []
  })
  const searchingFiles = createMemo(() => !!fileQuery() && fileSearch.loading)

  const openFromFileSearch = (path: string) => {
    setStore("fileQuery", "")
    openTab(file.tab(path))
  }

  const handleDragStart = (event: unknown) => {
    const id = getDraggableId(event)
    if (!id) return
    setStore("activeDraggable", id)
  }

  const handleDragOver = (event: DragEvent) => {
    const { draggable, droppable } = event
    if (!draggable || !droppable) return

    const currentTabs = tabs().all()
    const toIndex = getTabReorderIndex(currentTabs, draggable.id.toString(), droppable.id.toString())
    if (toIndex === undefined) return
    tabs().move(draggable.id.toString(), toIndex)
  }

  const handleDragEnd = () => {
    setStore("activeDraggable", undefined)
  }

  let splitPaneContainer: HTMLDivElement | undefined
  const paneBDefaultWidth = () => Math.round((splitPaneContainer?.clientWidth ?? 1155) * 0.45)
  const paneBWidth = createMemo(() => (store.paneBWidth ? `${store.paneBWidth}px` : "45%"))
  const paneBResizeMax = createMemo(() =>
    Math.max(360, Math.min(1200, (splitPaneContainer?.clientWidth ?? 1200) - 360)),
  )

  const mergePaneBToA = () => {
    const opened = [...paneBTabs()]
    for (const tab of opened) tabs().moveTabToA(tab)
    setStore("paneBWidth", undefined)
  }

  const activePanelLabel = createMemo(() => {
    const active = selectedTab()
    if (active === "files") return language.t("session.files.all")
    if (active === "tasks") return "Todo File"
    if (active === "context") return language.t("session.tab.context")
    if (active === "stats" || active === "agents") return "Stats"
    if (active === "notes") return "Notes"
    if (active === "intelgraph") return "IntelGraph"
    if (active === "logs") return "Logs"
    if (active === "review") return language.t("session.tab.review")
    if (active.startsWith("chat://")) return "Chat"
    if (fileOpen() && fileTreeTab() === "all") return "File Vault"
    if (view().terminal.opened()) return language.t("terminal.title")
    return "Panels"
  })

  createEffect(() => {
    if (!file.ready()) return

    setSessionHandoff(sessionKey(), {
      files: tabs()
        .all()
        .reduce<Record<string, SelectedLineRange | null>>((acc, tab) => {
          const path = file.pathFromTab(tab)
          if (!path) return acc

          const selected = file.selectedLines(path)
          acc[path] =
            selected && typeof selected === "object" && "start" in selected && "end" in selected
              ? (selected as SelectedLineRange)
              : null

          return acc
        }, {}),
    })
  })

  return (
    <Show when={panelVisible()}>
      <aside
        id="review-panel"
        aria-label={language.t("session.panel.reviewAndFiles")}
        aria-hidden={!open()}
        inert={!open()}
        class="relative min-w-0 h-full flex shrink-0 overflow-hidden bg-background-base"
        classList={{
          "pointer-events-none": !open(),
          "flex-1": mobileOpen(),
          "transition-[width] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
            !mobileOpen() && !props.size.active() && !props.reviewSnap,
        }}
        style={{ width: panelWidth() }}
      >
        <Show when={open()}>
          <div class="size-full flex border-l border-border-weaker-base">
            <Show when={shown()}>
              <div
                id="file-tree-panel"
                aria-hidden={!fileOpen()}
                inert={!fileOpen()}
                class="relative min-w-0 h-full shrink-0 overflow-hidden"
                classList={{
                  "pointer-events-none": !fileOpen(),
                  "transition-[width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
                    !props.size.active(),
                }}
                style={{ width: treeWidth() }}
              >
                <div
                  class="h-full flex flex-col overflow-hidden group/filetree"
                  classList={{ "border-r border-border-weaker-base": reviewOpen() }}
                >
                  <Tabs
                    variant="pill"
                    value={fileTreeTab()}
                    onChange={setFileTreeTabValue}
                    class="h-full"
                    data-scope="filetree"
                  >
                    <Tabs.List>
                      <Tabs.Trigger value="changes" class="flex-1" classes={{ button: "w-full" }}>
                        {props.reviewCount()}{" "}
                        {language.t(
                          props.reviewCount() === 1 ? "session.review.change.one" : "session.review.change.other",
                        )}
                      </Tabs.Trigger>
                      <Tabs.Trigger value="all" class="flex-1" classes={{ button: "w-full" }}>
                        {language.t("session.files.all")}
                      </Tabs.Trigger>
                    </Tabs.List>
                    <Tabs.Content value="changes" class="bg-background-stronger px-3 py-0">
                      <Switch>
                        <Match when={props.hasReview() || !props.diffsReady()}>
                          <Show
                            when={props.diffsReady()}
                            fallback={
                              <div class="px-2 py-2 text-12-regular text-text-weak">
                                {language.t("common.loading")}
                                {language.t("common.loading.ellipsis")}
                              </div>
                            }
                          >
                            <FileTree
                              path=""
                              class="pt-3"
                              allowed={diffFiles()}
                              kinds={kinds()}
                              draggable={false}
                              active={props.activeDiff}
                              onFileClick={(node) => props.focusReviewDiff(node.path)}
                            />
                          </Show>
                        </Match>
                      </Switch>
                    </Tabs.Content>
                    <Tabs.Content value="all" class="bg-background-stronger px-3 py-0">
                      <div class="pt-3 pb-2 h-full min-h-0 flex flex-col gap-2">
                        <input
                          class="w-full px-2 py-1.5 rounded-md bg-surface-base border border-border-base text-12-regular text-text-base outline-none"
                          placeholder={language.t("session.header.searchFiles")}
                          value={store.fileQuery}
                          onKeyDown={(event) => {
                            if (event.key !== "Enter") return
                            if (!fileQuery()) return
                            const first = fileSearchResults()[0]
                            if (!first) return
                            event.preventDefault()
                            openFromFileSearch(first)
                          }}
                          onInput={(event) => {
                            setStore("fileQuery", event.currentTarget.value)
                          }}
                        />
                        <Show when={fileQuery()}>
                          <div class="rounded-md border border-border-weaker-base bg-surface-base max-h-44 overflow-y-auto">
                            <Switch>
                              <Match when={searchingFiles() && fileSearchResults().length === 0}>
                                <div class="px-2 py-2 text-12-regular text-text-weak">
                                  {language.t("common.loading")}
                                  {language.t("common.loading.ellipsis")}
                                </div>
                              </Match>
                              <Match when={fileSearchResults().length === 0}>
                                <div class="px-2 py-2 text-12-regular text-text-weak">
                                  {language.t("palette.empty")}
                                </div>
                              </Match>
                              <Match when={true}>
                                <For each={fileSearchResults().slice(0, 30)}>
                                  {(path) => (
                                    <button
                                      type="button"
                                      class="w-full px-2 py-1.5 text-left text-12-regular hover:bg-surface-raised-base-hover"
                                      onClick={() => openFromFileSearch(path)}
                                      title={path}
                                    >
                                      <div class="truncate text-text-strong">{getFilename(path)}</div>
                                      <div class="truncate text-11-regular text-text-weak">{getDirectory(path)}</div>
                                    </button>
                                  )}
                                </For>
                              </Match>
                            </Switch>
                          </div>
                        </Show>
                        <div class="min-h-0 flex-1 overflow-y-auto">
                          <Switch>
                            <Match when={nofiles() && !fileQuery()}>{empty(language.t("session.files.empty"))}</Match>
                            <Match when={fileQuery() && !searchingFiles() && fileSearchResults().length === 0}>
                              {empty(language.t("palette.empty"))}
                            </Match>
                            <Match when={true}>
                              <FileTree
                                path=""
                                modified={diffFiles()}
                                kinds={kinds()}
                                allowed={fileQuery() ? fileSearchResults() : undefined}
                                onFileClick={(node) => openTab(file.tab(node.path))}
                              />
                            </Match>
                          </Switch>
                        </div>
                      </div>
                    </Tabs.Content>
                  </Tabs>
                </div>
                <Show when={fileOpen() && isDesktop()}>
                  <div onPointerDown={() => props.size.start()}>
                    <ResizeHandle
                      direction="horizontal"
                      edge="end"
                      size={layout.fileTree.width()}
                      min={200}
                      max={480}
                      onResize={(width) => {
                        props.size.touch()
                        layout.fileTree.resize(width)
                      }}
                    />
                  </div>
                </Show>
              </div>
            </Show>

            <div
              aria-hidden={!reviewOpen()}
              inert={!reviewOpen()}
              class="relative min-w-0 h-full flex-1 overflow-hidden bg-background-base"
              classList={{
                "pointer-events-none": !reviewOpen(),
                hidden: !reviewOpen(),
              }}
            >
              <div class="size-full min-w-0 h-full bg-background-base flex">
                <div class="min-w-0 flex-1">
                  <DragDropProvider
                    onDragStart={handleDragStart}
                    onDragEnd={handleDragEnd}
                    onDragOver={handleDragOver}
                    collisionDetector={closestCenter}
                  >
                    <DragDropSensors />
                    <ConstrainDragYAxis />
                    <Tabs value={selectedTab()} onChange={openTab}>
                      <div
                        class="flex h-full w-full min-h-0 overflow-hidden bg-background-base"
                        ref={splitPaneContainer}
                      >
                        {/* Pane A Column */}
                        <div class="flex flex-col min-w-0 flex-1 h-full border-r border-border-weaker-base">
                          {/* Pane A Tab Strip */}
                          <div class="sticky top-0 shrink-0 flex border-b border-border-weaker-base bg-background-stronger">
                            <Tabs.List
                              ref={(el: HTMLDivElement) => {
                                const stop = createFileTabListSync({ el, contextOpen })
                                onCleanup(stop)
                              }}
                            >
                              <div
                                class="sticky left-0 z-20 h-full bg-background-stronger px-2 items-center gap-2 border-r border-border-weaker-base"
                                classList={{ flex: !mobileOpen(), hidden: mobileOpen() }}
                              >
                                <div class="text-12-regular text-text-weak truncate max-w-28">{activePanelLabel()}</div>
                              </div>

                              <SortableProvider ids={paneATabs()}>
                                <For each={paneATabs()}>
                                  {(tab) => (
                                    <SortableTab
                                      tab={tab}
                                      onTabClose={tabs().close}
                                      onTabSplit={(t) => tabs().moveTabToB(t)}
                                      splitIcon="chevron-right"
                                    />
                                  )}
                                </For>
                              </SortableProvider>

                              <div class="bg-background-stronger h-full shrink-0 sticky right-0 z-10 flex items-center justify-center pr-3">
                                <TooltipKeybind
                                  title={language.t("command.file.open")}
                                  keybind={command.keybind("file.open")}
                                  class="flex items-center"
                                >
                                  <IconButton
                                    icon="plus-small"
                                    variant="ghost"
                                    iconSize="large"
                                    class="!rounded-md"
                                    onClick={() => {
                                      void import("@/components/dialog-select-file").then((x) => {
                                        dialog.show(() => <x.DialogSelectFile mode="files" onOpenFile={showAllFiles} />)
                                      })
                                    }}
                                    aria-label={language.t("command.file.open")}
                                  />
                                </TooltipKeybind>
                              </div>
                            </Tabs.List>
                          </div>

                          {/* Pane A Content View */}
                          <div class="flex-1 min-h-0 relative overflow-hidden">
                            {renderPaneContent(selectedTab, paneAChatTabs)}
                          </div>
                        </div>

                        {/* Pane B Column (Split Pane) */}
                        <Show when={paneBTabs().length > 0}>
                          <div class="relative h-full w-0 shrink-0" onPointerDown={() => props.size.start()}>
                            <ResizeHandle
                              direction="horizontal"
                              edge="start"
                              size={store.paneBWidth ?? paneBDefaultWidth()}
                              min={280}
                              max={paneBResizeMax()}
                              class="h-full"
                              onResize={(width) => {
                                props.size.touch()
                                setStore("paneBWidth", width)
                              }}
                            />
                          </div>
                          <div
                            class="flex flex-col min-w-[280px] h-full bg-background-base border-l border-border-weaker-base transition-[width] duration-150 ease-out motion-reduce:transition-none"
                            style={{ width: paneBWidth() }}
                          >
                            {/* Pane B Tab Strip */}
                            <div class="sticky top-0 shrink-0 flex border-b border-border-weaker-base bg-background-stronger">
                              <Tabs.List>
                                <SortableProvider ids={paneBTabs()}>
                                  <For each={paneBTabs()}>
                                    {(tab) => (
                                      <SortableTab
                                        tab={tab}
                                        onTabClose={(t) => tabs().closeB(t)}
                                        onTabSplit={(t) => tabs().moveTabToA(t)}
                                        splitIcon="chevron-left"
                                      />
                                    )}
                                  </For>
                                </SortableProvider>
                                <div class="sticky right-0 z-10 ml-auto flex h-full shrink-0 items-center border-l border-border-weaker-base bg-background-stronger px-2">
                                  <IconButton
                                    icon="layout-left"
                                    variant="ghost"
                                    iconSize="small"
                                    class="!rounded-md"
                                    title="Return split tabs to single pane"
                                    aria-label="Return split tabs to single pane"
                                    onClick={mergePaneBToA}
                                  />
                                </div>
                              </Tabs.List>
                            </div>

                            {/* Pane B Content View */}
                            <div class="flex-1 min-h-0 relative overflow-hidden">
                              {renderPaneContent(() => tabs().activeB() || paneBTabs()[0], paneBChatTabs)}
                            </div>
                          </div>
                        </Show>
                      </div>
                    </Tabs>
                    <DragOverlay>
                      <Show when={store.activeDraggable} keyed>
                        {(tab) => {
                          const path = file.pathFromTab(tab)
                          return (
                            <div data-component="tabs-drag-preview">
                              <Show when={path}>{(p) => <FileVisual active path={p()} />}</Show>
                            </div>
                          )
                        }}
                      </Show>
                    </DragOverlay>
                  </DragDropProvider>
                </div>
              </div>
            </div>
          </div>
        </Show>
      </aside>
    </Show>
  )
}
