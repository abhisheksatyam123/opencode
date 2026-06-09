import type { SnapshotFileDiff, VcsFileDiff } from "@opencode-ai/sdk/v2"
import type { Message } from "@opencode-ai/sdk/v2/client"

type LegacyDiff = {
  file?: string
  path?: string
  patch?: string
  before?: string
  after?: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
}

type DiffLike = SnapshotFileDiff | VcsFileDiff | LegacyDiff
type Diff = DiffLike & {
  file: string
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function diff(value: unknown): value is Diff {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const file = "file" in value && typeof value.file === "string" ? value.file : undefined
  const path = "path" in value && typeof value.path === "string" ? value.path : undefined
  if (!file && !path) return false
  if (!("additions" in value) || typeof value.additions !== "number") return false
  if (!("deletions" in value) || typeof value.deletions !== "number") return false
  if ("patch" in value && value.patch !== undefined && typeof value.patch !== "string") return false
  if ("before" in value && value.before !== undefined && typeof value.before !== "string") return false
  if ("after" in value && value.after !== undefined && typeof value.after !== "string") return false
  if (!("status" in value) || value.status === undefined) return true
  return value.status === "added" || value.status === "deleted" || value.status === "modified"
}

function toDiff(value: unknown): Diff | undefined {
  if (!diff(value) || !object(value)) return
  const candidate = value as Record<string, unknown>
  const file =
    typeof candidate.file === "string"
      ? candidate.file
      : typeof candidate.path === "string"
        ? candidate.path
        : undefined
  if (!file) return
  const next: Record<string, unknown> = {
    ...candidate,
    file,
  }
  delete next.path
  return {
    ...(next as Diff),
  }
}

export function diffs(value: unknown): Diff[] {
  if (Array.isArray(value)) return value.map(toDiff).filter((item): item is Diff => !!item)
  const single = toDiff(value)
  if (single) return [single]
  if (!object(value)) return []
  return Object.values(value)
    .map(toDiff)
    .filter((item): item is Diff => !!item)
}

export function message(value: Message): Message {
  if (value.role !== "user") return value

  const raw = value.summary as unknown
  if (raw === undefined) return value
  if (!object(raw)) return { ...value, summary: undefined }

  const title = typeof raw.title === "string" ? raw.title : undefined
  const body = typeof raw.body === "string" ? raw.body : undefined
  const next = diffs(raw.diffs)

  if (title === raw.title && body === raw.body && next === raw.diffs) return value

  return {
    ...value,
    summary: {
      ...(title === undefined ? {} : { title }),
      ...(body === undefined ? {} : { body }),
      diffs: next,
    },
  }
}
