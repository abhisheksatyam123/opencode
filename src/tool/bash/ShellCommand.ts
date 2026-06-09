import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import type { TaskOutput } from "@/tool/bash/TaskOutput"

type AnySpawner = {
  spawn: (command: unknown) => Effect.Effect<any, unknown, unknown>
}

export type ShellStatus = "idle" | "running" | "backgrounded" | "exited" | "killed" | "error"
export type Signal = "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP"

export interface ShellCommandOptions {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly shell?: string
  readonly timeoutMs: number
  readonly forceKillAfterMs: number
  readonly output: TaskOutput
  readonly mode: "pipe" | "disk"
  readonly watchdogMaxBytes?: number
  readonly abortSignal: AbortSignal
}

export class ShellCommandError extends Error {
  readonly _tag = "ShellCommandError"
  readonly kind: "spawn" | "kill" | "watchdog" | "invariant"
  override readonly cause?: unknown

  constructor(kind: "spawn" | "kill" | "watchdog" | "invariant", message: string, cause?: unknown) {
    super(message)
    this.kind = kind
    this.cause = cause
  }
}

export interface ShellExitInfo {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly reason: "exit" | "timeout" | "abort" | "backgrounded"
}

export interface ShellBackgroundHandle {
  readonly id: string
  readonly pid: number
  readonly outputPath: string
  readonly startedAt: number
  readonly kill: (signal: Signal) => Effect.Effect<void, ShellCommandError, never>
}

export class ShellCommandImpl {
  readonly id = randomUUID()
  #pid: number | undefined
  #status: ShellStatus = "idle"
  #child: ChildProcess | undefined
  #spawnerHandle: any
  #exitInfo: ShellExitInfo | undefined
  #listeners = new Set<(info: ShellExitInfo) => void>()
  #watchdogTimer: NodeJS.Timeout | undefined

  constructor(
    readonly opts: ShellCommandOptions,
    readonly spawner?: AnySpawner,
  ) {}

  get pid(): number | undefined {
    return this.#pid
  }

  get status(): ShellStatus {
    return this.#status
  }

  #emitExit(info: ShellExitInfo): void {
    this.#exitInfo = info
    this.#status = info.reason === "abort" ? "killed" : "exited"
    this.#stopWatchdog()
    for (const fn of this.#listeners) fn(info)
  }

