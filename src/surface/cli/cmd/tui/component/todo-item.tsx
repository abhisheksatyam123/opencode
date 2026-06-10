import { For, Show } from "solid-js"
import { useTheme } from "@/surface/cli/cmd/tui/context/theme"

export type TodoItemData = {
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
  children?: TodoItemData[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusIcon(status: string) {
  if (status === "completed") return "✓"
  if (status === "in_progress") return "●"
  if (status === "cancelled") return "~"
  return "○"
}

function itemColor(status: string, theme: ReturnType<typeof useTheme>["theme"]) {
  if (status === "in_progress") return theme.warning
  if (status === "completed") return theme.success
  if (status === "cancelled") return theme.textMuted
  return theme.text
}

function priorityBadge(priority: string, compact: boolean, theme: ReturnType<typeof useTheme>["theme"]) {
  if (priority === "high") return { fg: theme.background, bg: theme.error, text: compact ? "H" : "HIGH" }
  if (priority === "low") return { fg: theme.background, bg: theme.info, text: compact ? "L" : "LOW" }
  return { fg: theme.background, bg: theme.textMuted, text: compact ? "M" : "MED" }
}

function branchGuide(last: boolean, prefix: string) {
  return `${prefix}${last ? "└─" : "├─"} `
}

function childPrefix(last: boolean, prefix: string) {
  return `${prefix}${last ? "   " : "│  "}`
}

// ---------------------------------------------------------------------------
// CommentRow — renders a single "> text" comment line
// ---------------------------------------------------------------------------

function DetailRow(props: { text: string; prefix: string; kind?: "comment" | "learning" | "plan" | "meta" }) {
  const { theme } = useTheme()

  const isUser = () => /^user:/i.test(props.text)
  const isAgent = () => /^agent:/i.test(props.text)
  const color = () =>
    props.kind === "learning"
      ? theme.success
      : props.kind === "plan"
        ? theme.info
        : props.kind === "meta"
          ? theme.textMuted
          : isUser()
            ? theme.accent
            : isAgent()
              ? theme.success
              : theme.textMuted
  const marker = () =>
    props.kind === "learning" ? "◆" : props.kind === "plan" ? "◇" : props.kind === "meta" ? "·" : "›"
  return (
    <box flexDirection="row" gap={1} flexShrink={0}>
      <Show when={props.prefix.length > 0}>
        <text fg={theme.border} flexShrink={0}>
          {props.prefix}
        </text>
      </Show>
      <text fg={color()} flexShrink={0}>
        {marker()}
      </text>
      <text fg={color()} wrapMode="word" flexGrow={1}>
        {props.text}
      </text>
    </box>
  )
}

// ---------------------------------------------------------------------------
// RecursiveTaskRow — renders every nested subtask level
// ---------------------------------------------------------------------------

function RecursiveTaskRow(props: { item: TodoItemData; depth: number; last: boolean; prefix: string }) {
  const { theme } = useTheme()
  const color = () => itemColor(props.item.status, theme)
  const badge = () => priorityBadge(props.item.priority, props.depth > 0, theme)
  const children = () => props.item.children ?? []

  return (
    <box flexDirection="column" gap={0} flexShrink={0}>
      <box flexDirection="row" gap={1} flexShrink={0}>
        <text fg={theme.border} flexShrink={0}>
          {branchGuide(props.last, props.prefix)}
        </text>
        <text flexShrink={0} fg={color()}>
          {statusIcon(props.item.status)}
        </text>
        <text flexShrink={0} style={{ fg: badge().fg, bg: badge().bg }}>
          {` ${badge().text} `}
        </text>
        <text flexGrow={1} wrapMode="word" fg={color()}>
          <Show when={props.item.num}>
            <span style={{ fg: theme.textMuted }}>[{props.item.num}] </span>
          </Show>
          <Show when={props.depth === 0} fallback={props.item.content}>
            <span style={{ bold: true }}>{props.item.content}</span>
          </Show>
        </text>
        <Show when={props.item.type}>
          <text flexShrink={0} fg={theme.textMuted}>
            {props.item.type}
          </text>
        </Show>
        <Show when={props.item.agent}>
          <text flexShrink={0} fg={theme.accent}>
            {"@" + props.item.agent}
          </text>
        </Show>
      </box>
      <Show when={props.item.acceptance_signal}>
        <DetailRow
          text={`accept: ${props.item.acceptance_signal}`}
          prefix={childPrefix(props.last, props.prefix)}
          kind="meta"
        />
      </Show>
      <Show when={(props.item.depends_on?.length ?? 0) > 0}>
        <DetailRow
          text={`depends on: ${(props.item.depends_on ?? []).join(", ")}`}
          prefix={childPrefix(props.last, props.prefix)}
          kind="meta"
        />
      </Show>
      <Show when={(props.item.blocked_by?.length ?? 0) > 0}>
        <DetailRow
          text={`blocked by: ${(props.item.blocked_by ?? []).join(", ")}`}
          prefix={childPrefix(props.last, props.prefix)}
          kind="meta"
        />
      </Show>
      <Show when={props.item.parallel_group}>
        <DetailRow
          text={`parallel group: ${props.item.parallel_group}`}
          prefix={childPrefix(props.last, props.prefix)}
          kind="meta"
        />
      </Show>
      <For each={props.item.plans ?? []}>
        {(c) => <DetailRow text={c} prefix={childPrefix(props.last, props.prefix)} kind="plan" />}
      </For>
      <For each={props.item.learnings ?? []}>
        {(c) => <DetailRow text={c} prefix={childPrefix(props.last, props.prefix)} kind="learning" />}
      </For>
      <For each={props.item.comments ?? []}>
        {(c) => <DetailRow text={c} prefix={childPrefix(props.last, props.prefix)} kind="comment" />}
      </For>
      <Show when={children().length > 0}>
        <box flexDirection="column" gap={0}>
          <For each={children()}>
            {(child, i) => (
              <RecursiveTaskRow
                item={child}
                depth={props.depth + 1}
                last={i() === children().length - 1}
                prefix={childPrefix(props.last, props.prefix)}
              />
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}

// ---------------------------------------------------------------------------
// TodoItem — top-level task entry with all recursive children
// ---------------------------------------------------------------------------

export function TodoItem(props: { item: TodoItemData; index: number; total: number }) {
  const isLast = () => props.index === props.total - 1

  return (
    <box flexDirection="column" gap={0} marginBottom={isLast() ? 0 : 1}>
      <RecursiveTaskRow item={props.item} depth={0} last={isLast()} prefix="" />
    </box>
  )
}
