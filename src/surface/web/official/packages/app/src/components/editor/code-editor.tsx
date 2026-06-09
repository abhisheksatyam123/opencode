import { createEffect, onCleanup, onMount } from "solid-js"
import { Compartment, EditorState, Prec, type Extension } from "@codemirror/state"
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
  type ViewUpdate,
} from "@codemirror/view"
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language"
import { cpp } from "@codemirror/lang-cpp"
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark"

export type CodeEditorCursor = {
  line: number
  character: number
}

export type CodeEditorProps = {
  value: string
  filePath?: string | null
  selectedLine?: number | null
  selectedEndLine?: number | null
  selectedCharacter?: number | null
  onChange?: (value: string) => void
  onSave?: VoidFunction
  onCursorChange?: (cursor: CodeEditorCursor) => void
  onSelectedCharacterReveal?: VoidFunction
  class?: string
  ariaLabel?: string
}

const cppExtensions = new Set([
  "c",
  "cc",
  "cpp",
  "cxx",
  "h",
  "hh",
  "hpp",
  "hxx",
  "inl",
  "ipp",
  "ixx",
  "tpp",
])

function extensionForPath(filePath?: string | null) {
  if (!filePath) return ""
  const name = filePath.split(/[\\/]/).pop()?.toLowerCase() ?? ""
  if (name === "makefile" || name.endsWith(".mk")) return ""
  return name.includes(".") ? (name.split(".").pop() ?? "") : ""
}

function languageExtensions(filePath?: string | null): Extension {
  const extension = extensionForPath(filePath)
  if (cppExtensions.has(extension)) return cpp()
  return []
}

function normalizedLine(line: number | null | undefined, total: number) {
  if (typeof line !== "number" || !Number.isFinite(line)) return
  return Math.max(1, Math.min(total, Math.trunc(line)))
}

const editorTheme = EditorView.theme({
  "&": {
    width: "100%",
    minHeight: "50vh",
    backgroundColor: "var(--background-base)",
    color: "var(--text-base)",
    fontSize: "13px",
  },
  "&.cm-focused": {
    outline: "none",
  },
  ".cm-scroller": {
    minHeight: "50vh",
    fontFamily: '"JetBrainsMono Nerd Font Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    lineHeight: "24px",
  },
  ".cm-content": {
    minHeight: "50vh",
    padding: "12px 16px",
    caretColor: "var(--text-strong)",
  },
  ".cm-line": {
    padding: "0 4px",
  },
  ".cm-gutters": {
    backgroundColor: "var(--surface-base)",
    borderRight: "1px solid var(--border-weaker-base)",
    color: "var(--text-weaker)",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    padding: "0 8px 0 12px",
  },
  ".cm-activeLine": {
    backgroundColor: "var(--surface-base-hover)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--surface-base-active)",
    color: "var(--text-base)",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "rgb(from var(--surface-warning-base) r g b / 0.35)",
  },
  ".cm-cursor": {
    borderLeftColor: "var(--text-strong)",
  },
  ".cm-matchingBracket, .cm-nonmatchingBracket": {
    backgroundColor: "var(--surface-base-active)",
    outline: "1px solid var(--border-weak-base)",
  },
})

