// util/circular-buffer.ts
//
// Generic fixed-size circular buffer (parity gap-24).
//
// PROVENANCE: cp'd from
// `instructkr-claude-code/src/utils/CircularBuffer.ts`
// then adapted to opencode:
//
//   * the class body is UNCHANGED — it's a tiny pure data structure
//     that doesn't need adapting.
//   * exported under both the original `CircularBuffer<T>` class name
//     (for parity searches and direct cp from Claude code) AND the
//     `Buffer.Circular<T>` namespace alias to match opencode's
//     `Hash` / `Binary` / `Token` / `SecretScan` convention.
//
// USE CASES IN OPENCODE:
//   * Bounded debug log retention — keep the last N events in memory
//     without growing forever, useful for crash dumps and the TUI's
//     recent-activity panel.
//   * Recent tool-call history — the TUI dialog-subagent and the
//     halt-auditor stall detector both want a fixed-size sliding
//     window of recent calls.
//   * Per-session error window — when checking for "N consecutive
//     identical halts" the stall detector currently scans the full
//     message history. A 5-element ring would be O(1) instead of O(n).
//   * Bounded snapshot input for compaction triggers — the
//     proactive-overflow estimator only needs the most recent K
//     messages, not the full history.

/**
 * A fixed-size circular buffer that automatically evicts the oldest
 * items when the buffer is full. Useful for maintaining a rolling
 * window of data.
 */
export class CircularBuffer<T> {
  private buffer: T[]
  private head = 0
  private size = 0

  constructor(private capacity: number) {
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new RangeError("CircularBuffer capacity must be > 0")
    }
    this.capacity = Math.floor(capacity)
    this.buffer = new Array(this.capacity)
  }

  /**
   * Add an item to the buffer. If the buffer is full, the oldest
   * item is silently evicted.
   */
  add(item: T): void {
    this.buffer[this.head] = item
    this.head = (this.head + 1) % this.capacity
    if (this.size < this.capacity) {
      this.size++
    }
  }

  /**
   * Add multiple items to the buffer at once. Each item still goes
   * through the eviction rule, so adding more than `capacity` items
   * will end with only the last `capacity` survivors.
   */
  addAll(items: T[]): void {
    for (const item of items) {
      this.add(item)
    }
  }

  /**
   * Get the most recent N items from the buffer, in oldest-to-newest
   * order. Returns fewer items if the buffer contains less than N.
   */
  getRecent(count: number): readonly T[] {
    const result: T[] = []
    const start = this.size < this.capacity ? 0 : this.head
    const available = Math.min(count, this.size)

    for (let i = 0; i < available; i++) {
      const index = (start + this.size - available + i) % this.capacity
      result.push(this.buffer[index]!)
    }

    return result
  }

  /**
   * Get all items currently in the buffer, in order from oldest to
   * newest. After eviction this returns at most `capacity` items.
   */
  toArray(): readonly T[] {
    if (this.size === 0) return []

    const result: T[] = []
    const start = this.size < this.capacity ? 0 : this.head

    for (let i = 0; i < this.size; i++) {
      const index = (start + i) % this.capacity
      result.push(this.buffer[index]!)
    }

    return result
  }

  /**
   * Clear all items from the buffer. After clear() the buffer is in
   * its initial state — `length()` returns 0 and `getRecent(N)`
   * returns `[]`.
   */
  clear(): void {
    this.buffer.length = 0
    this.head = 0
    this.size = 0
  }

  /**
   * Current number of items in the buffer (0..capacity).
   */
  length(): number {
    return this.size
  }
}
