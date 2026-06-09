import { AppIcon } from "@opencode-ai/ui/app-icon"
import { Button } from "@opencode-ai/ui/button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon, type IconProps } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Keybind } from "@opencode-ai/ui/keybind"
import { showToast } from "@opencode-ai/ui/toast"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { getFilename } from "@opencode-ai/core/util/path"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Portal } from "solid-js/web"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { useSettings } from "@/context/settings"
import { useTerminal } from "@/context/terminal"
import { focusTerminalById } from "@/pages/session/helpers"
import { useSessionLayout } from "@/pages/session/session-layout"
import { decode64 } from "@/utils/base64"
import { Persist, persisted } from "@/utils/persist"

const OPEN_APPS = [
  "vscode",
  "cursor",
  "zed",
  "textmate",
  "antigravity",
  "finder",
  "terminal",
  "iterm2",
  "ghostty",
  "warp",
  "xcode",
  "android-studio",
  "powershell",
  "sublime-text",
] as const

type OpenApp = (typeof OPEN_APPS)[number]
type OS = "macos" | "windows" | "linux" | "unknown"
type SessionPanel = "files" | "tasks" | "context" | "stats" | "agents" | "notes" | "intelgraph" | "logs" | "review"
type SessionTabId = "chat" | "tasks" | "stats" | "review" | "files" | "notes" | "intelgraph" | "logs"
type SessionTabAction =
  | { kind: "chat" }
  | { kind: "panel"; panel: Exclude<SessionPanel, "context"> }
type SessionTabDefinition = {
  id: SessionTabId
  label: string
  icon: IconProps["name"]
  action: SessionTabAction
  translate?: boolean
}

const SESSION_TABS = [
  { id: "chat", label: "Open Chat", icon: "bubble-5", action: { kind: "chat" } },
  { id: "tasks", label: "Open Tasks", icon: "checklist", action: { kind: "panel", panel: "tasks" } },
  { id: "stats", label: "Open Stats", icon: "arrow-up", action: { kind: "panel", panel: "stats" } },
  {
    id: "review",
    label: "session.tab.review",
    icon: "review",
    action: { kind: "panel", panel: "review" },
    translate: true,
  },
  { id: "files", label: "Open Files", icon: "file-tree", action: { kind: "panel", panel: "files" } },
  { id: "notes", label: "Open Notes", icon: "pencil-line", action: { kind: "panel", panel: "notes" } },
  {
    id: "intelgraph",
    label: "Open IntelGraph",
    icon: "align-right",
    action: { kind: "panel", panel: "intelgraph" },
  },
  { id: "logs", label: "Open Logs", icon: "console", action: { kind: "panel", panel: "logs" } },
] as const satisfies readonly SessionTabDefinition[]

const MAC_APPS = [
  {
    id: "vscode",
    label: "session.header.open.app.vscode",
    icon: "vscode",
    openWith: "Visual Studio Code",
  },
  { id: "cursor", label: "session.header.open.app.cursor", icon: "cursor", openWith: "Cursor" },
  { id: "zed", label: "session.header.open.app.zed", icon: "zed", openWith: "Zed" },
  { id: "textmate", label: "session.header.open.app.textmate", icon: "textmate", openWith: "TextMate" },
  {
    id: "antigravity",
    label: "session.header.open.app.antigravity",
    icon: "antigravity",
    openWith: "Antigravity",
  },
  { id: "terminal", label: "session.header.open.app.terminal", icon: "terminal", openWith: "Terminal" },
  { id: "iterm2", label: "session.header.open.app.iterm2", icon: "iterm2", openWith: "iTerm" },
  { id: "ghostty", label: "session.header.open.app.ghostty", icon: "ghostty", openWith: "Ghostty" },
  { id: "warp", label: "session.header.open.app.warp", icon: "warp", openWith: "Warp" },
  { id: "xcode", label: "session.header.open.app.xcode", icon: "xcode", openWith: "Xcode" },
  {
    id: "android-studio",
    label: "session.header.open.app.androidStudio",
    icon: "android-studio",
    openWith: "Android Studio",
  },
  {
    id: "sublime-text",
    label: "session.header.open.app.sublimeText",
    icon: "sublime-text",
    openWith: "Sublime Text",
  },
] as const

