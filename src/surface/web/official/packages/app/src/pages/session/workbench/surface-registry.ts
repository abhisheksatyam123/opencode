import { DURABLE_SURFACE_KINDS, type DurableSurfaceKind } from "./surface-id"

export { DURABLE_SURFACE_KINDS }

export type SurfaceKind = DurableSurfaceKind
export type SurfaceScope = "global" | "workspace" | "session" | "file"
export type SurfaceGroup = "conversation" | "workspace" | "code" | "knowledge" | "observability" | "agents"
export type SurfaceScroll = "surface" | "canvas" | "terminal"

export type SurfaceDefinition = {
  kind: SurfaceKind
  scope: SurfaceScope
  group: SurfaceGroup
  label: string
  ariaLabel: string
  icon: string
  singleton: boolean
  closable: boolean
  splittable: boolean
  scroll: SurfaceScroll
}

export const surfaceDefinitions = [
  {
    kind: "chat",
    scope: "session",
    group: "conversation",
    label: "Chat",
    ariaLabel: "Open Chat tab for current session",
    icon: "speech-bubble",
    singleton: true,
    closable: true,
    splittable: true,
    scroll: "surface",
  },
  {
    kind: "sessions",
    scope: "workspace",
    group: "workspace",
    label: "Sessions",
    ariaLabel: "Open Sessions tab for workspace",
    icon: "sessions",
    singleton: true,
    closable: true,
    splittable: true,
    scroll: "surface",
  },
  {
    kind: "terminal",
    scope: "workspace",
    group: "workspace",
    label: "Terminal",
    ariaLabel: "Open Terminal tab for workspace",
    icon: "terminal",
    singleton: false,
    closable: true,
    splittable: true,
    scroll: "terminal",
  },
  {
    kind: "files",
    scope: "workspace",
    group: "code",
    label: "Files",
    ariaLabel: "Open Files tab for workspace",
    icon: "file-tree",
    singleton: true,
    closable: true,
    splittable: true,
    scroll: "surface",
  },
  {
    kind: "file",
    scope: "file",
    group: "code",
    label: "File",
    ariaLabel: "Open File tab",
    icon: "file-code",
    singleton: false,
    closable: true,
    splittable: true,
    scroll: "surface",
  },
  {
    kind: "diff",
    scope: "session",
    group: "code",
    label: "Diff / Review",
    ariaLabel: "Open Diff and Review tab for current session",
    icon: "diff-review",
    singleton: true,
    closable: true,
    splittable: true,
    scroll: "surface",
  },
  {
    kind: "todo",
    scope: "session",
    group: "workspace",
    label: "Todo / Tasks",
    ariaLabel: "Open Todo and Tasks tab for current session",
    icon: "checklist",
    singleton: true,
    closable: true,
    splittable: true,
    scroll: "surface",
  },
  {
    kind: "notes",
    scope: "workspace",
    group: "knowledge",
    label: "Notes",
    ariaLabel: "Open Notes tab for workspace",
    icon: "pencil-line",
    singleton: true,
    closable: true,
    splittable: true,
    scroll: "surface",
  },
  {
    kind: "intelgraph",
    scope: "workspace",
    group: "knowledge",
    label: "IntelGraph",
    ariaLabel: "Open IntelGraph tab for workspace",
    icon: "graph-network",
    singleton: true,
    closable: true,
    splittable: true,
    scroll: "canvas",
  },
  {
    kind: "logs",
    scope: "global",
    group: "observability",
    label: "Logs",
    ariaLabel: "Open Logs tab",
    icon: "console",
    singleton: true,
    closable: true,
    splittable: true,
    scroll: "surface",
  },
  {
    kind: "stats",
    scope: "session",
    group: "observability",
    label: "Stats",
    ariaLabel: "Open Stats tab for current session",
    icon: "chart-line",
    singleton: true,
    closable: true,
    splittable: true,
    scroll: "surface",
  },
  {
    kind: "agents",
    scope: "session",
    group: "agents",
    label: "Stats",
    ariaLabel: "Open Stats tab for current session",
    icon: "chart-line",
    singleton: true,
    closable: true,
    splittable: true,
    scroll: "surface",
  },
  {
    kind: "context",
    scope: "session",
    group: "conversation",
    label: "Context",
    ariaLabel: "Open Context tab for current session",
    icon: "context",
    singleton: true,
    closable: true,
    splittable: true,
    scroll: "surface",
  },
] as const satisfies readonly SurfaceDefinition[]

const definitionsByKind = new Map<SurfaceKind, SurfaceDefinition>(
  surfaceDefinitions.map((definition) => [definition.kind, definition]),
)

export function isSurfaceKind(value: string): value is SurfaceKind {
  return definitionsByKind.has(value as SurfaceKind)
}

export function getSurfaceKind(kindOrUri: string): SurfaceKind | undefined {
  const schemeEnd = kindOrUri.indexOf("://")
  const kind = schemeEnd === -1 ? kindOrUri : kindOrUri.slice(0, schemeEnd)
  return isSurfaceKind(kind) ? kind : undefined
}

export function getSurfaceDefinition(kindOrUri: string): SurfaceDefinition | undefined {
  const kind = getSurfaceKind(kindOrUri)
  return kind ? definitionsByKind.get(kind) : undefined
}

export function listLaunchableSurfaces(): readonly SurfaceDefinition[] {
  return surfaceDefinitions.filter((definition) => definition.kind !== "agents")
}
