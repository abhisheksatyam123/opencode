// util/buffered-writer.ts
//
// Buffered write helper with size cap, byte cap, time-based flush,
// and deferred-flush overflow path (parity gap-50).
//
// PROVENANCE: ported from
// `instructkr-claude-code/src/utils/bufferedWriter.ts` (100 LOC).
// The Claude reference is a function-style factory returning a
// BufferedWriter object. The opencode port keeps the same shape but
// wraps it in a `BufferedWriter` namespace for consistency with the
// other util/* modules (Hash, Locale, Hyperlink, Notifier, etc.).
//
// THE PROBLEM
// ===========
// opencode has several places that emit a stream of small string
// writes — TUI render frames, log lines, partial token output, file
// snapshot diff fragments. Writing each one synchronously to its
// underlying sink (stdout, fd, network) is expensive: each write
// pays a syscall + optional fsync, and on a slow sink (errorLogSink
// appendFileSync) the caller blocks waiting for the write to land.
//
// Without batching, a tight render loop emitting 60 small writes per
// frame can stall the event loop for hundreds of milliseconds when
// the underlying sink is on a remote filesystem.
//
// THE FIX
// =======
// `BufferedWriter.create(opts)` returns a writer that:
//
//   1. Accumulates writes into an in-memory string array
//   2. Schedules a time-based flush via setTimeout (default 1000ms)
//   3. On reaching `maxBufferSize` items OR `maxBufferBytes` bytes,
//      DEFERS the flush via setImmediate so the caller never waits
//      on writeFn — the buffer is detached synchronously, then
//      written on the next event-loop tick
//   4. Coalesces overlapping deferred flushes so writes stay ordered
//
// `flush()` writes everything synchronously (used by dispose paths
// and explicit drain). `dispose()` is an alias.
//
// `immediateMode: true` bypasses buffering entirely — useful for
// tests that want to verify the underlying writeFn shape without
// reasoning about timer-based async.
//
// THE OVERFLOW DESIGN (deferred flush)
// ====================================
// The Claude reference's most subtle move: when the buffer hits its
// cap, instead of synchronously writing (which would stall the
// caller), it DETACHES the buffer to a `pendingOverflow` slot and
// schedules the actual write via `setImmediate`. The next call to
// write() either coalesces into the pending overflow (preserving
// order) or starts a fresh buffer.
//
// This means the caller's `writer.write(content)` call ALWAYS
// returns synchronously without ever blocking on writeFn. Critical
// for tight render loops + UI input handlers where pausing for an
// fsync would drop frames.
//
// `flush()` and `dispose()` honor pendingOverflow synchronously — if
// the process is exiting and a deferred flush is still queued, it
// drains immediately so no writes are lost.
//
// USAGE
// =====
// ```ts
// import { appendFileSync } from "fs"
//
// const writer = BufferedWriter.create({
//   writeFn: (content) => appendFileSync("/var/log/opencode.log", content),
//   flushIntervalMs: 500,
//   maxBufferSize: 50,
//   maxBufferBytes: 4096,
// })
//
// writer.write("line 1\n")
// writer.write("line 2\n")
// // ... lots more writes ...
// writer.flush()    // explicit drain
// writer.dispose()  // for cleanup paths
// ```
//
// THIS IS NOT
// ===========
// Not a stream wrapper. Doesn't implement Node's Writable interface.
// Doesn't backpressure. The "back-pressure" here is the cap on
// buffer size — once the cap fires, the deferred-flush detaches
// the buffer and the caller continues at full speed regardless of
// whether the underlying sink is keeping up. If the sink can't
// keep up at all, deferred writes pile up via setImmediate and
// the process eventually OOMs. Caller is responsible for picking
// caps that match the sink's drain rate.

export namespace BufferedWriter {
  /**
   * The sink function: takes accumulated content and writes it
   * somewhere. May be sync (e.g. fs.appendFileSync) or async (e.g.
   * fetch — the result is ignored, fire-and-forget).
   */
  export type WriteFn = (content: string) => void

  /**
   * Options for create(). All fields except writeFn are optional.
   */
  export interface Options {
    /**
     * The underlying sink function. Required.
     */
    writeFn: WriteFn

