import { createEffect, createMemo, createSignal, Match, on, onCleanup, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import { makeEventListener } from "@solid-primitives/event-listener"
import type { FileSearchHandle } from "@opencode-ai/ui/file"
import { useFileComponent } from "@opencode-ai/ui/context/file"
import { cloneSelectedLineRange, previewSelectedLines } from "@opencode-ai/ui/pierre/selection-bridge"
import { createLineCommentController } from "@opencode-ai/ui/line-comment-annotations"
import { sampledChecksum } from "@opencode-ai/core/util/encode"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tabs } from "@opencode-ai/ui/tabs"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { showToast } from "@opencode-ai/ui/toast"
import { CodeEditor } from "@/components/editor/code-editor"
import { selectionFromLines, useFile, type FileSelection, type SelectedLineRange } from "@/context/file"
import { useComments } from "@/context/comments"
import { useLanguage } from "@/context/language"
import { usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { getSessionHandoff } from "@/pages/session/handoff"
import { useSessionLayout } from "@/pages/session/session-layout"
import { createSessionTabs } from "@/pages/session/helpers"
import type { SurfaceIntelGraphSearchResult } from "@/surface/ports"
import { diagnosticError, emitDiagnosticLog } from "@/utils/diagnostic-log"
import { relationSymbolNameFromSelection, relationSymbolNameFromSource } from "./file-tabs-intelgraph-relation-symbol"

const FILE_REVEAL_CONTEXT_LINES = 12
const FILE_REVEAL_LINE_HEIGHT_PX = 24

function definitionErrorCode(error: unknown) {
  if (!error || typeof error !== "object") return
  const source = error as {
    code?: unknown
    error?: { code?: unknown }
    data?: { error?: { code?: unknown } }
    body?: { error?: { code?: unknown } }
  }
  const code = source.code ?? source.error?.code ?? source.data?.error?.code ?? source.body?.error?.code
  return typeof code === "string" ? code : undefined
}

function definitionErrorDetails(error: unknown) {
  if (!error || typeof error !== "object") return
  const source = error as {
    error?: { details?: unknown }
    data?: { error?: { details?: unknown } }
    body?: { error?: { details?: unknown } }
  }
  const details = source.error?.details ?? source.data?.error?.details ?? source.body?.error?.details
  if (!details || typeof details !== "object") return
  return details as { language?: unknown; path?: unknown }
}

function definitionAutoEditEnabled() {
  if (typeof window === "undefined") return true
  try {
    return window.localStorage?.getItem("opencode:file-definition-auto-edit") !== "0"
  } catch {
    return true
  }
}

function FileCommentMenu(props: {
  moreLabel: string
  editLabel: string
  deleteLabel: string
  onEdit: VoidFunction
  onDelete: VoidFunction
}) {
  return (
    <div onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
      <DropdownMenu gutter={4} placement="bottom-end">
        <DropdownMenu.Trigger
          as={IconButton}
          icon="dot-grid"
          variant="ghost"
          size="small"
          class="size-6 rounded-md"
          aria-label={props.moreLabel}
        />
        <DropdownMenu.Portal>
          <DropdownMenu.Content>
            <DropdownMenu.Item onSelect={props.onEdit}>
              <DropdownMenu.ItemLabel>{props.editLabel}</DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
            <DropdownMenu.Item onSelect={props.onDelete}>
              <DropdownMenu.ItemLabel>{props.deleteLabel}</DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu>
    </div>
  )
}

type ScrollPos = { x: number; y: number }

function createScrollSync(input: { tab: () => string; view: ReturnType<typeof useSessionLayout>["view"] }) {
  let scroll: HTMLDivElement | undefined
  let scrollFrame: number | undefined
  let restoreFrame: number | undefined
  let revealFrame: number | undefined
  let pending: ScrollPos | undefined
  let pendingRevealLine: number | undefined
  const [code, setCode] = createSignal<HTMLElement[]>([])

  const getCode = () => {
    const el = scroll
    if (!el) return []

    const host = el.querySelector("diffs-container")
    if (!(host instanceof HTMLElement)) return []

    const root = host.shadowRoot
    if (!root) return []

    return Array.from(root.querySelectorAll("[data-code]")).filter(
      (node): node is HTMLElement => node instanceof HTMLElement && node.clientWidth > 0,
    )
  }

  const save = (next: ScrollPos) => {
    pending = next
    if (scrollFrame !== undefined) return

    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = undefined

      const out = pending
      pending = undefined
      if (!out) return

      input.view().setScroll(input.tab(), out)
    })
  }

  const onCodeScroll = (event: Event) => {
    const el = scroll
    if (!el) return

    const target = event.currentTarget
    if (!(target instanceof HTMLElement)) return

    save({
      x: target.scrollLeft,
      y: el.scrollTop,
    })
  }

  const sync = () => {
    const next = getCode()
    const current = code()
    if (next.length === current.length && next.every((el, i) => el === current[i])) return
    setCode(next)
  }

  const restore = () => {
    const el = scroll
    if (!el) return

    const pos = input.view().scroll(input.tab())
    if (!pos) return

    sync()

    if (code().length > 0) {
      for (const item of code()) {
        if (item.scrollLeft !== pos.x) item.scrollLeft = pos.x
      }
    }

    if (el.scrollTop !== pos.y) el.scrollTop = pos.y
    if (code().length > 0) return
    if (el.scrollLeft !== pos.x) el.scrollLeft = pos.x
  }

  const revealLine = (line: number) => {
    const el = scroll
    if (!el || !Number.isFinite(line) || line < 1) return false
    sync()

    const host = el.querySelector("diffs-container")
    if (!(host instanceof HTMLElement)) return false
    const root = host.shadowRoot
    if (!root) return false
    const target = root.querySelector(`[data-line="${Math.trunc(line)}"]`)
    if (!(target instanceof HTMLElement)) return false

    const targetRect = target.getBoundingClientRect()
    const viewportRect = el.getBoundingClientRect()
    const contextPx = FILE_REVEAL_CONTEXT_LINES * FILE_REVEAL_LINE_HEIGHT_PX
    const nextTop = Math.max(0, Math.round(el.scrollTop + targetRect.top - viewportRect.top - contextPx))
    if (el.scrollTop !== nextTop) el.scrollTop = nextTop
    save({ x: code()[0]?.scrollLeft ?? el.scrollLeft, y: el.scrollTop })
    return true
  }

  const queueRestore = () => {
    if (restoreFrame !== undefined) return

    restoreFrame = requestAnimationFrame(() => {
      restoreFrame = undefined
      restore()
    })
  }

  const queueRevealLine = (line: number, attempt = 0) => {
    pendingRevealLine = Math.trunc(line)
    if (revealFrame !== undefined) return

    revealFrame = requestAnimationFrame(() => {
      revealFrame = undefined
      const target = pendingRevealLine
      if (!target) return
      restore()
      const revealed = revealLine(target)
      if (!revealed && attempt < 4) queueRevealLine(target, attempt + 1)
    })
  }

  const handleScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    if (code().length === 0) sync()

    save({
      x: code()[0]?.scrollLeft ?? event.currentTarget.scrollLeft,
      y: event.currentTarget.scrollTop,
    })
  }

  createEffect(() => {
    for (const item of code()) makeEventListener(item, "scroll", onCodeScroll)
  })

  const setViewport = (el: HTMLDivElement) => {
    scroll = el
    restore()
  }

  onCleanup(() => {
    if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame)
    if (restoreFrame !== undefined) cancelAnimationFrame(restoreFrame)
    if (revealFrame !== undefined) cancelAnimationFrame(revealFrame)
  })

  return {
    handleScroll,
    queueRestore,
    queueRevealLine,
    setViewport,
  }
}

