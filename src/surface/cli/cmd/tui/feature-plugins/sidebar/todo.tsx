import type { TuiPlugin, TuiPluginApi, TuiPluginModule, TuiSidebarTodoItem } from "@opencode-ai/plugin/tui"
import { createMemo, For, Show, createSignal } from "solid-js"
import { TodoItem, type TodoItemData } from "@/surface/cli/cmd/tui/component/todo-item"
import { useSync } from "@tui/context/sync"

const id = "internal:sidebar-todo"

// Adapt the flat persisted todo records (Todo.Info[]) to the hierarchical
// TodoItemData[] shape that the renderer expects. The DB is flat — there is
// no parent/child structure to reconstruct from rows alone — so every item
// becomes a top-level entry with empty children. The agent + comments fields
// land directly on the leaf and are rendered by TodoItem.
function adaptTodos(rows: ReadonlyArray<TuiSidebarTodoItem>): TodoItemData[] {
  return rows.map((row) => ({
    content: row.content,
    status: row.status as TodoItemData["status"],
    priority: row.priority as TodoItemData["priority"],
    agent: row.agent,
    comments: [...(row.comments ?? [])],
    children: [],
  }))
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const [open, setOpen] = createSignal(true)
  const theme = () => props.api.theme.current
  const list = createMemo(() => adaptTodos(props.api.state.session.todo(props.session_id) ?? []))

  // Pending/in-progress only — completed items collapse out of the active view.
  const visible = createMemo(() => list().filter((item) => item.status !== "completed"))
  // In-flight pane — items currently being worked on by a specialist.
  const inflight = createMemo(() => list().filter((item) => item.status === "in_progress" && item.agent))

  const show = createMemo(() => visible().length > 0 || inflight().length > 0)

  // Attached todos — all todos bound to this session (from sync store).
  const sync = useSync()
  const attachedIds = createMemo(() => sync.data.attached_todo_ids?.[props.session_id] ?? [])
  const attachedLabels = createMemo(() => sync.data.attached_todo_labels?.[props.session_id] ?? {})

  return (
    <Show when={show() || attachedIds().length > 1}>
      <box flexDirection="column" gap={1}>
        <Show when={show()}>
          <box flexDirection="column" gap={1}>
            {/* Header + collapse toggle */}
            <box flexDirection="row" gap={1} onMouseDown={() => visible().length > 2 && setOpen((x) => !x)}>
              <Show when={visible().length > 2}>
                <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
              </Show>
              <text fg={theme().text}>
                <b>Todo</b>
              </text>
            </box>

            {/* Hierarchical todo list */}
            <Show when={visible().length > 0 && (visible().length <= 2 || open())}>
              <box flexDirection="column" gap={0}>
                <For each={visible()}>{(item, i) => <TodoItem item={item} index={i()} total={visible().length} />}</For>
              </box>
            </Show>

            {/* In-flight pane — surface which specialist is on which item */}
            <Show when={inflight().length > 0}>
              <box flexDirection="column" gap={0}>
                <text fg={theme().textMuted}>
                  <b>In flight</b>
                </text>
                <For each={inflight()}>
                  {(item) => (
                    <box flexDirection="row" gap={1} flexShrink={0}>
                      <text flexShrink={0} fg={theme().warning}>
                        ●
                      </text>
                      <text flexShrink={0} fg={theme().accent}>
                        {"@" + (item.agent ?? "?")}
                      </text>
                      <text flexGrow={1} wrapMode="word" fg={theme().text}>
                        {item.content}
                      </text>
                    </box>
                  )}
                </For>
              </box>
            </Show>
          </box>
        </Show>

        {/* Attached todos — all todos bound to this session */}
        <Show when={attachedIds().length > 1}>
          <box flexDirection="column" gap={0}>
            <text fg={theme().textMuted}>
              <b>Attached todos</b>
            </text>
            <For each={attachedIds()}>
              {(todoId) => (
                <box flexDirection="row" gap={1}>
                  <text fg={theme().accent}>◆</text>
                  <text fg={theme().text}>{attachedLabels()[todoId] ?? todoId}</text>
                </box>
              )}
            </For>
          </box>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 400,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
