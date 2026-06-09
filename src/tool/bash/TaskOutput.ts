import { Effect } from "effect"
import { CircularBuffer } from "@/foundation/util/circular-buffer"
import { EndTruncatingAccumulator } from "@/tool/bash/accumulator"
import type { DiskOutput } from "@/tool/bash/diskOutput"

export interface TaskOutputPreview {
  readonly tailLines: readonly string[]
  readonly lineCountEstimate: number
  readonly byteCount: number
  readonly truncated: boolean
}

export interface TaskOutputSnapshot {
  readonly stdout: string
  readonly stderr: string
  readonly combined: string
  readonly byteCount: number
  readonly truncated: boolean
  readonly outputPath?: string
}

export type TaskOutputMode = "pipe" | "disk"

export class TaskOutputError extends Error {
  readonly _tag = "TaskOutputError"
  readonly kind: "spill" | "io" | "poller" | "invariant"
  override readonly cause?: unknown

  constructor(kind: "spill" | "io" | "poller" | "invariant", message: string, cause?: unknown) {
    super(message)
    this.kind = kind
    this.cause = cause
  }
}

export interface TaskOutputOptions {
  readonly previewTailLines: number
  readonly ringCapacity: number
  readonly accumulatorMaxBytes: number
  readonly pollerIntervalMs: number
  readonly diskFactory: (path: string) => Promise<DiskOutput>
}

export class TaskOutput {
  #mode: TaskOutputMode = "pipe"
  #stdout = new EndTruncatingAccumulator({ maxBytes: 8 * 1024 * 1024 })
  #stderr = new EndTruncatingAccumulator({ maxBytes: 8 * 1024 * 1024 })
  #combined: EndTruncatingAccumulator
  #lines: CircularBuffer<string>
  #poller: NodeJS.Timeout | undefined
  #disk: DiskOutput | undefined
  #diskObservedBytes = 0
  #diskTailLines: readonly string[] = []
  #diskLineCountEstimate = 0
  #diskTruncated = false

  constructor(readonly opts: TaskOutputOptions) {
    this.#combined = new EndTruncatingAccumulator({ maxBytes: opts.accumulatorMaxBytes })
    this.#lines = new CircularBuffer<string>(opts.ringCapacity)
  }

  get mode(): TaskOutputMode {
    return this.#mode
  }

  attach(stdout: NodeJS.ReadableStream, stderr: NodeJS.ReadableStream): void {
    if ("setEncoding" in stdout && typeof stdout.setEncoding === "function") stdout.setEncoding("utf8")
    if ("setEncoding" in stderr && typeof stderr.setEncoding === "function") stderr.setEncoding("utf8")
    stdout.on("data", (chunk) => this.write(chunk as Buffer | string, "stdout"))
    stderr.on("data", (chunk) => this.write(chunk as Buffer | string, "stderr"))
  }

  async attachDisk(outputPath: string): Promise<{ fd: number; diskOutput: DiskOutput }> {
    const disk = await this.opts.diskFactory(outputPath)
    this.#disk = disk
    this.#mode = "disk"
    return { fd: disk.fd, diskOutput: disk }
  }

  write(chunk: Buffer | string, stream: "stdout" | "stderr"): void {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk
    if (stream === "stdout") this.#stdout.append(text)
    else this.#stderr.append(text)
    this.#combined.append(text)

    const split = text.split(/\r?\n/)
    for (const line of split) {
      if (line.trim().length === 0) continue
      this.#lines.add(line)
    }

    if (this.#disk) {
      void this.#disk.appendString(text)
    }
  }

