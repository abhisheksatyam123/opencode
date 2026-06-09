import path from "path"
import os from "os"
import { randomBytes, randomUUID } from "crypto"
import { mkdir, readFile, rm, stat, utimes, writeFile } from "fs/promises"
import { vaultPath } from "@/foundation/notes-root"
import { Hash } from "./hash"
import { Sleep } from "./sleep"

export namespace Flock {
  const root = path.join(vaultPath.state("global"), "locks")
  // Defaults for callers that do not provide timing options.
  const defaultOpts = {
    staleMs: 60_000,
    timeoutMs: 5 * 60_000,
    baseDelayMs: 100,
    maxDelayMs: 2_000,
  }

  export interface WaitEvent {
    key: string
    attempt: number
    delay: number
    waited: number
  }

  export type Wait = (input: WaitEvent) => void | Promise<void>

  export interface Options {
    dir?: string
    signal?: AbortSignal
    staleMs?: number
    timeoutMs?: number
    baseDelayMs?: number
    maxDelayMs?: number
    onWait?: Wait
  }

  type Opts = {
    staleMs: number
    timeoutMs: number
    baseDelayMs: number
    maxDelayMs: number
  }

  type Owned = {
    acquired: true
    startHeartbeat: (intervalMs?: number) => void
    release: () => Promise<void>
  }

  export interface Lease {
    release: () => Promise<void>
    [Symbol.asyncDispose]: () => Promise<void>
  }

  function code(err: unknown) {
    if (typeof err !== "object" || err === null || !("code" in err)) return
    const value = err.code
    if (typeof value !== "string") return
    return value
  }

  // gap-26-followup-1: replaced with Sleep.until from util/sleep.ts.
  // Behavior preserved EXACTLY: throws on abort with `signal.reason`
  // (or `Error("Aborted")` as fallback) so callers that catch the
  // abort error see the same shape as before.
  function sleep(ms: number, signal?: AbortSignal) {
    return Sleep.until(ms, signal, {
      abortError: () => signal?.reason ?? new Error("Aborted"),
    })
  }

  function jitter(ms: number) {
    const j = Math.floor(ms * 0.3)
    const d = Math.floor(Math.random() * (2 * j + 1)) - j
    return Math.max(0, ms + d)
  }

  function mono() {
    return performance.now()
  }

  function wall() {
    return performance.timeOrigin + mono()
  }

  async function stats(file: string) {
    try {
      return await stat(file)
    } catch (err) {
      const errCode = code(err)
      if (errCode === "ENOENT" || errCode === "ENOTDIR") return
      throw err
    }
  }

  async function stale(lockDir: string, heartbeatPath: string, metaPath: string, staleMs: number) {
    // Stale detection allows automatic recovery after crashed owners.
    const now = wall()
    const heartbeat = await stats(heartbeatPath)
    if (heartbeat) {
      return now - heartbeat.mtimeMs > staleMs
    }

    const meta = await stats(metaPath)
    if (meta) {
      return now - meta.mtimeMs > staleMs
    }

    const dir = await stats(lockDir)
    if (!dir) {
      return false
    }

    return now - dir.mtimeMs > staleMs
  }

