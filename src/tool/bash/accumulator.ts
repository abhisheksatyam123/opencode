export interface EndTruncatingAccumulatorOptions {
  readonly maxBytes: number
  readonly encoding?: "utf8"
}

export class EndTruncatingAccumulator {
  readonly #maxBytes: number
  readonly #encoding: BufferEncoding
  #tail: Buffer = Buffer.alloc(0)
  #lineCount = 0
  #byteCount = 0
  #truncated = false

  constructor(opts: EndTruncatingAccumulatorOptions) {
    if (!Number.isFinite(opts.maxBytes) || opts.maxBytes <= 0) {
      throw new RangeError("EndTruncatingAccumulator maxBytes must be > 0")
    }
    this.#maxBytes = Math.floor(opts.maxBytes)
    this.#encoding = opts.encoding ?? "utf8"
  }

  get byteCount(): number {
    return this.#byteCount
  }

  get lineCount(): number {
    return this.#lineCount
  }

  get truncated(): boolean {
    return this.#truncated
  }

  append(chunk: Buffer | string): void {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, this.#encoding)
    this.#byteCount += buf.byteLength

    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 10) this.#lineCount++
    }

    let merged = this.#tail.length === 0 ? buf : Buffer.concat([this.#tail, buf])
    if (merged.byteLength > this.#maxBytes) {
      this.#truncated = true
      merged = merged.subarray(merged.byteLength - this.#maxBytes)
    }
    this.#tail = merged
  }

  getTail(n: number): readonly string[] {
    if (n <= 0 || this.#tail.length === 0) return []
    const text = this.#tail.toString(this.#encoding)
    const lines = text.split(/\r?\n/)
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
    return lines.slice(-n)
  }

  getTailBytes(): Buffer {
    return this.#tail
  }

  getLineCount(): number {
    return this.#lineCount
  }
}