  switchToDisk(outputPath: string): Effect.Effect<DiskOutput, TaskOutputError, never> {
    return Effect.tryPromise({
      try: async () => {
        if (this.#disk) return this.#disk
        const disk = await this.opts.diskFactory(outputPath)
        const existing = this.#combined.getTailBytes().toString("utf8")
        if (existing.length > 0) {
          await disk.appendString(existing)
        }
        this.#disk = disk
        this.#mode = "disk"
        return disk
      },
      catch: (cause) => new TaskOutputError("spill", `Failed switching to disk mode ${outputPath}`, cause),
    })
  }

  getPreview(): TaskOutputPreview {
    if (this.#mode === "disk") {
      return {
        tailLines: this.#diskTailLines,
        lineCountEstimate: Math.max(this.#combined.getLineCount(), this.#diskLineCountEstimate),
        byteCount: this.#diskObservedBytes,
        truncated: this.#diskTruncated,
      }
    }

    const lines = this.#lines.getRecent(this.opts.previewTailLines)
    return {
      tailLines: lines,
      lineCountEstimate: this.#combined.getLineCount(),
      byteCount: this.#combined.getTailBytes().byteLength,
      truncated: this.#combined.truncated,
    }
  }

  getSnapshot(): TaskOutputSnapshot {
    const stdout = this.#stdout.getTailBytes().toString("utf8")
    const stderr = this.#stderr.getTailBytes().toString("utf8")
    const combined = this.#combined.getTailBytes().toString("utf8")
    return {
      stdout,
      stderr,
      combined,
      byteCount: this.#mode === "disk" ? this.#diskObservedBytes : this.#combined.byteCount,
      truncated: this.#mode === "disk" ? this.#diskTruncated : this.#combined.truncated,
      outputPath: this.#disk?.outputPath,
    }
  }

  observeDiskSize(bytes: number): void {
    if (this.#mode !== "disk") return
    const normalized = Number.isFinite(bytes) ? Math.max(0, Math.floor(bytes)) : 0
    this.#diskObservedBytes = Math.max(this.#diskObservedBytes, normalized)
    if (this.#diskObservedBytes > this.opts.accumulatorMaxBytes) {
      this.#diskTruncated = true
    }
  }

  syncFromDisk(): Effect.Effect<void, TaskOutputError, never> {
    const self = this
    return Effect.gen(function* () {
      if (!self.#disk) return
      const statInfo = yield* Effect.tryPromise({
        try: () => self.#disk!.stat(),
        catch: (cause) => new TaskOutputError("io", `Failed stat disk output ${self.#disk!.outputPath}`, cause),
      })
      self.observeDiskSize(statInfo.size)
      const tailLines = yield* Effect.tryPromise({
        try: () => self.#disk!.tail(self.opts.previewTailLines),
        catch: (cause) => new TaskOutputError("io", `Failed read disk tail ${self.#disk!.outputPath}`, cause),
      })
      self.#diskTailLines = tailLines
      self.#diskLineCountEstimate = Math.max(self.#diskLineCountEstimate, tailLines.length)
    })
  }

  startPoller(onTick: (preview: TaskOutputPreview) => void): Effect.Effect<void, TaskOutputError, never> {
    return Effect.sync(() => {
      if (this.#poller) {
        clearInterval(this.#poller)
        this.#poller = undefined
      }
      this.#poller = setInterval(() => {
        onTick(this.getPreview())
      }, this.opts.pollerIntervalMs)
      this.#poller.unref?.()
    }).pipe(Effect.mapError((cause) => new TaskOutputError("poller", "Failed starting poller", cause)))
  }

  stopPoller(): Effect.Effect<void, never, never> {
    return Effect.sync(() => {
      if (!this.#poller) return
      clearInterval(this.#poller)
      this.#poller = undefined
    })
  }

  finalize(opts: { persist: boolean }): Effect.Effect<TaskOutputSnapshot, TaskOutputError, never> {
    const self = this
    return Effect.gen(function* () {
      yield* self.stopPoller()
      if (opts.persist && self.#disk) {
        yield* Effect.tryPromise({
          try: () => self.#disk!.appendString(""),
          catch: (cause) => new TaskOutputError("io", "Failed flush disk output", cause),
        })
      }
      if (self.#mode === "disk" && opts.persist) {
        yield* self.syncFromDisk()
      }
      return self.getSnapshot()
    })
  }

  persistenceHandle(): DiskOutput | undefined {
    return this.#disk
  }
}