const WINDOWS_APPS = [
  { id: "vscode", label: "session.header.open.app.vscode", icon: "vscode", openWith: "code" },
  { id: "cursor", label: "session.header.open.app.cursor", icon: "cursor", openWith: "cursor" },
  { id: "zed", label: "session.header.open.app.zed", icon: "zed", openWith: "zed" },
  {
    id: "powershell",
    label: "session.header.open.app.powershell",
    icon: "powershell",
    openWith: "powershell",
  },
  {
    id: "sublime-text",
    label: "session.header.open.app.sublimeText",
    icon: "sublime-text",
    openWith: "Sublime Text",
  },
] as const

const LINUX_APPS = [
  { id: "vscode", label: "session.header.open.app.vscode", icon: "vscode", openWith: "code" },
  { id: "cursor", label: "session.header.open.app.cursor", icon: "cursor", openWith: "cursor" },
  { id: "zed", label: "session.header.open.app.zed", icon: "zed", openWith: "zed" },
  {
    id: "sublime-text",
    label: "session.header.open.app.sublimeText",
    icon: "sublime-text",
    openWith: "Sublime Text",
  },
] as const

const detectOS = (platform: ReturnType<typeof usePlatform>): OS => {
  if (platform.platform === "desktop" && platform.os) return platform.os
  if (typeof navigator !== "object") return "unknown"
  const value = navigator.platform || navigator.userAgent
  if (/Mac/i.test(value)) return "macos"
  if (/Win/i.test(value)) return "windows"
  if (/Linux/i.test(value)) return "linux"
  return "unknown"
}

const showRequestError = (language: ReturnType<typeof useLanguage>, err: unknown) => {
  showToast({
    variant: "error",
    title: language.t("common.requestFailed"),
    description: err instanceof Error ? err.message : String(err),
  })
}

