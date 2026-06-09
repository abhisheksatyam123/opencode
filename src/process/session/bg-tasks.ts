import z from "zod"

export const BgKind = z.enum(["task", "bash-bg"])
export const BgTerminalStatus = z.enum([
  "ok",
  "error",
  "rate_limited",
  "killed",
  "aborted",
  "completed",
  "failed",
  "timeout",
])
export const BgTaskErrorKind = z.enum(["rate_limit", "abort", "subagent_error"])

export const BgRunningEntry = z.object({
  id: z.string(),
  kind: BgKind,
  startedAt: z.string(), // ISO
  elapsedMs: z.number(),
  label: z.string(),
  controls: z.string().optional(),
})
export type BgRunningEntry = z.infer<typeof BgRunningEntry>

export const BgCompletedEntry = z.object({
  id: z.string(),
  kind: BgKind,
  status: BgTerminalStatus,
  durationMs: z.number(),
  completedAt: z.string(), // ISO
  excerpt: z.string().max(1200),
  excerptTruncated: z.boolean(),
  fullVia: z.string(),
  resumableTaskId: z.string().optional(),
  errorKind: BgTaskErrorKind.optional(),
  model: z.string().optional(),
})
export type BgCompletedEntry = z.infer<typeof BgCompletedEntry>

export const BgDrained = z.object({
  count: z.number().int().nonnegative(),
  recentIds: z.array(z.string()).max(20),
})
export type BgDrained = z.infer<typeof BgDrained>

export const BgTasksSection = z.object({
  running: z.array(BgRunningEntry),
  newlyCompleted: z.array(BgCompletedEntry),
  drained: BgDrained,
})
export type BgTasksSection = z.infer<typeof BgTasksSection>

/**
 * Cursor interface for background registries.
 * Documents the intended contract that both backgroundRegistry (bash) and the
 * task cursor functions (task.ts) satisfy conceptually.
 * context-packet.ts depends on this interface as its intended abstraction, NOT
 * on the concrete tool-layer modules.
 * NOTE: This is aspirational — the task cursor is currently exposed as free
 * functions, not a class implementing this interface. See
 * context-packet.ts for the intended cursor-abstraction follow-up.
 * See: specification/contract/context-packet.md §Known layer tension
 */
export interface BgCursorRegistry {
  completedSince(ts: number): BgCompletedEntry[]
  markDelivered(ids: string[]): void
  readonly lastDeliveredAt: number
  resetCursor(): void
}

export const EXCERPT_BYTE_CAP = 800
export const NEWLY_COMPLETED_MAX = 5
export const DRAINED_RECENT_MAX = 20

// Excerpt helper — utf-8 byte-safe truncation
export function capExcerpt(raw: string): { excerpt: string; excerptTruncated: boolean } {
  const buf = Buffer.from(raw, "utf8")
  if (buf.byteLength <= EXCERPT_BYTE_CAP) return { excerpt: raw, excerptTruncated: false }
  // slice at byte boundary, then decode with replacement and strip trailing REPLACEMENT CHAR
  let slice = buf.subarray(0, EXCERPT_BYTE_CAP).toString("utf8")
  slice = slice.replace(/\uFFFD+$/, "")
  return { excerpt: slice, excerptTruncated: true }
}

// Pure builder — registries pass flat arrays, builder handles overflow
export function buildBgTasksSection(input: {
  running: BgRunningEntry[]
  completedSinceCursor: BgCompletedEntry[] // already sorted asc by completedAt
  alreadyDrainedIds: string[] // full drained id log, most-recent last
  alreadyDrainedCount: number // total count historically drained (pre-overflow)
}): BgTasksSection {
  const { running, completedSinceCursor, alreadyDrainedIds, alreadyDrainedCount } = input
  let newlyCompleted = completedSinceCursor
  let overflowIds: string[] = []
  if (newlyCompleted.length > NEWLY_COMPLETED_MAX) {
    const keep = newlyCompleted.slice(0, NEWLY_COMPLETED_MAX)
    overflowIds = newlyCompleted.slice(NEWLY_COMPLETED_MAX).map((e) => e.id)
    newlyCompleted = keep
  }
  const mergedRecent = [...alreadyDrainedIds, ...overflowIds]
  const recentIds = mergedRecent.slice(-DRAINED_RECENT_MAX)
  const drained: BgDrained = {
    count: alreadyDrainedCount + overflowIds.length,
    recentIds,
  }
  return { running, newlyCompleted, drained }
}
