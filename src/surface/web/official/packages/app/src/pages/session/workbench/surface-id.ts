import { decodeFilePath, encodeFilePath } from "../../../context/file/path"

/** Durable surfaces that may exist as restorable workbench tabs. */
export const DURABLE_SURFACE_KINDS = [
  "chat",
  "sessions",
  "terminal",
  "files",
  "file",
  "diff",
  "todo",
  "notes",
  "intelgraph",
  "logs",
  "stats",
  "agents",
  "context",
] as const

/** Scope that owns a durable surface identity. */
export const DURABLE_SURFACE_SCOPES = ["global", "workspace", "session", "file"] as const

export type DurableSurfaceKind = (typeof DURABLE_SURFACE_KINDS)[number]
export type DurableSurfaceScope = (typeof DURABLE_SURFACE_SCOPES)[number]

export type SessionSurfaceKind = "chat" | "diff" | "todo" | "stats" | "agents" | "context"
export type WorkspaceSurfaceKind = "sessions" | "terminal" | "files" | "notes" | "intelgraph"

export type SurfaceURIInput =
  | { kind: SessionSurfaceKind; sessionID: string }
  | { kind: "sessions" | "files" | "notes" | "intelgraph" }
  | { kind: "terminal"; terminalID?: string }
  | { kind: "logs" }
  | { kind: "file"; path: string }

export type SurfaceURIRef =
  | { kind: SessionSurfaceKind; scope: "session"; sessionID: string; uri: string }
  | { kind: "sessions" | "files" | "notes" | "intelgraph"; scope: "workspace"; uri: string }
  | { kind: "terminal"; scope: "workspace"; terminalID?: string; uri: string }
  | { kind: "logs"; scope: "global"; uri: string }
  | { kind: "file"; scope: "file"; path: string; encodedPath: string; uri: string }

const WORKSPACE_SINGLETON_KINDS = new Set<"sessions" | "files" | "notes" | "intelgraph">([
  "sessions",
  "files",
  "notes",
  "intelgraph",
])
const SESSION_SCOPED_KINDS = new Set<SessionSurfaceKind>(["chat", "diff", "todo", "stats", "agents", "context"])
const NON_DURABLE_IDS = new Set([
  "review",
  "empty",
  "changes",
  "all",
  "terminal.toggle",
  "review.toggle",
  "fileTree.toggle",
  "session.new",
  "undo",
  "redo",
  "compact",
  "share",
  "unshare",
  "fork",
])

const stripQueryAndHash = (value: string) => {
  const query = value.indexOf("?")
  const hash = value.indexOf("#")
  if (query === -1 && hash === -1) return value
  if (query === -1) return value.slice(0, hash)
  if (hash === -1) return value.slice(0, query)
  return value.slice(0, Math.min(query, hash))
}

const decodeURIComponentSafe = (value: string) => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

const normalizeDecodedFilePath = (path: string) => decodeSurfaceFilePath(encodeSurfaceFilePath(path))

export const isDurableSurfaceKind = (value: string): value is DurableSurfaceKind =>
  (DURABLE_SURFACE_KINDS as readonly string[]).includes(value)

export const isDurableSurfaceScope = (value: string): value is DurableSurfaceScope =>
  (DURABLE_SURFACE_SCOPES as readonly string[]).includes(value)

/** File-path codec used by canonical `file://workspace/<path>` URIs. */
export const encodeSurfaceFilePath = (path: string) => encodeFilePath(path)

/** File-path decoder paired with `encodeSurfaceFilePath`. */
export const decodeSurfaceFilePath = (encodedPath: string) => decodeFilePath(encodedPath)