export function SessionHeader() {
  const layout = useLayout()
  const command = useCommand()
  const server = useServer()
  const platform = usePlatform()
  const language = useLanguage()
  const settings = useSettings()
  const terminal = useTerminal()
  const { params, tabs, view } = useSessionLayout()

  const projectDirectory = createMemo(() => decode64(params.dir) ?? "")
  const project = createMemo(() => {
    const directory = projectDirectory()
    if (!directory) return
    return layout.projects.list().find((p) => p.worktree === directory || p.sandboxes?.includes(directory))
  })
  const name = createMemo(() => {
    const current = project()
    if (current) return current.name || getFilename(current.worktree)
    return getFilename(projectDirectory())
  })
  const hotkey = createMemo(() => command.keybind("file.open"))
  const os = createMemo(() => detectOS(platform))
  const isDesktopBeta = platform.platform === "desktop" && import.meta.env.VITE_OPENCODE_CHANNEL === "beta"
  const search = createMemo(() => !isDesktopBeta || settings.general.showSearch())
  const tree = createMemo(() => !isDesktopBeta || settings.general.showFileTree())
  const term = createMemo(() => !isDesktopBeta || settings.general.showTerminal())

  const [exists, setExists] = createStore<Partial<Record<OpenApp, boolean>>>({
    finder: true,
  })

  const apps = createMemo(() => {
    if (os() === "macos") return MAC_APPS
    if (os() === "windows") return WINDOWS_APPS
    return LINUX_APPS
  })

  const fileManager = createMemo(() => {
    if (os() === "macos") return { label: "session.header.open.finder", icon: "finder" as const }
    if (os() === "windows") return { label: "session.header.open.fileExplorer", icon: "file-explorer" as const }
    return { label: "session.header.open.fileManager", icon: "finder" as const }
  })

  createEffect(() => {
    if (platform.platform !== "desktop") return
    if (!platform.checkAppExists) return

    const list = apps()

    setExists(Object.fromEntries(list.map((app) => [app.id, undefined])) as Partial<Record<OpenApp, boolean>>)

    void Promise.all(
      list.map((app) =>
        Promise.resolve(platform.checkAppExists?.(app.openWith))
          .then((value) => Boolean(value))
          .catch(() => false)
          .then((ok) => [app.id, ok] as const),
      ),
    ).then((entries) => {
      setExists(Object.fromEntries(entries) as Partial<Record<OpenApp, boolean>>)
    })
  })

  const options = createMemo(() => {
    return [
      { id: "finder", label: language.t(fileManager().label), icon: fileManager().icon },
      ...apps()
        .filter((app) => exists[app.id])
        .map((app) => ({ ...app, label: language.t(app.label) })),
    ] as const
  })

  const openTerminalPanel = () => {
    if (!view().terminal.opened()) view().terminal.open()

    const id = terminal.active()
    if (!id) return
    focusTerminalById(id)
  }

  const toggleTerminal = () => {
    const next = !view().terminal.opened()
    view().terminal.toggle()
    if (!next) return

    const id = terminal.active()
    if (!id) return
    focusTerminalById(id)
  }

  const [prefs, setPrefs] = persisted(Persist.global("open.app"), createStore({ app: "finder" as OpenApp }))
  const [navigation, setNavigation] = createStore({ open: false })

  // Sync mobile nav button (titlebar) → navigation dropdown
  createEffect(() => {
    if (layout.mobileNav.opened()) {
      setNavigation("open", true)
      layout.mobileNav.hide()
    }
  })
  const [openRequest, setOpenRequest] = createStore({
    app: undefined as OpenApp | undefined,
  })
  const openSessionPanel = (panel: SessionPanel) => {
    if (!params.id) return
    if (layout.fileTree.opened()) layout.fileTree.close()
    view().reviewPanel.open()
    void tabs().open(panel)
    tabs().setActive(panel)
    setNavigation("open", false)
  }

  const openChatView = () => {
    if (!params.id) return
    view().reviewPanel.close()
    layout.fileTree.close()
    setNavigation("open", false)
  }

  const toggleSurfacePanel = (panel: Exclude<SessionPanel, "context">) => {
    openSessionPanel(panel)
  }

  const toggleChatView = () => {
    openChatView()
  }

  const toggleTerminalFromStrip = () => {
    openTerminalPanel()
    setNavigation("open", false)
  }

  const openWorkspaceIn = (app: OpenApp) => {
    setNavigation("open", false)
    openDir(app)
  }

  const copyProjectPath = () => {
    setNavigation("open", false)
    copyPath()
  }

  const openSearch = () => {
    command.trigger("file.open")
    setNavigation("open", false)
  }

  const toggleTerminalFromMenu = () => {
    toggleTerminal()
    setNavigation("open", false)
  }

  const toggleReviewPanel = () => {
    view().reviewPanel.toggle()
    setNavigation("open", false)
  }

  const toggleFileTreePanel = () => {
    layout.fileTree.toggle()
    setNavigation("open", false)
  }

  const toggleProjectSidebar = () => {
    layout.sidebar.toggle()
    setNavigation("open", false)
  }

  const canOpen = createMemo(() => platform.platform === "desktop" && !!platform.openPath && server.isLocal())
  const current = createMemo(
    () =>
      options().find((o) => o.id === prefs.app) ??
      options()[0] ??
      ({ id: "finder", label: fileManager().label, icon: fileManager().icon } as const),
  )
  const opening = createMemo(() => openRequest.app !== undefined)

  const selectApp = (app: OpenApp) => {
    if (!options().some((item) => item.id === app)) return
    setPrefs("app", app)
  }

  const openDir = (app: OpenApp) => {
    if (opening() || !canOpen() || !platform.openPath) return
    const directory = projectDirectory()
    if (!directory) return

    const item = options().find((o) => o.id === app)
    const openWith = item && "openWith" in item ? item.openWith : undefined
    setOpenRequest("app", app)
    platform
      .openPath(directory, openWith)
      .catch((err: unknown) => showRequestError(language, err))
      .finally(() => {
        setOpenRequest("app", undefined)
      })
  }

  const copyPath = () => {
    const directory = projectDirectory()
    if (!directory) return
    navigator.clipboard
      .writeText(directory)
      .then(() => {
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("session.share.copy.copied"),
          description: directory,
        })
      })
      .catch((err: unknown) => showRequestError(language, err))
  }

  const [centerMount, setCenterMount] = createSignal<HTMLElement | null>(null)
  const [stripMount, setStripMount] = createSignal<HTMLElement | null>(null)
  const [stripMobileMount, setStripMobileMount] = createSignal<HTMLElement | null>(null)
  const [rightMount, setRightMount] = createSignal<HTMLElement | null>(null)
  onMount(() => {
    const syncMounts = () => {
      setCenterMount(document.getElementById("opencode-titlebar-center"))
      setStripMount(document.getElementById("opencode-session-strip"))
      setStripMobileMount(document.getElementById("opencode-session-strip-mobile"))
      setRightMount(document.getElementById("opencode-titlebar-right"))
    }
    let frame = 0
    const scheduleSync = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        syncMounts()
      })
    }

    syncMounts()
    queueMicrotask(scheduleSync)
    scheduleSync()

    const observer = new MutationObserver(scheduleSync)
    observer.observe(document.body, { childList: true, subtree: true })

    onCleanup(() => {
      observer.disconnect()
      if (frame) cancelAnimationFrame(frame)
    })
  })

  const navBranch = (label: string, icon: IconProps["name"]) => (
    <>
      <div class="flex size-5 shrink-0 items-center justify-center">
        <Icon name={icon} size="small" class="text-icon-weak" />
      </div>
      <span class="grow min-w-0 truncate text-14-regular text-text-base">{label}</span>
      <Icon name="chevron-right" size="small" class="text-icon-weak" />
    </>
  )

  const navLeaf = (label: string, icon: IconProps["name"]) => (
    <>
      <div class="flex size-5 shrink-0 items-center justify-center">
        <Icon name={icon} size="small" class="text-icon-weak" />
      </div>
      <DropdownMenu.ItemLabel>{label}</DropdownMenu.ItemLabel>
    </>
  )

  const activeIconClasses = (active: boolean) => ({
    "bg-surface-raised-base-active": active,
    "[&_[data-slot=icon-svg]]:text-icon-strong": active,
  })
  const stripTooltipPlacement = createMemo(() => (stripMount() ? "right" : "bottom"))

  const activeTab = createMemo(() => tabs().active())
  const chatActive = createMemo(() => !view().reviewPanel.opened() && !layout.fileTree.opened())
  const tasksActive = createMemo(() => view().reviewPanel.opened() && activeTab() === "tasks")
  const statsActive = createMemo(() => view().reviewPanel.opened() && activeTab() === "stats")
  const reviewActive = createMemo(() => view().reviewPanel.opened() && activeTab() === "review")
  const filesActive = createMemo(() => view().reviewPanel.opened() && activeTab() === "files")
  const fileVaultActive = createMemo(
    () => (layout.fileTree.opened() && layout.fileTree.tab() === "all") || filesActive(),
  )
  const notesActive = createMemo(() => view().reviewPanel.opened() && activeTab() === "notes")
  const intelGraphActive = createMemo(() => view().reviewPanel.opened() && activeTab() === "intelgraph")
  const logsActive = createMemo(() => view().reviewPanel.opened() && activeTab() === "logs")
  const terminalActive = createMemo(() => view().terminal.opened())

  const sessionTabActive = {
    chat: chatActive,
    tasks: tasksActive,
    stats: statsActive,
    review: reviewActive,
    files: fileVaultActive,
    notes: notesActive,
    intelgraph: intelGraphActive,
    logs: logsActive,
  } satisfies Record<SessionTabId, () => boolean>

  const sessionNavItems = createMemo<
    {
      id: string
      label: string
      icon: IconProps["name"]
      active: () => boolean
      onClick: () => void
    }[]
  >(() => {
    const items: {
      id: string
      label: string
      icon: IconProps["name"]
      active: () => boolean
      onClick: () => void
    }[] = SESSION_TABS.map((tab) => {
      const onClick = () => {
        switch (tab.action.kind) {
          case "chat":
            toggleChatView()
            return
          case "panel":
            toggleSurfacePanel(tab.action.panel)
            return
        }
      }

      return {
        id: tab.id,
        label: "translate" in tab && tab.translate ? language.t(tab.label) : tab.label,
        icon: tab.icon,
        active: sessionTabActive[tab.id],
        onClick,
      }
    })

    if (!term()) return items

    return [
      ...items,
      {
        id: "terminal",
        label: language.t("terminal.title"),
        icon: "terminal",
        active: terminalActive,
        onClick: toggleTerminalFromStrip,
      },
    ]
  })

  const renderSessionNavItems = (placement: () => "right" | "bottom") => (
    <For each={sessionNavItems()}>
      {(item) => (
        <Tooltip value={item.label} placement={placement()}>
          <IconButton
            icon={item.icon}
            variant="ghost"
            size="large"
            class="titlebar-icon"
            classList={activeIconClasses(item.active())}
            aria-label={item.label}
            aria-current={item.active() ? "page" : undefined}
            onClick={item.onClick}
          />
        </Tooltip>
      )}
    </For>
  )

  const renderNavigationMenu = () => (
    <DropdownMenu
      open={navigation.open}
      onOpenChange={(open) => setNavigation("open", open)}
      placement={stripMount() ? "right-start" : "bottom-end"}
      gutter={8}
    >
      <Tooltip value="More actions" placement={stripTooltipPlacement()}>
        <DropdownMenu.Trigger
          as={IconButton}
          icon="menu"
          variant="ghost"
          size="large"
          class="titlebar-icon"
          aria-label="Open more actions"
          aria-expanded={navigation.open}
        />
      </Tooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content class="min-w-64">
          <DropdownMenu.Item onSelect={openSearch}>
            {navLeaf(language.t("session.header.searchFiles"), "magnifying-glass")}
          </DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger>{navBranch("Layout toggles", "settings-gear")}</DropdownMenu.SubTrigger>
            <DropdownMenu.SubContent class="min-w-52">
              <Show when={term()}>
                <DropdownMenu.Item onSelect={toggleTerminalFromMenu}>
                  {navLeaf(view().terminal.opened() ? "Hide Terminal" : "Show Terminal", "terminal")}
                </DropdownMenu.Item>
              </Show>
              <DropdownMenu.Item onSelect={toggleReviewPanel}>
                {navLeaf(view().reviewPanel.opened() ? "Hide Context Panel" : "Show Context Panel", "layout-right")}
              </DropdownMenu.Item>
              <Show when={tree()}>
                <DropdownMenu.Item onSelect={toggleFileTreePanel}>
                  {navLeaf(layout.fileTree.opened() ? "Hide File Vault" : "Show File Vault", "file-tree")}
                </DropdownMenu.Item>
              </Show>
              <DropdownMenu.Item onSelect={toggleProjectSidebar}>
                {navLeaf(layout.sidebar.opened() ? "Hide Project Sidebar" : "Show Project Sidebar", "sidebar")}
              </DropdownMenu.Item>
            </DropdownMenu.SubContent>
          </DropdownMenu.Sub>
          <DropdownMenu.Item
            onSelect={() => {
              command.trigger("settings.open")
              setNavigation("open", false)
            }}
          >
            {navLeaf(language.t("command.settings.open"), "settings-gear")}
          </DropdownMenu.Item>
          <Show when={projectDirectory()}>
            <DropdownMenu.Sub>
              <DropdownMenu.SubTrigger>{navBranch("Workspace", "folder")}</DropdownMenu.SubTrigger>
              <DropdownMenu.SubContent class="min-w-56">
                <DropdownMenu.Item disabled={opening() || !canOpen()} onSelect={() => openWorkspaceIn(current().id)}>
                  {navLeaf(language.t("session.header.open.ariaLabel", { app: current().label }), "folder")}
                </DropdownMenu.Item>
                <DropdownMenu.Separator />
                <Show when={canOpen()}>
                  <DropdownMenu.Group>
                    <DropdownMenu.GroupLabel class="!px-1 !py-1">
                      {language.t("session.header.openIn")}
                    </DropdownMenu.GroupLabel>
                    <DropdownMenu.RadioGroup
                      class="mt-1"
                      value={current().id}
                      onChange={(value) => {
                        if (!OPEN_APPS.includes(value as OpenApp)) return
                        selectApp(value as OpenApp)
                      }}
                    >
                      <For each={options()}>
                        {(o) => (
                          <DropdownMenu.RadioItem
                            value={o.id}
                            disabled={opening()}
                            onSelect={() => openWorkspaceIn(o.id)}
                          >
                            <div class="flex size-5 shrink-0 items-center justify-center [&_[data-component=app-icon]]:size-5">
                              <AppIcon id={o.icon} />
                            </div>
                            <DropdownMenu.ItemLabel>{o.label}</DropdownMenu.ItemLabel>
                            <DropdownMenu.ItemIndicator>
                              <Icon name="check-small" size="small" class="text-icon-weak" />
                            </DropdownMenu.ItemIndicator>
                          </DropdownMenu.RadioItem>
                        )}
                      </For>
                    </DropdownMenu.RadioGroup>
                  </DropdownMenu.Group>
                  <DropdownMenu.Separator />
                </Show>
                <DropdownMenu.Item onSelect={copyProjectPath}>
                  {navLeaf(language.t("session.header.open.copyPath"), "copy")}
                </DropdownMenu.Item>
              </DropdownMenu.SubContent>
            </DropdownMenu.Sub>
          </Show>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )

  return (
    <>
      <Show when={search() && centerMount()}>
        {(mount) => (
          <Portal mount={mount()}>
            <Button
              type="button"
              variant="ghost"
              size="small"
              class="hidden md:flex w-[240px] max-w-full min-w-0 items-center gap-2 justify-between rounded-md border border-border-weak-base bg-surface-panel shadow-none cursor-default"
              onClick={() => command.trigger("file.open")}
              aria-label={language.t("session.header.searchFiles")}
            >
              <div class="flex min-w-0 flex-1 items-center overflow-visible">
                <span class="flex-1 min-w-0 text-12-regular text-text-weak truncate text-left">
                  {language.t("session.header.search.placeholder", {
                    project: name(),
                  })}
                </span>
              </div>

              <Show when={hotkey()}>
                {(keybind) => (
                  <Keybind class="shrink-0 !border-0 !bg-transparent !shadow-none px-0 text-text-weaker">
                    {keybind()}
                  </Keybind>
                )}
              </Show>
            </Button>
          </Portal>
        )}
      </Show>
      <Show when={params.id ? stripMobileMount() : null}>
        {(mount) => (
          <Portal mount={mount()}>
            <div class="w-full flex flex-col items-center gap-2 shrink-0">{renderSessionNavItems(() => "right")}</div>
          </Portal>
        )}
      </Show>
      <Show when={params.id ? (stripMount() ?? rightMount()) : null}>
        {(mount) => (
          <Portal mount={mount()}>
            <div class="w-full flex flex-col items-center gap-2 shrink-0">
              {renderSessionNavItems(stripTooltipPlacement)}
              {renderNavigationMenu()}
            </div>
          </Portal>
        )}
      </Show>
    </>
  )
}
