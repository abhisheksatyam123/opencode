import fs from "node:fs"
import path from "node:path"
import { mkdir, open, readFile, stat, truncate } from "node:fs/promises"

export interface DiskOutput {
  readonly outputPath: string
  readonly fd: number
  readonly bytesWritten: number

  appendString(text: string): Promise<void>
  stat(): Promise<{ size: number; mtimeMs: number }>
  tail(lines: number): Promise<readonly string[]>
  rotate(maxBytes: number): Promise<void>
  reopen(): Promise<void>
  close(): Promise<void>
}

export interface CreateDiskOutputOptions {
  readonly outputPath: string
  readonly createParents: boolean
  readonly rotateAtBytes: number
  readonly flags?: number
}

export class DiskOutputError extends Error {
  readonly _tag = "DiskOutputError"
  readonly kind: "open" | "write" | "rotate" | "close" | "stat" | "tail"
  override readonly cause?: unknown

  constructor(kind: "open" | "write" | "rotate" | "close" | "stat" | "tail", message: string, cause?: unknown) {
    super(message)
    this.kind = kind
    this.cause = cause
  }
}

class DiskOutputImpl implements DiskOutput {
  #fdHandle: Awaited<ReturnType<typeof open>>
  #bytesWritten = 0

  constructor(
    readonly outputPath: string,
    fdHandle: Awaited<ReturnType<typeof open>>,
    readonly rotateAtBytes: number,
    readonly flags: number,
  ) {
    this.#fdHandle = fdHandle
  }

  get fd(): number {
    return this.#fdHandle.fd
  }

  get bytesWritten(): number {
    return this.#bytesWritten
  }

  async appendString(text: string): Promise<void> {
    try {
      if (text.length === 0) return
      await this.#fdHandle.appendFile(text)
      this.#bytesWritten += Buffer.byteLength(text)
      if (this.#bytesWritten >= this.rotateAtBytes) {
        await this.rotate(this.rotateAtBytes)
      }
    } catch (cause) {
      throw new DiskOutputError("write", `Failed appending disk output ${this.outputPath}`, cause)
    }
  }

  async stat(): Promise<{ size: number; mtimeMs: number }> {
    try {
      const s = await stat(this.outputPath)
      return { size: s.size, mtimeMs: s.mtimeMs }
    } catch (cause) {
      throw new DiskOutputError("stat", `Failed stat ${this.outputPath}`, cause)
    }
  }

  async tail(lines: number): Promise<readonly string[]> {
    try {
      if (lines <= 0) return []
      const text = await readFile(this.outputPath, "utf8")
      const all = text.split(/\r?\n/)
      if (all.length > 0 && all[all.length - 1] === "") all.pop()
      return all.slice(-lines)
    } catch (cause) {
      throw new DiskOutputError("tail", `Failed tail ${this.outputPath}`, cause)
    }
  }

  async rotate(maxBytes: number): Promise<void> {
    try {
      const s = await stat(this.outputPath)
      if (s.size <= maxBytes) return
      await truncate(this.outputPath, maxBytes)
      const next = await stat(this.outputPath)
      this.#bytesWritten = next.size
    } catch (cause) {
      throw new DiskOutputError("rotate", `Failed rotate ${this.outputPath}`, cause)
    }
  }

  async reopen(): Promise<void> {
    try {
      await this.#fdHandle.close()
    } catch {
      // noop
    }
    this.#fdHandle = await open(this.outputPath, this.flags)
  }

  async close(): Promise<void> {
    try {
      await this.#fdHandle.close()
    } catch (cause) {
      throw new DiskOutputError("close", `Failed close ${this.outputPath}`, cause)
    }
  }
}

export async function createDiskOutput(opts: CreateDiskOutputOptions): Promise<DiskOutput> {
  const flags =
    opts.flags ?? fs.constants.O_APPEND | fs.constants.O_NOFOLLOW | fs.constants.O_CREAT | fs.constants.O_WRONLY

  try {
    if (opts.createParents) {
      await mkdir(path.dirname(opts.outputPath), { recursive: true })
    }
    const fd = await open(opts.outputPath, flags)
    return new DiskOutputImpl(opts.outputPath, fd, opts.rotateAtBytes, flags)
  } catch (cause) {
    throw new DiskOutputError("open", `Failed open disk output ${opts.outputPath}`, cause)
  }
}