  async #syncDiskSize(): Promise<number | undefined> {
    const disk = this.opts.output.persistenceHandle()
    if (!disk) return undefined
    const info = await disk.stat()
    this.opts.output.observeDiskSize(info.size)
    return info.size
  }

  async #enforceWatchdogLimit(max: number): Promise<void> {
    const out = this.opts.output.persistenceHandle()
    if (!out) return
    const { size } = await out.stat()
    this.opts.output.observeDiskSize(size)
    if (size <= max) return
    try {
      await out.rotate(max)
      const next = await out.stat()
      this.opts.output.observeDiskSize(next.size)
      if (next.size > max) {
        this.#child?.kill("SIGTERM")
      }
    } catch {
      this.#child?.kill("SIGTERM")
    }
  }

  #stopWatchdog(): void {
    if (!this.#watchdogTimer) return
    clearInterval(this.#watchdogTimer)
    this.#watchdogTimer = undefined
  }

  #startWatchdog(): void {
    this.#stopWatchdog()
    const max = this.opts.watchdogMaxBytes ?? 64 * 1024 * 1024
    this.#watchdogTimer = setInterval(() => {
      void this.#enforceWatchdogLimit(max).catch(() => {
        // best-effort watchdog
      })
    }, 500)
    this.#watchdogTimer.unref?.()
  }

  start(): Effect.Effect<void, ShellCommandError, never> {
    return Effect.tryPromise({
      try: async () => {
        if (this.opts.mode === "disk") {
          const out = this.opts.output.persistenceHandle()
          if (!out) throw new ShellCommandError("invariant", "Disk mode requires persistence handle")
          const child = spawn(this.opts.command, [...this.opts.args], {
            cwd: this.opts.cwd,
            env: this.opts.env,
            shell: this.opts.shell,
            detached: process.platform !== "win32",
            stdio: ["ignore", out.fd, out.fd],
            windowsHide: true,
          })
          this.#child = child
          this.#pid = child.pid
          this.#status = "running"
          this.#startWatchdog()
          child.once("exit", (code, signal) => {
            const max = this.opts.watchdogMaxBytes ?? 64 * 1024 * 1024
            void this.#enforceWatchdogLimit(max)
              .catch(() => {
                // best-effort final watchdog
              })
              .finally(() => {
                this.#stopWatchdog()
                this.#emitExit({ code, signal, reason: "exit" })
              })
          })
          return
        }

        const child = spawn(this.opts.command, [...this.opts.args], {
          cwd: this.opts.cwd,
          env: this.opts.env,
          shell: this.opts.shell,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        })

        this.#child = child
        this.#pid = child.pid
        this.#status = "running"
        this.opts.output.attach(child.stdout!, child.stderr!)
        child.once("exit", (code, signal) => this.#emitExit({ code, signal, reason: "exit" }))
      },
      catch: (cause) =>
        cause instanceof ShellCommandError ? cause : new ShellCommandError("spawn", "Failed command start", cause),
    })
  }

  awaitExit(): Effect.Effect<ShellExitInfo, ShellCommandError, never> {
    return Effect.promise(
      () =>
        new Promise<ShellExitInfo>((resolve) => {
          if (this.#exitInfo) {
            resolve(this.#exitInfo)
            return
          }

          const abortHandler = () => {
            const info: ShellExitInfo = { code: null, signal: null, reason: "abort" }
            this.#emitExit(info)
            resolve(info)
          }

          if (this.opts.abortSignal.aborted) {
            abortHandler()
            return
          }

          this.opts.abortSignal.addEventListener("abort", abortHandler, { once: true })
          const off = this.onExit((info) => {
            this.opts.abortSignal.removeEventListener("abort", abortHandler)
            off()
            resolve(info)
          })
        }),
    )
  }

  kill(signal: Signal): Effect.Effect<void, ShellCommandError, never> {
    return Effect.tryPromise({
      try: async () => {
        this.#status = "killed"
        if (this.#child?.pid) {
          if (process.platform === "win32") {
            spawn("taskkill", ["/pid", String(this.#child.pid), "/T", "/F"], { windowsHide: true })
          } else {
            process.kill(-this.#child.pid, signal)
          }
        }
      },
      catch: (cause) => new ShellCommandError("kill", "Failed killing command", cause),
    })
  }

  background(): Effect.Effect<ShellBackgroundHandle, ShellCommandError, never> {
    return Effect.try({
      try: () => {
        if (!this.#pid) throw new ShellCommandError("invariant", "Cannot background before start")
        this.#status = "backgrounded"
        const outputPath = this.opts.output.persistenceHandle()?.outputPath ?? ""
        return {
          id: this.id,
          pid: this.#pid,
          outputPath,
          startedAt: Date.now(),
          kill: (signal: Signal) => this.kill(signal),
        }
      },
      catch: (cause) =>
        cause instanceof ShellCommandError
          ? cause
          : new ShellCommandError("invariant", "Failed background transition", cause),
    })
  }

  cleanup(): Effect.Effect<void, ShellCommandError, never> {
    return Effect.tryPromise({
      try: async () => {
        this.#stopWatchdog()
        if (this.opts.mode === "disk") {
          await Effect.runPromise(this.opts.output.syncFromDisk())
        }
        await this.opts.output.persistenceHandle()?.close()
      },
      catch: (cause) => new ShellCommandError("invariant", "Cleanup failed", cause),
    })
  }

  onExit(handler: (info: ShellExitInfo) => void): () => void {
    this.#listeners.add(handler)
    return () => this.#listeners.delete(handler)
  }
}
