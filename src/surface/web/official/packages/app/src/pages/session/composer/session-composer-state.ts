import { createEffect, createMemo, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import type { Todo } from "@opencode-ai/sdk/v2"
import { useParams } from "@solidjs/router"
import { useGlobalSync } from "@/context/global-sync"
import { useSync } from "@/context/sync"
import { todoState } from "./session-composer-todo-state"

const idle = { type: "idle" as const }

export function createSessionComposerState(options?: {
  closeMs?: number | (() => number)
  sessionID?: string | (() => string | undefined)
}) {
  const params = useParams()
  const sync = useSync()
  const globalSync = useGlobalSync()
  const sessionID = () => {
    const value = options?.sessionID
    if (typeof value === "function") return value()
    return value ?? params.id
  }

  const todos = createMemo((): Todo[] => {
    const id = sessionID()
    if (!id) return []
    return globalSync.data.session_todo[id] ?? []
  })

  const done = createMemo(
    () => todos().length > 0 && todos().every((todo) => todo.status === "completed" || todo.status === "cancelled"),
  )

  const live = createMemo(() => sync.data.session_working(sessionID() ?? ""))

  const [store, setStore] = createStore({
    dock: todos().length > 0 && live(),
    closing: false,
    opening: false,
  })

  let timer: number | undefined
  let raf: number | undefined

  const closeMs = () => {
    const value = options?.closeMs
    if (typeof value === "function") return Math.max(0, value())
    if (typeof value === "number") return Math.max(0, value)
    return 400
  }

  const scheduleClose = () => {
    if (timer) window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      setStore({ dock: false, closing: false })
      timer = undefined
    }, closeMs())
  }

  // Keep stale turn todos from reopening if the model never clears them.
  const clear = () => {
    const id = sessionID()
    if (!id) return
    globalSync.todo.set(id, [])
    sync.set("todo", id, [])
  }

  createEffect(
    on(
      () => [todos().length, done(), live()] as const,
      ([count, complete, active]) => {
        if (raf) cancelAnimationFrame(raf)
        raf = undefined

        const next = todoState({
          count,
          done: complete,
          live: active,
        })

        if (next === "hide") {
          if (timer) window.clearTimeout(timer)
          timer = undefined
          setStore({ dock: false, closing: false, opening: false })
          return
        }

        if (next === "clear") {
          if (timer) window.clearTimeout(timer)
          timer = undefined
          clear()
          return
        }

        if (next === "open") {
          if (timer) window.clearTimeout(timer)
          timer = undefined
          const hidden = !store.dock || store.closing
          setStore({ dock: true, closing: false })
          if (hidden) {
            setStore("opening", true)
            raf = requestAnimationFrame(() => {
              setStore("opening", false)
              raf = undefined
            })
            return
          }
          setStore("opening", false)
          return
        }

        setStore({ dock: true, opening: false, closing: true })
        if (!timer) scheduleClose()
      },
    ),
  )

  onCleanup(() => {
    if (!timer) return
    window.clearTimeout(timer)
  })

  onCleanup(() => {
    if (!raf) return
    cancelAnimationFrame(raf)
  })

  return {
    todos,
    dock: () => store.dock,
    closing: () => store.closing,
    opening: () => store.opening,
    blocked: () => false,
  }
}

export type SessionComposerState = ReturnType<typeof createSessionComposerState>