export function FileTabContent(props: { tab: string }) {
  const file = useFile()
  const comments = useComments()
  const language = useLanguage()
  const prompt = usePrompt()
  const sdk = useSDK()
  const fileComponent = useFileComponent()
  const { sessionKey, tabs, view, handoff } = useSessionLayout()
  const activeFileTab = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab: (tab) => (tab.startsWith("file://") ? file.tab(tab) : tab),
  }).activeFileTab

  let find: FileSearchHandle | null = null
  let fileContextRoot: HTMLDivElement | undefined

  const search = {
    register: (handle: FileSearchHandle | null) => {
      find = handle
    },
  }

  const path = createMemo(() => file.pathFromTab(props.tab))
  const state = createMemo(() => {
    const p = path()
    if (!p) return
    return file.get(p)
  })
  const contents = createMemo(() => state()?.editBuffer ?? state()?.content?.content ?? "")
  const cacheKey = createMemo(() => sampledChecksum(contents()))
  const canEdit = createMemo(() => state()?.content?.type === "text" && state()?.content?.encoding !== "base64")
  const selectedLines = createMemo<SelectedLineRange | null>(() => {
    const p = path()
    if (!p) return null
    if (file.ready()) return (file.selectedLines(p) as SelectedLineRange | undefined) ?? null
    return (getSessionHandoff(sessionKey())?.files[p] as SelectedLineRange | undefined) ?? null
  })
  const selectedCharacter = createMemo<number | null>(() => {
    const p = path()
    if (!p || !file.ready()) return null
    const value = file.selectedCharacter(p) as number | null | undefined
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null
  })
  const scrollSync = createScrollSync({
    tab: () => props.tab,
    view,
  })
  const [cursorLine, setCursorLine] = createSignal<number | null>(null)
  const [cursorCharacter, setCursorCharacter] = createSignal<number | null>(null)
  const [selectedRelationText, setSelectedRelationText] = createSignal("")
  const [editing, setEditing] = createSignal(false)
  const [autoEditForDefinition, setAutoEditForDefinition] = createSignal(definitionAutoEditEnabled())

  const toggleAutoEditForDefinition = () => {
    const next = !autoEditForDefinition()
    setAutoEditForDefinition(next)
    if (typeof window !== "undefined") {
      try {
        window.localStorage?.setItem("opencode:file-definition-auto-edit", next ? "1" : "0")
      } catch {
        // ignore localStorage persistence failures
      }
    }
    logFileEditorEvent("definition.lookup.auto_edit_mode.preference", "info", { enabled: next })
  }

  const relationLocationSymbolId = (filePath: string, lineNumber: number) => `location@${filePath}:${lineNumber}`

  const relationSymbolMatchesFallback = (
    symbol: SurfaceIntelGraphSearchResult | undefined,
    fallbackName: string | undefined,
  ) => {
    if (!symbol || !fallbackName) return true
    const idName = symbol.id.split("@")[0]?.split("#").pop()
    return symbol.label === fallbackName || idName === fallbackName || symbol.id === fallbackName
  }

  createEffect(() => {
    const selection = selectedLines()
    if (!selection) return
    if (activeFileTab() !== props.tab) return
    scrollSync.queueRestore()
    scrollSync.queueRevealLine(Math.min(selection.start, selection.end))
  })

  createEffect(() => {
    const selection = selectedLines()
    const character = selectedCharacter()
    const sourcePath = path()
    if (character === null || !selection || !sourcePath) return
    if (selection.start !== selection.end) return
    if (activeFileTab() !== props.tab) return
    if (!canEdit() || editing()) return
    if (!autoEditForDefinition()) {
      logFileEditorEvent("definition.lookup.auto_edit_mode.skipped", "info", {
        filePath: sourcePath,
        lineNumber: selection.start,
        characterNumber: character,
      })
      return
    }
    logFileEditorEvent("definition.lookup.auto_edit_mode", "info", {
      filePath: sourcePath,
      lineNumber: selection.start,
      characterNumber: character,
    })
    setEditing(true)
  })

  const openIntelGraphRelationsPane = () => {
    tabs().openInB("intelgraph")
  }

  const generateSymbolRelationships = (
    symbol: SurfaceIntelGraphSearchResult | undefined,
    location?: { filePath?: string; lineNumber?: number; characterNumber?: number },
  ) => {
    const filePath = symbol?.file_path ?? location?.filePath ?? path() ?? undefined
    const lineNumber = symbol?.line ?? location?.lineNumber
    const characterNumber = location?.characterNumber
    const symbolId = symbol?.id ?? (filePath && lineNumber ? relationLocationSymbolId(filePath, lineNumber) : undefined)
    logFileRelationEvent("relation.handoff.prepare", "info", {
      symbolId,
      symbolLabel: symbol?.label,
      filePath,
      lineNumber,
      characterNumber,
      usedLocationFallback: !symbol?.id,
    })
    if (!symbolId) return
    handoff.setIntelGraphFocus({
      symbolId,
      symbolName: symbol?.label ?? (filePath && lineNumber ? `${filePath}:${lineNumber}` : undefined),
      filePath,
      lineNumber,
      characterNumber,
      symbolKind: symbol?.kind,
      query: symbol?.label ?? (filePath && lineNumber ? `${filePath}:${lineNumber}` : filePath),
      action: "relationships",
    })
    logFileRelationEvent("relation.handoff.commit", "info", { symbolId, filePath, lineNumber, characterNumber })
    openIntelGraphRelationsPane()
  }

  const saveFile = () => {
    const p = path()
    if (!p || state()?.saving) return
    void file.save(p).catch(() => undefined)
  }

  const selectionPreview = (source: string, selection: FileSelection) => {
    return previewSelectedLines(source, {
      start: selection.startLine,
      end: selection.endLine,
    })
  }

  const buildPreview = (filePath: string, selection: FileSelection) => {
    const source = filePath === path() ? contents() : file.get(filePath)?.content?.content
    if (!source) return undefined
    return selectionPreview(source, selection)
  }

  const addCommentToContext = (input: {
    file: string
    selection: SelectedLineRange
    comment: string
    preview?: string
    origin?: "review" | "file"
  }) => {
    const selection = selectionFromLines(input.selection)
    const preview = input.preview ?? buildPreview(input.file, selection)

    const saved = comments.add({
      file: input.file,
      selection: input.selection,
      comment: input.comment,
    })
    prompt.context.add({
      type: "file",
      path: input.file,
      selection,
      comment: input.comment,
      commentID: saved.id,
      commentOrigin: input.origin,
      preview,
    })
  }

  const updateCommentInContext = (input: {
    id: string
    file: string
    selection: SelectedLineRange
    comment: string
  }) => {
    comments.update(input.file, input.id, input.comment)
    const preview = input.file === path() ? buildPreview(input.file, selectionFromLines(input.selection)) : undefined
    prompt.context.updateComment(input.file, input.id, {
      comment: input.comment,
      ...(preview ? { preview } : {}),
    })
  }

  const removeCommentFromContext = (input: { id: string; file: string }) => {
    comments.remove(input.file, input.id)
    prompt.context.removeComment(input.file, input.id)
  }

  const fileComments = createMemo(() => {
    const p = path()
    if (!p) return []
    return comments.list(p)
  })

  const commentedLines = createMemo(() => fileComments().map((comment) => comment.selection))

  const [note, setNote] = createStore({
    openedComment: null as string | null,
    commenting: null as SelectedLineRange | null,
    selected: null as SelectedLineRange | null,
  })

  const syncSelected = (range: SelectedLineRange | null) => {
    const p = path()
    if (!p) return
    file.setSelectedLines(p, range ? cloneSelectedLineRange(range) : null)
    if (!range || range.start !== range.end) file.setSelectedCharacter(p, null)
  }

  const activeSelection = () => note.selected ?? selectedLines()

  const logFileEditorEvent = (
    message: string,
    level: "debug" | "info" | "warn" | "error" = "info",
    extra: Record<string, unknown> = {},
  ) => {
    emitDiagnosticLog({
      service: "web.editor.file-tabs",
      level,
      message,
      extra: {
        fileTab: props.tab,
        activeFile: path() ?? undefined,
        cursorLine: cursorLine() ?? undefined,
        selectedLine: activeSelection()?.start ?? undefined,
        ...extra,
      },
    })
  }

  const logFileRelationEvent = (
    message: string,
    level: "debug" | "info" | "warn" | "error" = "info",
    extra: Record<string, unknown> = {},
  ) => {
    emitDiagnosticLog({
      service: "web.intelgraph",
      level,
      message,
      extra: {
        fileTab: props.tab,
        activeFile: path() ?? undefined,
        cursorLine: cursorLine() ?? undefined,
        selectedLine: activeSelection()?.start ?? undefined,
        ...extra,
      },
    })
  }

  const contextLineFromEvent = (event: MouseEvent) => {
    const fromPath = event
      .composedPath()
      .find((item): item is HTMLElement => item instanceof HTMLElement && item.dataset.line !== undefined)
    const raw = fromPath?.dataset.line
    const line = raw ? Number(raw) : undefined
    if (line && Number.isFinite(line) && line > 0) return Math.trunc(line)
    return cursorLine() ?? activeSelection()?.start
  }

  const contextCharacterFromEvent = (event: MouseEvent, lineNumber?: number) => {
    if (typeof document === "undefined") return undefined
    const roots = event
      .composedPath()
      .flatMap((item) => (item instanceof HTMLElement && item.shadowRoot ? [item.shadowRoot] : []))
    const caret = (
      document as unknown as {
        caretPositionFromPoint?: (
          x: number,
          y: number,
          opts?: { shadowRoots?: ShadowRoot[] },
        ) => {
          offsetNode: Node
          offset: number
        } | null
        caretRangeFromPoint?: (x: number, y: number) => Range | null
      }
    ).caretPositionFromPoint?.(event.clientX, event.clientY, { shadowRoots: roots })
    const fallbackRange = (
      document as unknown as {
        caretRangeFromPoint?: (x: number, y: number) => Range | null
      }
    ).caretRangeFromPoint?.(event.clientX, event.clientY)
    const node = caret?.offsetNode ?? fallbackRange?.startContainer
    const offset = caret?.offset ?? fallbackRange?.startOffset
    if (!node || offset === undefined) return undefined

    const element = node instanceof HTMLElement ? node : node.parentElement
    const lineElement = element?.closest(lineNumber ? `[data-line="${lineNumber}"]` : "[data-line]")
    if (!(lineElement instanceof HTMLElement)) return undefined

    try {
      const range = document.createRange()
      range.setStart(lineElement, 0)
      range.setEnd(node, offset)
      return Math.max(0, range.toString().length)
    } catch {
      return undefined
    }
  }

  const resolveSelectionSymbol = async (
    line = cursorLine() ?? activeSelection()?.start,
  ): Promise<SurfaceIntelGraphSearchResult | undefined> => {
    const p = path()
    if (!p) return undefined
    const fallback = relationSymbolNameFromSource(contents(), line)
    if (!fallback) return undefined
    return {
      id: fallback.name,
      label: fallback.name,
      kind: "symbol",
      file_path: p,
      line: fallback.line,
      tags: [],
      score: 0.6,
    }
  }

  const selectedRelationSymbol = () => relationSymbolNameFromSelection(selectedRelationText())

  const moveToDefinition = async (input: { filePath?: string; lineNumber?: number; characterNumber?: number }) => {
    const sourcePath = input.filePath ?? path()
    const lineNumber = input.lineNumber ?? cursorLine() ?? activeSelection()?.start
    const characterNumber = input.characterNumber ?? cursorCharacter() ?? 0
    if (sourcePath && sourcePath === path() && state()?.dirty) {
      logFileEditorEvent("definition.lookup.autosave.start", "info", { filePath: sourcePath })
      try {
        await file.save(sourcePath)
        logFileEditorEvent("definition.lookup.autosave.success", "info", { filePath: sourcePath })
      } catch (error) {
        logFileEditorEvent("definition.lookup.autosave.error", "error", {
          filePath: sourcePath,
          error: diagnosticError(error),
        })
        showToast({
          variant: "error",
          title: "Save required before definition lookup",
          description: error instanceof Error ? error.message : String(error),
        })
        return
      }
    }
    if (!sourcePath || !lineNumber) {
      logFileEditorEvent("definition.lookup.missing_source", "warn", {
        filePath: sourcePath,
        lineNumber,
        characterNumber,
      })
      showToast({
        variant: "error",
        title: "No source location",
        description: "Place the cursor on a symbol or right-click a code line.",
      })
      return
    }
    logFileEditorEvent("definition.lookup.start", "info", { filePath: sourcePath, lineNumber, characterNumber })
    try {
      const result = await sdk.client.file.definition({
        path: sourcePath,
        line: lineNumber,
        character: characterNumber,
      })
      const locations = result.data ?? []
      const location = locations[0]
      if (!location) {
        logFileEditorEvent("definition.lookup.empty", "warn", { filePath: sourcePath, lineNumber, characterNumber })
        showToast({
          variant: "error",
          title: "No definition found",
          description: "No LSP definition was available for this location.",
        })
        return
      }
      logFileEditorEvent("definition.lookup.success", "info", {
        filePath: sourcePath,
        lineNumber,
        characterNumber,
        resultCount: locations.length,
        targetPath: location.path,
        targetLine: location.line,
        targetCharacter: location.character,
      })
      file.setSelectedCharacter(location.path, location.character)
      file.setSelectedLines(location.path, { start: location.line, end: location.line })
      await file.load(location.path)
      const tab = file.tab(location.path)
      void tabs().open(tab)
      tabs().setActive(tab)
      closeSymbolMenu()
    } catch (error) {
      const code = definitionErrorCode(error)
      if (code === "lsp_unavailable") {
        const details = definitionErrorDetails(error)
        const language = typeof details?.language === "string" ? details.language : undefined
        logFileEditorEvent("definition.lookup.unavailable", "warn", {
          error: diagnosticError(error),
          filePath: sourcePath,
          lineNumber,
          characterNumber,
          language,
        })
        showToast({
          variant: "error",
          title: "Language server unavailable",
          description: language
            ? `No ${language} language server is available for this workspace. ${error instanceof Error ? error.message : String(error)}`
            : error instanceof Error
              ? error.message
              : String(error),
        })
        return
      }
      logFileEditorEvent("definition.lookup.error", "error", {
        error: diagnosticError(error),
        filePath: sourcePath,
        lineNumber,
        characterNumber,
      })
      showToast({
        variant: "error",
        title: "Definition lookup failed",
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const showRelationForSelection = async () => {
    const p = path()
    const line = cursorLine() ?? activeSelection()?.start
    if (typeof window !== "undefined") setSelectedRelationText(window.getSelection()?.toString() ?? "")
    const selectedSymbol = selectedRelationSymbol()
    const fallbackFromLine = relationSymbolNameFromSource(contents(), line)
    const fallback = selectedSymbol
      ? {
          ...selectedSymbol,
          line: selectedSymbol.line || fallbackFromLine?.line || line || 0,
          column: fallbackFromLine?.name === selectedSymbol.name ? fallbackFromLine.column : selectedSymbol.column,
        }
      : fallbackFromLine
    logFileRelationEvent("relation.show_relation.click", "info", {
      filePath: p,
      lineNumber: line,
      fallbackSymbolName: fallback?.name,
      fallbackSymbolLine: fallback?.line,
    })
    try {
      const symbol = await resolveSelectionSymbol(line)
      if (symbol && (!fallback || relationSymbolMatchesFallback(symbol, fallback.name))) {
        logFileRelationEvent("relation.show_relation.symbol_resolved", "info", {
          symbolId: symbol.id,
          symbolLabel: symbol.label,
          symbolLine: symbol.line,
        })
        generateSymbolRelationships(symbol, {
          filePath: p ?? undefined,
          lineNumber: line ?? undefined,
          characterNumber: fallback?.column,
        })
        return
      }
      if (symbol && fallback && !relationSymbolMatchesFallback(symbol, fallback.name)) {
        logFileRelationEvent("relation.show_relation.symbol_mismatch", "warn", {
          resolvedSymbolId: symbol.id,
          resolvedSymbolLabel: symbol.label,
          fallbackSymbolName: fallback.name,
          fallbackLineNumber: fallback.line,
        })
      }
      if (fallback && p) {
        logFileRelationEvent("relation.show_relation.fallback_symbol", "warn", {
          symbolName: fallback.name,
          symbolLine: fallback.line,
          filePath: p,
        })
        generateSymbolRelationships(
          {
            id: fallback.name,
            label: fallback.name,
            kind: "symbol",
            file_path: p,
            line: fallback.line,
            tags: [],
            score: 0.6,
          },
          { filePath: p, lineNumber: fallback.line, characterNumber: fallback.column },
        )
        return
      }
      if (p && line) {
        logFileRelationEvent("relation.show_relation.location_fallback", "warn", { filePath: p, lineNumber: line })
        generateSymbolRelationships(undefined, { filePath: p, lineNumber: line })
        return
      }
    } catch (error) {
      logFileRelationEvent("relation.show_relation.error", "error", { error: diagnosticError(error) })
    }
    showToast({
      variant: "error",
      title: "No current location for relationship lookup",
      description: "Place cursor on an API line and click Show relation.",
    })
  }

  const [symbolMenu, setSymbolMenu] = createSignal<{
    symbol?: SurfaceIntelGraphSearchResult
    fallbackSymbolName?: string
    filePath?: string
    lineNumber?: number
    characterNumber?: number
    x: number
    y: number
  } | null>(null)
  const closeSymbolMenu = () => setSymbolMenu(null)
  const openSelectionMenu = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    const filePath = path() ?? undefined
    const lineNumber = contextLineFromEvent(event)
    const selectedText = typeof window === "undefined" ? "" : (window.getSelection()?.toString() ?? "")
    setSelectedRelationText(selectedText)
    const selectedSymbol = relationSymbolNameFromSelection(selectedText)
    const fallbackFromLine = relationSymbolNameFromSource(contents(), lineNumber)
    const fallback = selectedSymbol
      ? {
          ...selectedSymbol,
          line: selectedSymbol.line || fallbackFromLine?.line || lineNumber,
          column: fallbackFromLine?.name === selectedSymbol.name ? fallbackFromLine.column : selectedSymbol.column,
        }
      : fallbackFromLine
    const fallbackSymbolName = fallback?.name
    const fallbackLineNumber = fallback?.line ?? lineNumber
    const clickedCharacterNumber = contextCharacterFromEvent(event, lineNumber)
    const fallbackCharacterNumber =
      clickedCharacterNumber ?? (fallback?.column ? Math.max(0, fallback.column - 1) : (cursorCharacter() ?? undefined))
    const x = event.clientX
    const y = event.clientY
    logFileRelationEvent("relation.context_menu.open", "info", {
      filePath,
      clickedLine: lineNumber,
      fallbackSymbolName,
      fallbackLineNumber,
      fallbackCharacterNumber,
    })
    setSymbolMenu({
      filePath,
      lineNumber: fallbackLineNumber,
      characterNumber: fallbackCharacterNumber,
      fallbackSymbolName,
      x,
      y,
    })
    void resolveSelectionSymbol(fallbackLineNumber)
      .then((symbol) => {
        const current = symbolMenu()
        if (!current || current.x !== x || current.y !== y) return
        logFileRelationEvent(
          symbol ? "relation.context_menu.symbol_resolved" : "relation.context_menu.symbol_missing",
          symbol ? "info" : "warn",
          {
            filePath,
            clickedLine: lineNumber,
            fallbackLineNumber,
            symbolId: symbol?.id,
            symbolLabel: symbol?.label,
            symbolLine: symbol?.line,
          },
        )
        setSymbolMenu({
          ...current,
          symbol: relationSymbolMatchesFallback(symbol, current.fallbackSymbolName) ? symbol : undefined,
        })
      })
      .catch((error) => {
        logFileRelationEvent("relation.context_menu.symbol_error", "error", {
          filePath,
          clickedLine: lineNumber,
          fallbackLineNumber,
          error: diagnosticError(error),
        })
      })
  }

  createEffect(() => {
    if (typeof document === "undefined") return
    const onContextMenu = (event: MouseEvent) => {
      if (activeFileTab() !== props.tab) return
      const eventPath = event.composedPath()
      const root = fileContextRoot
      if (!root || !eventPath.includes(root)) return
      const fromCodeEditor = eventPath.some(
        (item): item is HTMLElement => item instanceof HTMLElement && item.dataset.component === "code-editor",
      )
      if (fromCodeEditor) return
      openSelectionMenu(event)
    }
    makeEventListener(document, "contextmenu", onContextMenu, { capture: true })
  })

  const commentsUi = createLineCommentController({
    comments: fileComments,
    label: language.t("ui.lineComment.submit"),
    draftKey: () => path() ?? props.tab,
    mention: {
      items: file.searchFilesAndDirectories,
    },
    state: {
      opened: () => note.openedComment,
      setOpened: (id) => setNote("openedComment", id),
      selected: () => note.selected,
      setSelected: (range) => setNote("selected", range),
      commenting: () => note.commenting,
      setCommenting: (range) => setNote("commenting", range),
      syncSelected,
      hoverSelected: syncSelected,
    },
    getHoverSelectedRange: activeSelection,
    cancelDraftOnCommentToggle: true,
    clearSelectionOnSelectionEndNull: true,
    onSubmit: ({ comment, selection }) => {
      const p = path()
      if (!p) return
      addCommentToContext({ file: p, selection, comment, origin: "file" })
    },
    onUpdate: ({ id, comment, selection }) => {
      const p = path()
      if (!p) return
      updateCommentInContext({ id, file: p, selection, comment })
    },
    onDelete: (comment) => {
      const p = path()
      if (!p) return
      removeCommentFromContext({ id: comment.id, file: p })
    },
    editSubmitLabel: language.t("common.save"),
    renderCommentActions: (_, controls) => (
      <FileCommentMenu
        moreLabel={language.t("common.moreOptions")}
        editLabel={language.t("common.edit")}
        deleteLabel={language.t("common.delete")}
        onEdit={controls.edit}
        onDelete={controls.remove}
      />
    ),
  })

  createEffect(() => {
    if (typeof window === "undefined") return

    const onKeyDown = (event: KeyboardEvent) => {
      if (activeFileTab() !== props.tab) return
      const root = fileContextRoot
      const fromTab = !!root && event.composedPath().includes(root)
      if (!fromTab) return
      if (event.key === "F12") {
        event.preventDefault()
        event.stopPropagation()
        const lineNumber = cursorLine() ?? activeSelection()?.start ?? undefined
        const characterNumber = cursorCharacter() ?? undefined
        if (event.shiftKey) {
          void showRelationForSelection()
          return
        }
        void moveToDefinition({
          filePath: path() ?? undefined,
          lineNumber,
          characterNumber,
        })
        return
      }
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
      const key = event.key.toLowerCase()
      if (key === "s") {
        event.preventDefault()
        event.stopPropagation()
        saveFile()
        return
      }
      if (key !== "f") return

      event.preventDefault()
      event.stopPropagation()
      find?.focus()
    }

    makeEventListener(window, "keydown", onKeyDown, { capture: true })
  })

  createEffect(
    on(
      path,
      () => {
        commentsUi.note.reset()
      },
      { defer: true },
    ),
  )

  createEffect(() => {
    const focus = comments.focus()
    const p = path()
    if (!focus || !p) return
    if (focus.file !== p) return
    if (activeFileTab() !== props.tab) return

    const target = fileComments().find((comment) => comment.id === focus.id)
    if (!target) return

    commentsUi.note.openComment(target.id, target.selection, { cancelDraft: true })
    requestAnimationFrame(() => comments.clearFocus())
  })

  let prev = {
    loaded: false,
    ready: false,
    active: false,
  }

  createEffect(() => {
    const loaded = !!state()?.loaded
    const ready = file.ready()
    const active = activeFileTab() === props.tab
    const restore = (loaded && !prev.loaded) || (ready && !prev.ready) || (active && loaded && !prev.active)
    prev = { loaded, ready, active }
    if (!restore) return
    scrollSync.queueRestore()
  })

  const renderViewer = (source: string) => (
    <Dynamic
      component={fileComponent}
      mode="text"
      file={{
        name: path() ?? "",
        contents: source,
        cacheKey: cacheKey(),
      }}
      enableLineSelection
      enableHoverUtility
      selectedLines={activeSelection()}
      commentedLines={commentedLines()}
      onRendered={() => {
        scrollSync.queueRestore()
        const selection = selectedLines()
        if (selection) scrollSync.queueRevealLine(Math.min(selection.start, selection.end))
      }}
      annotations={commentsUi.annotations()}
      renderAnnotation={commentsUi.renderAnnotation}
      renderHoverUtility={commentsUi.renderHoverUtility}
      onLineSelected={(range: SelectedLineRange | null) => {
        commentsUi.onLineSelected(range)
      }}
      onLineNumberSelectionEnd={commentsUi.onLineNumberSelectionEnd}
      onLineSelectionEnd={(range: SelectedLineRange | null) => {
        commentsUi.onLineSelectionEnd(range)
      }}
      search={search}
      class="select-text"
      media={{
        mode: "auto",
        path: path(),
        current: state()?.content,
        onLoad: scrollSync.queueRestore,
        onError: (args: { kind: "image" | "audio" | "svg" }) => {
          if (args.kind !== "svg") return
          showToast({
            variant: "error",
            title: language.t("toast.file.loadFailed.title"),
          })
        },
      }}
    />
  )

  const renderFile = (source: string) => (
    <div
      ref={(el) => (fileContextRoot = el)}
      class="relative overflow-hidden pb-6"
      onClick={closeSymbolMenu}
      onContextMenu={openSelectionMenu}
    >
      <Show when={symbolMenu()} keyed>
        {(menu) => (
          <div
            role="menu"
            aria-label="File symbol actions"
            class="fixed z-50 w-52 rounded-lg border border-border-weaker-base bg-surface-base p-1 text-12-regular shadow-lg"
            style={{ left: `${menu.x}px`, top: `${menu.y}px` }}
            onClick={(event) => event.stopPropagation()}
          >
            <div class="truncate px-2 py-1 text-11-mono text-text-weak">
              {menu.symbol?.label ??
                menu.fallbackSymbolName ??
                (menu.filePath && menu.lineNumber ? `${menu.filePath}:${menu.lineNumber}` : "Selected line")}
            </div>
            <button
              type="button"
              role="menuitem"
              disabled={!menu.filePath || !menu.lineNumber}
              aria-label="Move to definition for context symbol"
              class="w-full rounded px-2 py-1 text-left hover:bg-surface-raised-base-hover disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => {
                void moveToDefinition(menu)
              }}
            >
              Move to definition
            </button>
            <button
              type="button"
              role="menuitem"
              aria-label="Show relation for context symbol"
              class="w-full rounded px-2 py-1 text-left hover:bg-surface-raised-base-hover"
              onClick={() => {
                if (menu.symbol)
                  generateSymbolRelationships(menu.symbol, {
                    filePath: menu.filePath,
                    lineNumber: menu.lineNumber,
                    characterNumber: menu.characterNumber,
                  })
                else if (menu.fallbackSymbolName && menu.filePath && menu.lineNumber)
                  generateSymbolRelationships(
                    {
                      id: menu.fallbackSymbolName,
                      label: menu.fallbackSymbolName,
                      kind: "symbol",
                      file_path: menu.filePath,
                      line: menu.lineNumber,
                      tags: [],
                      score: 0.6,
                    },
                    { filePath: menu.filePath, lineNumber: menu.lineNumber, characterNumber: menu.characterNumber },
                  )
                else if (menu.filePath && menu.lineNumber)
                  generateSymbolRelationships(undefined, { filePath: menu.filePath, lineNumber: menu.lineNumber })
                else void showRelationForSelection()
                closeSymbolMenu()
              }}
            >
              Show relation
            </button>
          </div>
        )}
      </Show>
      <Show when={canEdit()} fallback={renderViewer(source)}>
        <div class="flex items-center justify-between gap-2 border-b border-border-weaker-base bg-surface-base px-3 py-2">
          <div class="min-w-0 text-12-regular text-text-weak" role="status" aria-live="polite">
            <Show
              when={state()?.saveError}
              fallback={
                state()?.saving
                  ? "Saving..."
                  : state()?.dirty
                    ? "Unsaved changes"
                    : editing()
                      ? "Editing"
                      : "Highlighted view"
              }
            >
              {(err) => <span class="text-danger">{err()}</span>}
            </Show>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <div class="hidden text-11-regular text-text-weak md:block" aria-label="File navigation shortcuts">
              F12 definition · Shift+F12 relation
            </div>
            <button
              type="button"
              aria-label="Show relation for selected symbol"
              class="rounded-md bg-accent px-2 py-1 text-12-medium text-background-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              onClick={() => {
                void showRelationForSelection()
              }}
            >
              Show relation
            </button>
            <button
              type="button"
              class="rounded-md border border-border-base bg-surface-raised-base px-3 py-1 text-12-medium text-text-base"
              aria-label={editing() ? "Show highlighted file view" : "Edit file text"}
              onClick={() => setEditing((value) => !value)}
            >
              {editing() ? "Preview" : "Edit"}
            </button>
            <button
              type="button"
              class="rounded-md border border-border-base bg-surface-raised-base px-3 py-1 text-12-medium text-text-base"
              aria-pressed={autoEditForDefinition()}
              aria-label={
                autoEditForDefinition()
                  ? "Disable auto edit mode for definition jumps"
                  : "Enable auto edit mode for definition jumps"
              }
              onClick={toggleAutoEditForDefinition}
            >
              Auto edit jump: {autoEditForDefinition() ? "On" : "Off"}
            </button>
            <button
              type="button"
              class="rounded-md border border-border-base bg-surface-raised-base px-3 py-1 text-12-medium text-text-base disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!state()?.dirty || state()?.saving}
              aria-label={state()?.dirty ? "Save file with unsaved changes" : "Save file"}
              onClick={saveFile}
            >
              {state()?.saving ? "Saving..." : language.t("common.save")}
            </button>
          </div>
        </div>
        <Show when={editing()} fallback={renderViewer(source)}>
          <CodeEditor
            class="min-h-[50vh] w-full bg-background-base"
            ariaLabel="File editor"
            value={source}
            filePath={path()}
            selectedLine={activeSelection()?.start ?? null}
            selectedEndLine={activeSelection()?.end ?? null}
            selectedCharacter={selectedCharacter()}
            onChange={(value) => {
              const p = path()
              if (!p) return
              file.updateBuffer(p, value)
            }}
            onSave={saveFile}
            onSelectedCharacterReveal={() => {
              const p = path()
              if (p) file.setSelectedCharacter(p, null)
            }}
            onCursorChange={({ line, character }) => {
              setCursorLine(line)
              setCursorCharacter(character)
            }}
          />
        </Show>
      </Show>
    </div>
  )

  return (
    <Tabs.Content value={props.tab} class="mt-3 relative h-full">
      <ScrollView class="h-full" viewportRef={scrollSync.setViewport} onScroll={scrollSync.handleScroll as any}>
        <Switch>
          <Match when={state()?.loaded}>{renderFile(contents())}</Match>
          <Match when={state()?.loading}>
            <div class="px-6 py-4 text-text-weak">{language.t("common.loading")}...</div>
          </Match>
          <Match when={state()?.error}>{(err) => <div class="px-6 py-4 text-text-weak">{err()}</div>}</Match>
        </Switch>
      </ScrollView>
    </Tabs.Content>
  )
}
