import * as fs from "fs/promises"
import * as path from "path"
import { log } from "@/tool/notes/logger"
import { Sleep } from "@/foundation/util/sleep"
// gap-error-followup-3: errorMessage centralizes the
// `err?.message ?? String(err)` boilerplate.
import { errorMessage } from "@/foundation/util/error"

// ---------------------------------------------------------------------------
// Sidecar `.lock` file with stale-detection.
//
// Used to serialize task-note writes across processes/sessions. Atomic
// creation via O_EXCL means two processes racing to acquire the same lock
// produce exactly one winner. The loser reads the existing file, decides
// whether it's stale (older than ttl_seconds), and either retries or waits.
//
// Lock file path: <notePath>.lock (e.g. project/task/todo-X.md.lock).
// Lock file content: JSON { pid, sessionID, agent, acquired_at, ttl_seconds }.
//
// Why a sidecar file instead of POSIX flock or optimistic versioning:
//   - Works on every filesystem (incl. NFS) — flock is unreliable on NFS
//   - Crash-resilient: stale-sweep recovers locks held by dead processes
//   - Visible on disk for debugging: `ls *.lock` shows what's held
//   - No filesystem lock semantics to debug
//
// The lock is task-note-specific. Other notes (atomic, project module) are
// protected by the existing Reservations system + low contention; they do
// not need this lock.
// ---------------------------------------------------------------------------

export const LOCK_TTL_SECONDS = 1800 // 30 minutes
const RETRY_BACKOFF_MS = 100
const MAX_RETRIES = 50 // 50 * 100ms = 5 seconds total wait

export interface LockMetadata {
  pid: number
  sessionID: string
  agent: string
  acquired_at: string // ISO date
  ttl_seconds: number
}

export interface LockHandle {
  lockPath: string
  metadata: LockMetadata
}

export class LockTimeoutError extends Error {
  constructor(
    public readonly holder: LockMetadata,
    lockPath: string,
  ) {
    super(
      `Lock timeout on ${lockPath}: held by pid=${holder.pid} session=${holder.sessionID} agent=${holder.agent} since ${holder.acquired_at}`,
    )
    this.name = "LockTimeoutError"
  }
}

export class LockCorruptError extends Error {
  constructor(lockPath: string, reason: string) {
    super(`Lock file ${lockPath} is corrupt or unreadable: ${reason}`)
    this.name = "LockCorruptError"
  }
}

function lockPathFor(notePath: string): string {
  return notePath + ".lock"
}

function isStale(meta: LockMetadata): boolean {
  const acquiredMs = Date.parse(meta.acquired_at)
  if (Number.isNaN(acquiredMs)) return true
  return Date.now() - acquiredMs > meta.ttl_seconds * 1000
}

async function readLockMetadata(lockPath: string): Promise<LockMetadata | undefined> {
  try {
    const text = await fs.readFile(lockPath, "utf-8")
    const parsed = JSON.parse(text)
    if (
      typeof parsed.pid === "number" &&
      typeof parsed.sessionID === "string" &&
      typeof parsed.agent === "string" &&
      typeof parsed.acquired_at === "string" &&
      typeof parsed.ttl_seconds === "number"
    ) {
      return parsed as LockMetadata
    }
    throw new LockCorruptError(lockPath, "missing required fields")
  } catch (err: any) {
    if (err?.code === "ENOENT") return undefined
    if (err instanceof LockCorruptError) throw err
    throw new LockCorruptError(lockPath, errorMessage(err))
  }
}

async function tryCreate(lockPath: string, meta: LockMetadata): Promise<boolean> {
  const handle = await fs.open(lockPath, "wx").catch((err: any) => {
    if (err?.code === "EEXIST") return undefined
    throw err
  })
  if (!handle) return false
  try {
    await handle.writeFile(JSON.stringify(meta, null, 2), "utf-8")
  } finally {
    await handle.close()
  }
  return true
}

// gap-26-followup-1: replaced with Sleep.until from util/sleep.ts.
// The previous private helper had no abort support; the new helper
// is called without a signal so behavior is preserved verbatim.
// `acquireLock` could grow a `signal` parameter in a future commit
// and pass it through here to gain abort support for free.
function sleep(ms: number): Promise<void> {
  return Sleep.until(ms)
}