export function CodeEditor(props: CodeEditorProps) {
  let host: HTMLDivElement | undefined
  let view: EditorView | undefined
  let applyingExternalValue = false
  let lastRevealKey = ""
  let lastRevealLocationKey = ""
  let lastRevealHadCharacter = false
  const language = new Compartment()

  const cursorFromPosition = (position: number): CodeEditorCursor | undefined => {
    const target = view
    if (!target) return
    const line = target.state.doc.lineAt(position)
    return {
      line: line.number,
      character: Math.max(0, position - line.from),
    }
  }

  const emitCursor = (position?: number) => {
    const target = view
    if (!target) return
    const cursor = cursorFromPosition(position ?? target.state.selection.main.head)
    if (cursor) props.onCursorChange?.(cursor)
  }

  const emitCursorAtCoords = (event: MouseEvent) => {
    const target = view
    if (!target) return
    const position = target.posAtCoords({ x: event.clientX, y: event.clientY })
    if (typeof position !== "number") {
      emitCursor()
      return
    }
    emitCursor(position)
  }

  const revealSelectedLine = () => {
    const target = view
    if (!target) return

    const rawStartLineNumber = normalizedLine(props.selectedLine, target.state.doc.lines)
    if (!rawStartLineNumber) {
      lastRevealKey = ""
      lastRevealLocationKey = ""
      lastRevealHadCharacter = false
      return
    }

    const rawEndLineNumber = normalizedLine(props.selectedEndLine, target.state.doc.lines) ?? rawStartLineNumber
    const startLineNumber = Math.min(rawStartLineNumber, rawEndLineNumber)
    const endLineNumber = Math.max(rawStartLineNumber, rawEndLineNumber)
    const startLine = target.state.doc.line(startLineNumber)
    const endLine = target.state.doc.line(endLineNumber)
    const selectedCharacter =
      typeof props.selectedCharacter === "number" && Number.isFinite(props.selectedCharacter)
        ? Math.max(0, Math.trunc(props.selectedCharacter))
        : null
    const anchor = selectedCharacter === null ? startLine.from : Math.min(startLine.to, startLine.from + selectedCharacter)
    const head = selectedCharacter === null ? endLine.to : anchor
    const revealLocationKey = [props.filePath ?? "", startLineNumber, endLineNumber].join(":")
    const revealKey = [revealLocationKey, selectedCharacter ?? ""].join(":")

    if (revealKey === lastRevealKey) return
    if (selectedCharacter === null && revealLocationKey === lastRevealLocationKey && lastRevealHadCharacter) {
      lastRevealKey = revealKey
      lastRevealHadCharacter = false
      return
    }

    lastRevealKey = revealKey
    lastRevealLocationKey = revealLocationKey
    lastRevealHadCharacter = selectedCharacter !== null
    target.dispatch({
      selection: { anchor, head },
      effects: EditorView.scrollIntoView(anchor, { y: "center" }),
    })
    emitCursor(anchor)
    if (selectedCharacter !== null) props.onSelectedCharacterReveal?.()
  }

  const baseExtensions = (): Extension[] => [
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    foldGutter(),
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    rectangularSelection(),
    crosshairCursor(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    syntaxHighlighting(oneDarkHighlightStyle, { fallback: true }),
    editorTheme,
    language.of(languageExtensions(props.filePath)),
    EditorView.lineWrapping,
    EditorView.editorAttributes.of({
      "data-component": "code-editor",
    }),
    EditorView.contentAttributes.of({
      "aria-label": props.ariaLabel ?? "File editor",
      spellcheck: "false",
    }),
    EditorView.domEventHandlers({
      contextmenu: (event) => {
        emitCursorAtCoords(event)
        return false
      },
      click: () => {
        emitCursor()
        return false
      },
    }),
    EditorView.updateListener.of((update: ViewUpdate) => {
      if (update.docChanged && !applyingExternalValue) props.onChange?.(update.state.doc.toString())
      if (update.docChanged || update.selectionSet) emitCursor(update.state.selection.main.head)
    }),
    Prec.highest(
      keymap.of([
        {
          key: "Mod-s",
          preventDefault: true,
          run: () => {
            props.onSave?.()
            return true
          },
        },
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap,
        ...foldKeymap,
      ]),
    ),
  ]

  onMount(() => {
    if (!host) return
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: props.value,
        extensions: baseExtensions(),
      }),
    })
    emitCursor()
    revealSelectedLine()
  })

  createEffect(() => {
    const target = view
    if (!target) return
    applyingExternalValue = true
    try {
      const current = target.state.doc.toString()
      if (current !== props.value) {
        target.dispatch({
          changes: { from: 0, to: target.state.doc.length, insert: props.value },
        })
      }
    } finally {
      applyingExternalValue = false
    }
  })

  createEffect(() => {
    const target = view
    if (!target) return
    target.dispatch({
      effects: language.reconfigure(languageExtensions(props.filePath)),
    })
  })

  createEffect(() => {
    revealSelectedLine()
  })

  onCleanup(() => {
    view?.destroy()
    view = undefined
  })

  return <div ref={(el) => (host = el)} class={props.class} data-component="code-editor" />
}
