import { normalizeSurfaceURI } from "./surface-id"

export type OpenSurfacePane = "a" | "b"

export type OpenSurfaceTabs = {
  all: () => readonly string[]
  allB: () => readonly string[]
  active: () => string | undefined
  activeB: () => string | undefined
  open: (uri: string) => void | Promise<void>
  openInB: (uri: string) => void | Promise<void>
  setActive: (uri: string | undefined) => void
  setActiveB: (uri: string | undefined) => void
}

export type OpenSurfaceOptions = {
  pane?: OpenSurfacePane
}

export type OpenSurfaceResult = {
  uri: string
  pane: OpenSurfacePane
  created: boolean
}

export function openSurface(
  tabs: OpenSurfaceTabs,
  inputUri: string,
  options: OpenSurfacePane | OpenSurfaceOptions = "a",
): OpenSurfaceResult {
  const uri = normalizeInputUri(inputUri)
  const targetPane = resolveTargetPane(options)
  const existingPane = findExistingPane(tabs, uri, targetPane)

  if (existingPane) {
    focusPane(tabs, existingPane, uri)
    return { uri, pane: existingPane, created: false }
  }

  if (targetPane === "b") tabs.openInB(uri)
  else tabs.open(uri)

  return { uri, pane: targetPane, created: true }
}

function normalizeInputUri(inputUri: string): string {
  const uri = normalizeSurfaceURI(inputUri)
  if (!uri) throw new Error(`Invalid surface URI: ${inputUri}`)
  return uri
}

function resolveTargetPane(options: OpenSurfacePane | OpenSurfaceOptions): OpenSurfacePane {
  if (options === "b") return "b"
  if (typeof options === "object" && options?.pane === "b") return "b"
  return "a"
}

function findExistingPane(
  tabs: OpenSurfaceTabs,
  uri: string,
  targetPane: OpenSurfacePane,
): OpenSurfacePane | undefined {
  const existsInA = tabs.all().includes(uri)
  const existsInB = tabs.allB().includes(uri)
  if (targetPane === "b") return existsInB ? "b" : existsInA ? "a" : undefined
  return existsInA ? "a" : existsInB ? "b" : undefined
}

function focusPane(tabs: OpenSurfaceTabs, pane: OpenSurfacePane, uri: string) {
  if (pane === "b") {
    if (tabs.activeB() !== uri) tabs.setActiveB(uri)
    return
  }
  if (tabs.active() !== uri) tabs.setActive(uri)
}