/**
 * Acquire an exclusive lock on `notePath`. Atomic via O_EXCL. If the lock
 * is held by a stale process (older than ttl_seconds), it is removed and
 * the acquire is retried. If held by a live process, the acquire waits
 * with backoff up to MAX_RETRIES * RETRY_BACKOFF_MS, then throws
 * LockTimeoutError.
 *
 * Always pair with releaseLock() in a try/finally.
 */
export async function acquireLock(
  notePath: string,
  opts: { sessionID: string; agent: string; ttl_seconds?: number } = { sessionID: "", agent: "" },
): Promise<LockHandle> {
  const lockPath = lockPathFor(notePath)
  await fs.mkdir(path.dirname(lockPath), { recursive: true }).catch(() => {})

  const metadata: LockMetadata = {
    pid: process.pid,
    sessionID: opts.sessionID,
    agent: opts.agent,
    acquired_at: new Date().toISOString(),
    ttl_seconds: opts.ttl_seconds ?? LOCK_TTL_SECONDS,
  }

  for (let retry = 0; retry < MAX_RETRIES; retry++) {
    const created = await tryCreate(lockPath, metadata)
    if (created) {
      log.debug("file-lock acquired", { lockPath, sessionID: opts.sessionID, agent: opts.agent, retry })
      return { lockPath, metadata }
    }

    // Read holder and decide
    const holder = await readLockMetadata(lockPath).catch((err) => {
      log.warn("file-lock read failed during acquire", { lockPath, error: err?.message })
      return undefined
    })

    if (!holder) {
      // File vanished between EEXIST and read — retry immediately
      continue
    }

    if (isStale(holder)) {
      log.warn("file-lock sweeping stale lock", {
        lockPath,
        holder,
        ageSeconds: Math.floor((Date.now() - Date.parse(holder.acquired_at)) / 1000),
      })
      await fs.unlink(lockPath).catch(() => {})
      // retry immediately
      continue
    }

    // Live holder — wait and retry
    await sleep(RETRY_BACKOFF_MS)
  }

  // Final read of holder for error message
  const finalHolder = (await readLockMetadata(lockPath).catch(() => undefined)) ?? metadata
  throw new LockTimeoutError(finalHolder, lockPath)
}

/**
 * Release a previously acquired lock. Verifies the lock file still belongs
 * to us (pid + sessionID match) before unlinking. If a stale-sweep has
 * already taken over our lock, releaseLock logs a warning but does not
 * throw — the work is already lost on our side.
 */
export async function releaseLock(handle: LockHandle): Promise<void> {
  const current = await readLockMetadata(handle.lockPath).catch(() => undefined)
  if (!current) {
    log.warn("file-lock release: lock file already gone", { lockPath: handle.lockPath })
    return
  }
  if (current.pid !== handle.metadata.pid || current.sessionID !== handle.metadata.sessionID) {
    log.warn("file-lock release: lock taken over by someone else", {
      lockPath: handle.lockPath,
      ours: { pid: handle.metadata.pid, sessionID: handle.metadata.sessionID },
      theirs: { pid: current.pid, sessionID: current.sessionID },
    })
    return
  }
  await fs.unlink(handle.lockPath).catch((err: any) => {
    if (err?.code !== "ENOENT") throw err
  })
  log.debug("file-lock released", { lockPath: handle.lockPath })
}

/**
 * Wrap a write operation with acquire/release of the task-note lock.
 * The function is run while the lock is held; the lock is released in a
 * finally block so partial failures don't leak the lock.
 *
 * `notePath` must be the absolute filesystem path to the task note file
 * (not a logical doc-relative path).
 */
export async function withLock<T>(
  notePath: string,
  opts: { sessionID: string; agent: string; ttl_seconds?: number },
  fn: () => Promise<T>,
): Promise<T> {
  const handle = await acquireLock(notePath, opts)
  try {
    return await fn()
  } finally {
    await releaseLock(handle).catch((err) => {
      log.warn("file-lock release failed in withLock", { error: err?.message, lockPath: handle.lockPath })
    })
  }
}
