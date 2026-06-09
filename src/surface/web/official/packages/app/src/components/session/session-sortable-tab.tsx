import { Icon } from "@opencode-ai/ui/icon"
import { createMemo, Show } from "solid-js"
import type { JSX } from "solid-js"
import { createSortable } from "@thisbeyond/solid-dnd"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { Tabs } from "@opencode-ai/ui/tabs"
import { getFilename } from "@opencode-ai/core/util/path"
import { useFile } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useCommand } from "@/context/command"

function decodeURIComponentSafe(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function chatSessionID(tab: string) {
  const canonical = "chat://session/"
  if (tab.startsWith(canonical)) return decodeURIComponentSafe(tab.slice(canonical.length))
  return decodeURIComponentSafe(tab.slice("chat://".length))
}

function compactChatSessionID(sessionID: string) {
  if (sessionID.length <= 14) return sessionID
  return `${sessionID.slice(0, 6)}…${sessionID.slice(-6)}`
}

export function FileVisual(props: { path: string; active?: boolean; dirty?: boolean }): JSX.Element {
  return (
    <div class="flex items-center gap-x-1.5 min-w-0">
      <Show
        when={!props.active}
        fallback={<FileIcon node={{ path: props.path, type: "file" }} class="size-4 shrink-0" />}
      >
        <span class="relative inline-flex size-4 shrink-0">
          <FileIcon node={{ path: props.path, type: "file" }} class="absolute inset-0 size-4 tab-fileicon-color" />
          <FileIcon node={{ path: props.path, type: "file" }} mono class="absolute inset-0 size-4 tab-fileicon-mono" />
        </span>
      </Show>
      <span class="text-14-medium truncate">{getFilename(props.path)}</span>
      <Show when={props.dirty}>
        <span class="size-1.5 shrink-0 rounded-full bg-warning" aria-label="Unsaved changes" title="Unsaved changes" />
      </Show>
    </div>
  )
}

export function SortableTab(props: {
  tab: string
  onTabClose: (tab: string) => void
  onTabSplit?: (tab: string) => void
  splitIcon?: "chevron-right" | "chevron-left"
}): JSX.Element {
  const file = useFile()
  const language = useLanguage()
  const command = useCommand()
  const sortable = createSortable(props.tab)
  const path = createMemo(() => file.pathFromTab(props.tab))
  const content = createMemo(() => {
    const value = path()
    if (!value) {
      if (props.tab === "review")
        return (
          <div class="flex items-center gap-1.5 px-2 py-1">
            <Icon name="review" class="size-3.5 shrink-0" />
            <span class="text-11-medium">Review</span>
          </div>
        )
      if (props.tab === "notes")
        return (
          <div class="flex items-center gap-1.5 px-2 py-1">
            <Icon name="pencil-line" class="size-3.5 shrink-0" />
            <span class="text-11-medium">Notes</span>
          </div>
        )
      if (props.tab === "intelgraph")
        return (
          <div class="flex items-center gap-1.5 px-2 py-1">
            <Icon name="align-right" class="size-3.5 shrink-0" />
            <span class="text-11-medium">IntelGraph</span>
          </div>
        )
      if (props.tab === "logs")
        return (
          <div class="flex items-center gap-1.5 px-2 py-1">
            <Icon name="console" class="size-3.5 shrink-0" />
            <span class="text-11-medium">Logs</span>
          </div>
        )
      if (props.tab === "tasks")
        return (
          <div class="flex items-center gap-1.5 px-2 py-1">
            <Icon name="checklist" class="size-3.5 shrink-0" />
            <span class="text-11-medium">Tasks</span>
          </div>
        )
      if (props.tab === "stats")
        return (
          <div class="flex items-center gap-1.5 px-2 py-1">
            <Icon name="arrow-up" class="size-3.5 shrink-0" />
            <span class="text-11-medium">Stats</span>
          </div>
        )
      if (props.tab === "agents")
        return (
          <div class="flex items-center gap-1.5 px-2 py-1">
            <Icon name="arrow-up" class="size-3.5 shrink-0" />
            <span class="text-11-medium">Stats</span>
          </div>
        )
      if (props.tab.startsWith("chat://")) {
        const sessionID = chatSessionID(props.tab)
        return (
          <div class="flex items-center gap-1.5 px-2 py-1" title={sessionID}>
            <Icon name="bubble-5" class="size-3.5 shrink-0" />
            <span class="text-11-medium">Chat {compactChatSessionID(sessionID)}</span>
          </div>
        )
      }
      return <span class="text-11-medium px-2 py-1">{props.tab}</span>
    }
    return <FileVisual path={value} dirty={!!file.get(value)?.dirty} />
  })
  return (
    <div use:sortable class="h-full flex items-center" classList={{ "opacity-0": sortable.isActiveDraggable }}>
      <div class="relative">
        <Tabs.Trigger
          value={props.tab}
          closeButton={
            <div class="flex items-center gap-0.5">
              <Show when={props.onTabSplit}>
                <IconButton
                  icon={props.splitIcon === "chevron-left" ? "chevron-left" : "chevron-right"}
                  variant="ghost"
                  class="h-5 w-5 text-text-weak hover:text-text-base"
                  onClick={(e) => {
                    e.stopPropagation()
                    props.onTabSplit!(props.tab)
                  }}
                  aria-label="Split tab"
                />
              </Show>
              <TooltipKeybind
                title={language.t("common.closeTab")}
                keybind={command.keybind("tab.close")}
                placement="bottom"
                gutter={10}
              >
                <IconButton
                  icon="close-small"
                  variant="ghost"
                  class="h-5 w-5"
                  onClick={() => props.onTabClose(props.tab)}
                  aria-label={language.t("common.closeTab")}
                />
              </TooltipKeybind>
            </div>
          }
          hideCloseButton
          onMiddleClick={() => props.onTabClose(props.tab)}
        >
          <Show when={content()}>{(value) => value()}</Show>
        </Tabs.Trigger>
      </div>
    </div>
  )
}
