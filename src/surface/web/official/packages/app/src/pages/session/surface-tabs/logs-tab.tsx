import { Match, Show, Switch, createEffect, createMemo, createResource, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"

type LogSource = "all" | "frontend" | "server" | "intelgraph"

type AppLogEntry = {
  timestamp?: string
  service?: string
  level?: string
  message?: string
  extra?: Record<string, unknown>
}

type SurfaceLogResponse = {
  ok: boolean
  timestamp: string
  app: AppLogEntry[]
  server?: { file: string; lines: string[] }
  intelgraph: { file: string; entries: unknown[] }
}

export type SurfaceLogsTabDeps = {
  baseUrl?: string
  fetch?: typeof fetch
  pollMs?: number
}

function line(value: unknown) {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function appLine(entry: AppLogEntry) {
  const prefix = [entry.timestamp, entry.level, entry.service].filter(Boolean).join(" ")
  return `${prefix ? `${prefix} ` : ""}${entry.message ?? line(entry)}`
}

function EmptyState(props: { title: string; description: string }) {
  return (
    <div class="rounded border border-border-weaker-base bg-surface-base p-4 text-center">
      <div class="text-14-medium text-text-strong">{props.title}</div>
      <div class="mt-1 text-12-regular text-text-weak">{props.description}</div>
    </div>
  )
}

export function SurfaceLogsTab(props: { deps?: SurfaceLogsTabDeps } = {}) {
  const sdk = props.deps?.baseUrl ? undefined : useGlobalSDK()
  const platform = props.deps?.fetch ? undefined : usePlatform()
  const fetcher = props.deps?.fetch ?? platform?.fetch ?? fetch
  const [state, setState] = createStore({ refresh: 0, source: "all" as LogSource, limit: 200, autoRefresh: true, copied: false })

  const endpoint = createMemo(() => {
    const url = new URL("/log", props.deps?.baseUrl ?? sdk!.url)
    url.searchParams.set("format", "json")
    url.searchParams.set("limit", String(state.limit))
    return url.toString()
  })

  createEffect(() => {
    if (!state.autoRefresh || typeof window === "undefined") return
    const interval = window.setInterval(() => setState("refresh", (value) => value + 1), props.deps?.pollMs ?? 2_000)
    onCleanup(() => window.clearInterval(interval))
  })

  const [logs] = createResource(
    () => `${endpoint()}:${state.refresh}`,
    async (): Promise<SurfaceLogResponse> => {
      const response = await fetcher(endpoint(), { headers: { accept: "application/json" } })
      if (!response.ok) throw new Error(`Failed to load /log (${response.status})`)
      return (await response.json()) as SurfaceLogResponse
    },
  )

  const text = createMemo(() => {
    const data = logs()
    if (!data) return ""
    const chunks: string[] = []
    if (state.source === "all" || state.source === "frontend") {
      chunks.push("# Frontend app logs", ...data.app.map(appLine))
    }
    if (state.source === "all" || state.source === "server") {
      if (chunks.length) chunks.push("")
      chunks.push(`# Server logs${data.server?.file ? ` (${data.server.file})` : ""}`, ...(data.server?.lines ?? []))
    }
    if (state.source === "all" || state.source === "intelgraph") {
      if (chunks.length) chunks.push("")
      chunks.push(`# IntelGraph logs (${data.intelgraph.file})`, ...data.intelgraph.entries.map(line))
    }
    return chunks.join("\n")
  })

  const copy = async () => {
    await navigator.clipboard?.writeText(text())
    setState("copied", true)
    window.setTimeout(() => setState("copied", false), 1200)
  }

  return (
    <div class="h-full min-h-0 overflow-y-auto bg-background-base p-4">
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 class="text-16-medium text-text-strong">Logs</h2>
          <p class="text-12-regular text-text-weak">Plain text log output from /log.</p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <select
            class="rounded border border-border-weaker-base bg-surface-base px-2 py-1 text-12-regular text-text-base"
            value={state.source}
            onChange={(event) => setState("source", event.currentTarget.value as LogSource)}
          >
            <option value="all">All</option>
            <option value="frontend">Frontend</option>
            <option value="server">Server</option>
            <option value="intelgraph">IntelGraph</option>
          </select>
          <input
            type="number"
            min={1}
            max={1000}
            value={state.limit}
            class="w-20 rounded border border-border-weaker-base bg-surface-base px-2 py-1 text-11-mono text-text-base"
            onInput={(event) => setState("limit", Math.max(1, Math.min(1000, Number(event.currentTarget.value) || 200)))}
          />
          <button class="rounded border border-border-weaker-base px-2 py-1 text-12-medium text-text-base" onClick={() => setState("refresh", (x) => x + 1)}>
            Refresh
          </button>
          <button class="rounded border border-border-weaker-base px-2 py-1 text-12-medium text-text-base" onClick={() => setState("autoRefresh", (x) => !x)}>
            Auto {state.autoRefresh ? "on" : "off"}
          </button>
          <button class="rounded border border-border-weaker-base px-2 py-1 text-12-medium text-text-base" onClick={copy} disabled={!text()}>
            {state.copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
      <Switch>
        <Match when={logs.loading}>
          <div class="text-12-regular text-text-weak">Loading logs…</div>
        </Match>
        <Match when={logs.error}>
          <div class="rounded border border-danger/30 bg-danger/10 p-3 text-12-regular text-danger">{String(logs.error)}</div>
        </Match>
        <Match when={text()} keyed>
          {(value) => <pre class="min-h-[60vh] overflow-auto whitespace-pre-wrap rounded border border-border-weaker-base bg-background-stronger p-3 text-11-mono leading-5 text-text-base">{value}</pre>}
        </Match>
        <Match when={!text()}>
          <EmptyState title="No logs" description="No log lines returned for the selected source." />
        </Match>
      </Switch>
      <Show when={logs()?.timestamp}>
        {(timestamp) => <div class="mt-2 text-11-mono text-text-weak">Updated {timestamp()}</div>}
      </Show>
    </div>
  )
}