  async function tryAcquireLockDir(lockDir: string, opts: Opts): Promise<Owned | { acquired: false }> {
    const token = randomUUID?.() ?? randomBytes(16).toString("hex")
    const metaPath = path.join(lockDir, "meta.json")
    const heartbeatPath = path.join(lockDir, "heartbeat")

    try {
      await mkdir(lockDir, { mode: 0o700 })
    } catch (err) {
      if (code(err) !== "EEXIST") {
        throw err
      }

      if (!(await stale(lockDir, heartbeatPath, metaPath, opts.staleMs))) {
        return { acquired: false }
      }

      const breakerPath = lockDir + ".breaker"
      try {
        await mkdir(breakerPath, { mode: 0o700 })
      } catch (claimErr) {
        const errCode = code(claimErr)
        if (errCode === "EEXIST") {
          const breaker = await stats(breakerPath)
          if (breaker && wall() - breaker.mtimeMs > opts.staleMs) {
            await rm(breakerPath, { recursive: true, force: true }).catch(() => undefined)
          }
          return { acquired: false }
        }

        if (errCode === "ENOENT" || errCode === "ENOTDIR") {
          return { acquired: false }
        }

        throw claimErr
      }

      try {
        // Breaker ownership ensures only one contender performs stale cleanup.
        if (!(await stale(lockDir, heartbeatPath, metaPath, opts.staleMs))) {
          return { acquired: false }
        }

        await rm(lockDir, { recursive: true, force: true })

        try {
          await mkdir(lockDir, { mode: 0o700 })
        } catch (retryErr) {
          const errCode = code(retryErr)
          if (errCode === "EEXIST" || errCode === "ENOTEMPTY") {
            return { acquired: false }
          }
          throw retryErr
        }
      } finally {
        await rm(breakerPath, { recursive: true, force: true }).catch(() => undefined)
      }
    }

    const meta = {
      token,
      pid: process.pid,
      hostname: os.hostname(),
      createdAt: new Date().toISOString(),
    }

    await writeFile(heartbeatPath, "", { flag: "wx" }).catch(async () => {
      await rm(lockDir, { recursive: true, force: true })
      throw new Error("Lock acquired but heartbeat already existed (possible compromise).")
    })

    await writeFile(metaPath, JSON.stringify(meta, null, 2), { flag: "wx" }).catch(async () => {
      await rm(lockDir, { recursive: true, force: true })
      throw new Error("Lock acquired but meta.json already existed (possible compromise).")
    })

    let timer: NodeJS.Timeout | undefined

    const startHeartbeat = (intervalMs = Math.max(100, Math.floor(opts.staleMs / 3))) => {
      if (timer) return
      // Heartbeat prevents long critical sections from being evicted as stale.
      timer = setInterval(() => {
        const t = new Date()
        void utimes(heartbeatPath, t, t).catch(() => undefined)
      }, intervalMs)
      timer.unref?.()
    }

    const release = async () => {
      if (timer) {
        clearInterval(timer)
        timer = undefined
      }

      const current = await readFile(metaPath, "utf8")
        .then((raw) => {
          const parsed = JSON.parse(raw)
          if (!parsed || typeof parsed !== "object") return {}
          return {
            token: "token" in parsed && typeof parsed.token === "string" ? parsed.token : undefined,
          }
        })
        .catch(async (err) => {
          const errCode = code(err)
          if (errCode === "ENOENT" || errCode === "ENOTDIR") {
            // If the parent locks directory itself is gone (e.g. test state-dir cleanup
            // in afterAll), the lock was externally cleaned up — return silently.
            // If only this specific lockDir is missing but the parent exists, the lock
            // was deliberately deleted while held — that is a genuine compromise.
            const parentGone = await stat(path.dirname(lockDir))
              .then(() => false)
              .catch(() => true)
            if (parentGone) return { token: undefined as string | undefined, alreadyGone: true }
            throw new Error("Refusing to release: lock is compromised (metadata missing).")
          }
          if (err instanceof SyntaxError) {
            throw new Error("Refusing to release: lock is compromised (metadata invalid).")
          }
          throw err
        })
      // State-dir was cleaned up externally (e.g. test afterAll) — lock already gone.
      if ("alreadyGone" in current && current.alreadyGone) return
      // Token check prevents deleting a lock that was re-acquired by another process.
      if (current.token !== token) {
        throw new Error("Refusing to release: lock token mismatch (not the owner).")
      }

      await rm(lockDir, { recursive: true, force: true })
    }

    return {
      acquired: true,
      startHeartbeat,
      release,
    }
  }

  async function acquireLockDir(
    lockDir: string,
    input: { key: string; onWait?: Wait; signal?: AbortSignal },
    opts: Opts,
  ) {
    const stop = mono() + opts.timeoutMs
    let attempt = 0
    let waited = 0
    let delay = opts.baseDelayMs

    while (true) {
      input.signal?.throwIfAborted()

      const res = await tryAcquireLockDir(lockDir, opts)
      if (res.acquired) {
        return res
      }

      if (mono() > stop) {
        throw new Error(`Timed out waiting for lock: ${input.key}`)
      }

      attempt += 1
      const ms = jitter(delay)
      await input.onWait?.({
        key: input.key,
        attempt,
        delay: ms,
        waited,
      })
      await sleep(ms, input.signal)
      waited += ms
      delay = Math.min(opts.maxDelayMs, Math.floor(delay * 1.7))
    }
  }

  export async function acquire(key: string, input: Options = {}): Promise<Lease> {
    input.signal?.throwIfAborted()
    const cfg: Opts = {
      staleMs: input.staleMs ?? defaultOpts.staleMs,
      timeoutMs: input.timeoutMs ?? defaultOpts.timeoutMs,
      baseDelayMs: input.baseDelayMs ?? defaultOpts.baseDelayMs,
      maxDelayMs: input.maxDelayMs ?? defaultOpts.maxDelayMs,
    }
    const dir = input.dir ?? root

    await mkdir(dir, { recursive: true })
    const lockfile = path.join(dir, Hash.fast(key) + ".lock")
    const lock = await acquireLockDir(
      lockfile,
      {
        key,
        onWait: input.onWait,
        signal: input.signal,
      },
      cfg,
    )
    lock.startHeartbeat()

    const release = () => lock.release()
    return {
      release,
      [Symbol.asyncDispose]() {
        return release()
      },
    }
  }

  export async function withLock<T>(key: string, fn: () => Promise<T>, input: Options = {}) {
    await using _ = await acquire(key, input)
    input.signal?.throwIfAborted()
    return await fn()
  }
}