    /**
     * Milliseconds between time-based flushes. Default: 1000.
     * Set to a smaller number for low-latency UIs, larger for
     * background log batching.
     */
    flushIntervalMs?: number

    /**
     * Maximum number of buffered items before triggering a deferred
     * overflow flush. Default: 100. The buffer is an array of
     * strings, so each `write()` call is one item regardless of
     * the string length.
     */
    maxBufferSize?: number

    /**
     * Maximum total bytes (string length) buffered before triggering
     * a deferred overflow flush. Default: Infinity (no byte cap,
     * only the count cap fires).
     */
    maxBufferBytes?: number

    /**
     * If true, every `write()` call writes immediately + bypasses
     * all buffering. Useful for tests that want to verify the
     * underlying sink shape without reasoning about timer-based
     * async. Default: false.
     */
    immediateMode?: boolean
  }

  /**
   * The returned writer object. Shape matches Claude's reference
   * exactly so the API is portable.
   */
  export interface Writer {
    /**
     * Add content to the buffer. Schedules a time-based flush if
     * none is pending. Triggers a deferred overflow flush if either
     * cap is reached. Always returns synchronously without ever
     * blocking on writeFn.
     */
    write: (content: string) => void

    /**
     * Synchronously drain the buffer (and any pending overflow).
     * Used by tests, explicit drain points, and dispose paths.
     */
    flush: () => void

    /**
     * Alias for flush(). Provided for explicit-cleanup ergonomics
     * (matches Claude's reference shape).
     */
    dispose: () => void
  }

  /**
   * Create a new buffered writer.
   */
  export function create(opts: Options): Writer {
    const writeFn = opts.writeFn
    const flushIntervalMs = opts.flushIntervalMs ?? 1000
    const maxBufferSize = opts.maxBufferSize ?? 100
    const maxBufferBytes = opts.maxBufferBytes ?? Infinity
    const immediateMode = opts.immediateMode ?? false

    let buffer: string[] = []
    let bufferBytes = 0
    let flushTimer: ReturnType<typeof setTimeout> | null = null
    /**
     * Batch detached by overflow that hasn't been written yet.
     * Tracked so flush()/dispose() can drain it synchronously if
     * the process exits before the setImmediate fires.
     */
    let pendingOverflow: string[] | null = null

    function clearTimer(): void {
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
    }

    function flush(): void {
      // Clear the timer first — even if writeFn throws below, we must
      // not leave a stale timer that fires again with the same failing
      // writeFn and leaks the error into a later test or operation.
      clearTimer()
      // Drain any pending overflow first to preserve order.
      if (pendingOverflow) {
        writeFn(pendingOverflow.join(""))
        pendingOverflow = null
      }
      if (buffer.length === 0) return
      writeFn(buffer.join(""))
      buffer = []
      bufferBytes = 0
    }

    function scheduleFlush(): void {
      if (!flushTimer) {
        flushTimer = setTimeout(flush, flushIntervalMs)
      }
    }

    /**
     * Detach the buffer synchronously so the caller never waits on
     * writeFn. writeFn may block (e.g. errorLogSink.ts
     * appendFileSync) — if overflow fires mid-render or
     * mid-keystroke, deferring the write keeps the current tick
     * short. Timer-based flushes already run outside user code
     * paths so they stay synchronous.
     */
    function flushDeferred(): void {
      if (pendingOverflow) {
        // A previous overflow write is still queued. Coalesce into
        // it to preserve ordering — writes land in a single
        // setImmediate-ordered batch.
        pendingOverflow.push(...buffer)
        buffer = []
        bufferBytes = 0
        clearTimer()
        return
      }
      const detached = buffer
      buffer = []
      bufferBytes = 0
      clearTimer()
      pendingOverflow = detached
      setImmediate(() => {
        const toWrite = pendingOverflow
        pendingOverflow = null
        if (toWrite) writeFn(toWrite.join(""))
      })
    }

    return {
      write(content: string): void {
        if (immediateMode) {
          writeFn(content)
          return
        }
        buffer.push(content)
        bufferBytes += content.length
        scheduleFlush()
        if (buffer.length >= maxBufferSize || bufferBytes >= maxBufferBytes) {
          flushDeferred()
        }
      },
      flush,
      dispose(): void {
        flush()
      },
    }
  }
}
