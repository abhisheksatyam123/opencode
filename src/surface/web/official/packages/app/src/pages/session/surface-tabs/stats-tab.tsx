import { For, Match, Show, Switch, createMemo, createResource } from "solid-js"
import { createStore } from "solid-js/store"
import { useSurfaceSessionBridge } from "@/surface/session-provider"
import type { SurfaceContextWindowStats, SurfaceLLMCallStats, SurfaceTokenCounts } from "@/surface/ports"

const number = new Intl.NumberFormat()
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 })
const money = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 4 })

function numeric(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function normalize(tokens: SurfaceTokenCounts): SurfaceTokenCounts {
  return {
    input: numeric(tokens.input),
    output: numeric(tokens.output),
    reasoning: numeric(tokens.reasoning),
    cache: {
      read: numeric(tokens.cache?.read),
      write: numeric(tokens.cache?.write),
    },
  }
}

function total(tokens: SurfaceTokenCounts) {
  const next = normalize(tokens)
  return next.input + next.output + next.reasoning + next.cache.read + next.cache.write
}

function fmtPct(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return "—"
  return `${Math.round(value)}%`
}

function ratio(value: number, max: number) {
  if (max <= 0 || value <= 0) return 0
  return Math.max(1, Math.min(100, (value / max) * 100))
}


type ContextSegment = {
  name: string
  tokens: number
  detail?: string
  color: string
  border?: string
}

function contextSegmentColor(name: string, index: number): Pick<ContextSegment, "color" | "border"> {
  const lower = name.toLowerCase()
  if (lower.includes("free")) return { color: "transparent", border: "1px solid var(--border-weaker-base, #334155)" }
  if (lower.includes("system")) return { color: "#f59e0b" }
  if (lower.includes("user")) return { color: "#22c55e" }
  if (lower.includes("tool")) return { color: "#3b82f6" }
  if (lower.includes("assistant") || lower.includes("reasoning") || lower.includes("text")) return { color: "#a855f7" }
  if (lower.includes("file") || lower.includes("patch") || lower.includes("snapshot")) return { color: "#64748b" }
  if (lower.includes("unattributed")) return { color: "#ec4899" }
  return [{ color: "#3b82f6" }, { color: "#f59e0b" }, { color: "#22c55e" }, { color: "#a855f7" }][index % 4]
}

function contextSegments(context: SurfaceContextWindowStats, limit: number): ContextSegment[] {
  const used = Math.min(Math.max(0, context.used), Math.max(1, limit))
  const source = context.components.filter((component) => component.tokens > 0)
  const componentTotal = source.reduce((sum, component) => sum + component.tokens, 0)
  const scale = componentTotal > used && componentTotal > 0 ? used / componentTotal : 1
  const segments = source.map((component, index) => ({
    name: component.name,
    detail: component.detail,
    tokens: Math.max(0, Math.round(component.tokens * scale)),
    ...contextSegmentColor(component.name, index),
  }))
  const represented = segments.reduce((sum, segment) => sum + segment.tokens, 0)
  const unattributed = Math.max(0, used - represented)
  if (unattributed > 0) {
    segments.push({
      name: "unattributed used",
      detail: "model-reported prompt tokens",
      tokens: unattributed,
      ...contextSegmentColor("unattributed used", segments.length),
    })
  }
  const free = Math.max(0, limit - used)
  if (free > 0) {
    segments.push({
      name: "free space",
      detail: "available",
      tokens: free,
      ...contextSegmentColor("free space", segments.length),
    })
  }
  return segments.filter((segment) => segment.tokens > 0)
}

function contextCells(segments: ContextSegment[], limit: number) {
  const totalCells = 128
  const safeLimit = Math.max(1, limit)
  return Array.from({ length: totalCells }, (_, index) => {
    const cursor = ((index + 0.5) / totalCells) * safeLimit
    let end = 0
    for (const segment of segments) {
      end += segment.tokens
      if (cursor <= end) return segment
    }
    return segments[segments.length - 1] ?? {
      name: "free space",
      detail: "available",
      tokens: safeLimit,
      ...contextSegmentColor("free space", 0),
    }
  })
}


function ContextHistogram(props: { segments: ContextSegment[]; limit: number }) {
  return (
    <div class="mt-3 rounded border border-border-weaker-base bg-background-stronger p-2">
      <div class="mb-2 text-11-mono uppercase tracking-wide text-text-weak">Context histogram</div>
      <div class="flex flex-col gap-2">
        <For each={props.segments.slice(0, 8)}>
          {(segment) => (
            <div class="grid grid-cols-[8rem_1fr_4.5rem] items-center gap-2 text-11-regular">
              <div class="truncate text-text-weak" title={segment.detail ? `${segment.name} · ${segment.detail}` : segment.name}>
                {segment.name}
              </div>
              <div class="h-2 overflow-hidden rounded bg-surface-raised-base">
                <div
                  class="h-full rounded"
                  style={{
                    width: `${ratio(segment.tokens, props.limit)}%`,
                    "background-color": segment.color,
                    border: segment.border ?? "none",
                  }}
                />
              </div>
              <div class="text-right font-mono text-text-base">{compact.format(segment.tokens)}</div>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}

function StatCard(props: { label: string; value: string; detail?: string; color: string }) {
  return (
    <div class="rounded border border-border-weaker-base bg-surface-base p-3">
      <div class={`mb-2 h-1 rounded ${props.color}`} />
      <div class="text-11-mono uppercase tracking-wide text-text-weak">{props.label}</div>
      <div class="mt-1 text-22-medium text-text-strong">{props.value}</div>
      <Show when={props.detail}>{(detail) => <div class="mt-1 text-11-regular text-text-weak">{detail()}</div>}</Show>
    </div>
  )
}

function ContextWindow(props: { context: SurfaceContextWindowStats }) {
  const limit = createMemo(() => props.context.inputLimit ?? props.context.hardLimit ?? props.context.used)
  const usedPct = createMemo(() => props.context.usedPctInput ?? props.context.usedPctHard ?? ratio(props.context.used, limit()))
  const free = createMemo(() => Math.max(0, limit() - props.context.used))
  const segments = createMemo(() => contextSegments(props.context, limit()))
  const cells = createMemo(() => contextCells(segments(), limit()))
  return (
    <div class="rounded border border-border-weaker-base bg-surface-base p-3">
      <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div class="text-13-medium text-text-strong">Context window</div>
          <div class="text-11-mono text-text-weak">
            {props.context.providerID || "provider"}/{props.context.modelID || "model"}
          </div>
        </div>
        <div class="text-right font-mono text-12-regular text-text-base">
          {compact.format(props.context.used)} / {compact.format(limit())} ({fmtPct(usedPct())})
        </div>
      </div>
      <div
        class="grid gap-0.5 rounded border border-border-weaker-base bg-background-stronger p-1"
        style={{ "grid-template-columns": "repeat(32, minmax(0, 1fr))" }}
        aria-label="2D context window map"
      >
        <For each={cells()}>
          {(cell) => (
            <div
              class="h-3 rounded-sm"
              style={{ "background-color": cell.color, border: cell.border ?? "none" }}
              title={`${cell.name}: ${number.format(cell.tokens)} tokens${cell.detail ? ` · ${cell.detail}` : ""}`}
            />
          )}
        </For>
      </div>
      <div class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-11-mono text-text-weak">
        <For each={segments().slice(0, 8)}>
          {(segment) => (
            <div class="flex items-center gap-1.5">
              <span
                class="size-2 rounded-sm"
                style={{ "background-color": segment.color, border: segment.border ?? "none" }}
              />
              <span>{segment.name}</span>
            </div>
          )}
        </For>
      </div>
      <ContextHistogram segments={segments()} limit={limit()} />
      <div class="mt-2 grid gap-2 text-12-regular sm:grid-cols-3">
        <div>
          <span class="text-text-weak">available</span> <span class="font-mono text-text-base">{compact.format(free())}</span>
        </div>
        <div>
          <span class="text-text-weak">soft cap</span>{" "}
          <span class="font-mono text-text-base">{props.context.softLimit ? compact.format(props.context.softLimit) : "—"}</span>
        </div>
        <div>
          <span class="text-text-weak">output reserve</span>{" "}
          <span class="font-mono text-text-base">{props.context.outputReserve ? compact.format(props.context.outputReserve) : "—"}</span>
        </div>
      </div>
    </div>
  )
}

function TokenBreakdown(props: { tokens: SurfaceTokenCounts }) {
  const rows = createMemo(() => {
    const tokens = normalize(props.tokens)
    return [
      ["input", tokens.input, "#3b82f6"],
      ["output", tokens.output, "#22c55e"],
      ["reasoning", tokens.reasoning, "#f59e0b"],
      ["cache", tokens.cache.read + tokens.cache.write, "#a855f7"],
    ] as const
  })
  const all = createMemo(() => Math.max(1, total(props.tokens)))
  return (
    <div class="rounded border border-border-weaker-base bg-surface-base p-3">
      <div class="mb-3 flex items-center justify-between gap-3">
        <div class="text-13-medium text-text-strong">Tokens</div>
        <div class="font-mono text-12-regular text-text-base">{number.format(total(props.tokens))}</div>
      </div>
      <div class="mb-3 flex h-4 overflow-hidden rounded bg-surface-raised-base">
        <For each={rows()}>
          {([, value, color]) => (
            <div style={{ width: `${ratio(value, all())}%`, "background-color": color }} />
          )}
        </For>
      </div>
      <div class="grid gap-2 sm:grid-cols-2">
        <For each={rows()}>
          {([label, value, color]) => (
            <div class="flex items-center gap-2 text-12-regular">
              <span class="size-2 rounded-sm" style={{ "background-color": color }} />
              <span class="text-text-weak">{label}</span>
              <span class="ml-auto font-mono text-text-base">{compact.format(value)}</span>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}

function LLMCalls(props: { calls: SurfaceLLMCallStats[] }) {
  return (
    <div class="rounded border border-border-weaker-base bg-surface-base p-3">
      <div class="mb-3 text-13-medium text-text-strong">LLM calls</div>
      <Show when={props.calls.length > 0} fallback={<div class="text-12-regular text-text-weak">No LLM calls yet.</div>}>
        <div class="overflow-auto">
          <table class="w-full min-w-[36rem] text-left text-12-regular">
            <thead class="text-11-mono uppercase text-text-weak">
              <tr class="border-b border-border-weaker-base">
                <th class="py-2 pr-3">Call</th>
                <th class="py-2 pr-3">Model</th>
                <th class="py-2 pr-3 text-right">Sent</th>
                <th class="py-2 pr-3 text-right">Received</th>
                <th class="py-2 pr-3 text-right">Tool calls</th>
                <th class="py-2 text-right">Cost</th>
              </tr>
            </thead>
            <tbody>
              <For each={props.calls}>
                {(call, index) => (
                  <tr class="border-b border-border-weaker-base last:border-b-0">
                    <td class="py-2 pr-3 font-mono text-text-base">#{index() + 1}</td>
                    <td class="py-2 pr-3 font-mono text-11-mono text-text-weak">
                      {call.providerID}/{call.modelID}
                    </td>
                    <td class="py-2 pr-3 text-right font-mono text-text-base">{number.format(call.sentTokens)}</td>
                    <td class="py-2 pr-3 text-right font-mono text-text-base">{number.format(call.receivedTokens)}</td>
                    <td class="py-2 pr-3 text-right font-mono text-text-base">{number.format(call.toolCalls)}</td>
                    <td class="py-2 text-right font-mono text-text-base">{money.format(call.cost)}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
    </div>
  )
}

function EmptyState(props: { title: string; description: string }) {
  return (
    <div class="rounded border border-border-weaker-base bg-surface-base p-4 text-center">
      <div class="text-14-medium text-text-strong">{props.title}</div>
      <div class="mt-1 text-12-regular text-text-weak">{props.description}</div>
    </div>
  )
}

export function SurfaceStatsTab(props: { sessionID?: string }) {
  const bridge = useSurfaceSessionBridge()
  const [state, setState] = createStore({ refresh: 0 })
  const [stats] = createResource(
    () => (props.sessionID ? `${props.sessionID}:${state.refresh}` : undefined),
    async () => bridge.getSessionStats(props.sessionID!, { force: state.refresh > 0 }),
  )

  return (
    <div class="h-full min-h-0 overflow-y-auto bg-background-base p-4">
      <div class="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 class="text-16-medium text-text-strong">Stats</h2>
          <p class="text-12-regular text-text-weak">Current session context, LLM calls, tool calls, tokens, and cost.</p>
        </div>
        <button
          type="button"
          class="rounded border border-border-weaker-base px-3 py-1.5 text-12-medium text-text-base"
          onClick={() => setState("refresh", (x) => x + 1)}
        >
          Refresh
        </button>
      </div>
      <Switch>
        <Match when={!props.sessionID}>
          <EmptyState title="No session selected" description="Open a session to inspect stats." />
        </Match>
        <Match when={stats.loading}>
          <div class="text-12-regular text-text-weak">Loading stats…</div>
        </Match>
        <Match when={stats.error}>
          <div class="rounded border border-danger/30 bg-danger/10 p-3 text-12-regular text-danger">{String(stats.error)}</div>
        </Match>
        <Match when={stats()} keyed>
          {(data) => {
            const ctx = data.context
            return (
              <div class="flex flex-col gap-3">
                <div class="grid grid-cols-2 gap-3 lg:grid-cols-6">
                  <StatCard label="Context" value={fmtPct(ctx.usedPctInput ?? ctx.usedPctHard)} detail={`${compact.format(ctx.used)} used`} color="bg-warning" />
                  <StatCard label="LLM calls" value={number.format(ctx.callCount)} detail={`${compact.format(ctx.avgCallTokens)} avg tokens`} color="bg-accent" />
                  <StatCard label="Tool calls" value={number.format(ctx.totalToolCalls ?? 0)} detail={`${compact.format(ctx.totalToolCallTokens ?? 0)} tokens`} color="bg-info" />
                  <StatCard label="Tools / LLM" value={String(ctx.avgToolCallsPerLLM ?? 0)} detail={`max ${ctx.maxToolCallsPerLLM ?? 0}`} color="bg-success" />
                  <StatCard label="Tokens" value={compact.format(total(data.aggregate.tokens))} color="bg-surface-base-active" />
                  <StatCard label="Cost" value={money.format(data.aggregate.cost)} color="bg-surface-raised-base-active" />
                </div>
                <ContextWindow context={ctx} />
                <TokenBreakdown tokens={data.aggregate.tokens} />
                <LLMCalls calls={data.llmCalls ?? []} />
              </div>
            )
          }}
        </Match>
      </Switch>
    </div>
  )
}