/** Converts a typed surface descriptor into a canonical durable URI string. */
export const serializeSurfaceURI = (input: SurfaceURIInput): string => {
  switch (input.kind) {
    case "chat":
    case "diff":
    case "todo":
    case "stats":
    case "agents":
    case "context":
      return `${input.kind}://session/${encodeURIComponent(input.sessionID)}`
    case "sessions":
    case "files":
    case "notes":
    case "intelgraph":
      return `${input.kind}://workspace`
    case "terminal":
      if (!input.terminalID) return "terminal://workspace"
      return `terminal://workspace/${encodeURIComponent(input.terminalID)}`
    case "logs":
      return "logs://global"
    case "file":
      return `file://workspace/${encodeSurfaceFilePath(input.path)}`
  }
}

/** Parses and normalizes a durable surface URI. Returns `undefined` for non-durable IDs. */
export const parseSurfaceURI = (input: string): SurfaceURIRef | undefined => {
  const trimmed = input.trim()
  if (!trimmed || NON_DURABLE_IDS.has(trimmed)) return

  const value = stripQueryAndHash(trimmed)

  const sessionMatch = value.match(/^(chat|diff|todo|stats|agents|context):\/\/session\/([^/]+)$/)
  if (sessionMatch) {
    const kind = sessionMatch[1] as SessionSurfaceKind
    if (!SESSION_SCOPED_KINDS.has(kind)) return
    const sessionID = decodeURIComponentSafe(sessionMatch[2]!)
    const uri = serializeSurfaceURI({ kind, sessionID })
    return {
      kind,
      scope: "session",
      sessionID,
      uri,
    }
  }

  const workspaceMatch = value.match(/^(sessions|files|notes|intelgraph):\/\/workspace$/)
  if (workspaceMatch) {
    const kind = workspaceMatch[1] as "sessions" | "files" | "notes" | "intelgraph"
    if (!WORKSPACE_SINGLETON_KINDS.has(kind)) return
    return {
      kind,
      scope: "workspace",
      uri: serializeSurfaceURI({ kind }),
    }
  }

  const terminalMatch = value.match(/^terminal:\/\/workspace(?:\/(.+))?$/)
  if (terminalMatch) {
    const terminalID = terminalMatch[1] ? decodeURIComponentSafe(terminalMatch[1]) : undefined
    return {
      kind: "terminal",
      scope: "workspace",
      terminalID,
      uri: serializeSurfaceURI({ kind: "terminal", terminalID }),
    }
  }

  if (value === "logs://global") {
    return {
      kind: "logs",
      scope: "global",
      uri: "logs://global",
    }
  }

  if (value.startsWith("file://workspace/")) {
    const encodedPath = value.slice("file://workspace/".length)
    if (!encodedPath) return
    const path = normalizeDecodedFilePath(decodeSurfaceFilePath(encodedPath))
    return {
      kind: "file",
      scope: "file",
      path,
      encodedPath: encodeSurfaceFilePath(path),
      uri: serializeSurfaceURI({ kind: "file", path }),
    }
  }

  const legacyChatMatch = value.match(/^chat:\/\/([^/]+)$/)
  if (legacyChatMatch) {
    const sessionID = decodeURIComponentSafe(legacyChatMatch[1]!)
    const uri = serializeSurfaceURI({ kind: "chat", sessionID })
    return {
      kind: "chat",
      scope: "session",
      sessionID,
      uri,
    }
  }

  if (value.startsWith("file://")) {
    const legacyPath = value.slice("file://".length)
    if (!legacyPath || legacyPath === "workspace") return
    const path = normalizeDecodedFilePath(decodeSurfaceFilePath(legacyPath))
    return {
      kind: "file",
      scope: "file",
      path,
      encodedPath: encodeSurfaceFilePath(path),
      uri: serializeSurfaceURI({ kind: "file", path }),
    }
  }
}

/** Returns a canonical URI string, or `undefined` for unsupported/non-durable IDs. */
export const normalizeSurfaceURI = (input: string): string | undefined => parseSurfaceURI(input)?.uri

/** Alias with conventional lower-camel acronym casing for callers. */
export const normalizeSurfaceUri = normalizeSurfaceURI
