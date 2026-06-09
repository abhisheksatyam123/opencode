// util/notifier.ts
//
// Terminal notification dispatcher (parity gap-11).
//
// PROVENANCE: ported from
// `instructkr-claude-code/src/services/notifier.ts` (156 LOC) +
// `instructkr-claude-code/src/ink/useTerminalNotification.ts` (127 LOC).
// Claude Code's reference is split across an Ink-React hook (which
// emits raw escape sequences via a TerminalWriteContext) and a
// dispatcher service (which picks the channel based on user config
// + auto-detection). The opencode port collapses both into a pure
// namespace: each channel emits its escape sequence as a string, an
// auto-detector picks the channel from env vars, and a high-level
// `send()` writes to stdout/stderr.
//
// THE PROBLEM
// ===========
// opencode is a long-running CLI: agent loops can take minutes,
// permission requests can block waiting for the user, sessions can
// run while the user has switched away from the terminal. Without
// a notification mechanism, users miss state changes:
//   - Long agent run finished
//   - Permission request blocking
//   - An error needs attention
// Claude Code solved this with terminal escape sequences (no native
// bindings, no platform-specific notification daemon). opencode
// adopts the same pattern.
//
// THE FIX
// =======
// Terminal-level notifications via OSC (Operating System Command)
// escape sequences. Modern terminal emulators recognize these and
// surface them as native OS notifications:
//   - iTerm2 → macOS Notification Center
//   - Kitty → KDE/GNOME notification
//   - Ghostty → cross-platform via its notification protocol
//   - Generic → terminal bell (BEL char)
//
// All four channels are PURE ESCAPE SEQUENCES — no subprocess, no
// native binding, no daemon. The cost is one Buffer.write to the TTY.
//
// CHANNEL SELECTION
// =================
// `Notifier.detect()` reads env vars in priority order:
//   1. KITTY_WINDOW_ID → kitty
//   2. GHOSTTY_RESOURCES_DIR → ghostty
//   3. TERM_PROGRAM=iTerm.app → iterm2
//   4. fall back to terminal bell
//
// Callers can also force a channel by passing `channel:` to `send()`,
// or skip detection entirely with `channel: "none"` (no-op).
//
// MULTIPLEXER WRAPPING
// ====================
// Claude's reference wraps escape sequences in DCS passthrough so
// they survive tmux/screen. The opencode port adds the same wrap
// behind a `wrapForMultiplexer:` option (default false). Set to true
// when the caller knows it's running inside tmux/screen — opencode
// doesn't auto-detect because the wrap can interfere when NOT inside
// a multiplexer.
//
// USAGE
// =====
// ```ts
// // Auto-detect + write to stdout
// await Notifier.send({
//   message: "Build complete",
//   title: "opencode",
// })
//
// // Force a specific channel
// await Notifier.send({ message: "Heads up" }, { channel: "kitty" })
//
// // Generate the escape sequence without writing (for tests/buffers)
// const seq = Notifier.iterm2({ message: "hi", title: "opencode" })
// ```

import { Log } from "./log"

const log = Log.create({ service: "notifier" })

export namespace Notifier {
  /**
   * Escape character (0x1B). All OSC sequences start with ESC ].
   */
  const ESC = "\x1B"

  /**
   * Bell character (0x07). Used both as a standalone notification
   * (terminal bell) and as the OSC sequence terminator.
   */
  const BEL = "\x07"

  /**
   * String Terminator (ESC \). Alternative to BEL for OSC termination.
   * Some terminals prefer ST. opencode uses BEL for compatibility with
   * Claude's reference and the broadest set of terminals.
   */
  const ST = `${ESC}\\`

  /**
   * Channel identifiers. Each maps to a different terminal protocol.
   */
  export type Channel = "iterm2" | "kitty" | "ghostty" | "bell" | "none" | "auto"

  /**
   * The data a notification carries. `title` is optional for some
   * channels (iTerm2 + bell don't use it).
   */
  export interface Notification {
    message: string
    title?: string
  }

  /**
   * Options for `send()`. `channel` defaults to "auto" (uses detect()).
   * `wrapForMultiplexer` wraps the sequence in DCS passthrough for
   * tmux/screen — only set true when actually inside a multiplexer.
   * `write` is the sink — defaults to stdout, but tests pass a string
   * collector.
   */
  export interface SendOptions {
    channel?: Channel
    wrapForMultiplexer?: boolean
    write?: (data: string) => void
  }

  /**
   * Generate an OSC 9 sequence for iTerm2's notification protocol.
   * iTerm2 surfaces this as a macOS Notification Center entry.
   *
   * The body is `\n\n${displayString}` (matching Claude's reference)
   * because iTerm2 strips leading whitespace; the two newlines force
   * the title and message onto separate visual lines when both are
   * present.
   */
  export function iterm2(opts: Notification): string {
    const displayString = opts.title ? `${opts.title}:\n${opts.message}` : opts.message
    return `${ESC}]9;\n\n${displayString}${BEL}`
  }

  /**
   * Generate Kitty's OSC 99 notification protocol sequence.
   * Kitty's protocol requires THREE separate OSC commands per
   * notification: title, body, and a final command to focus/show.
   * The `id` parameter groups them — must be unique per notification.
   *
   * Returns the THREE commands concatenated as a single string so
   * `send()` can write them in one Buffer.write call.
   */
  export function kitty(opts: Notification & { id: number }): string {
    const title = opts.title ?? ""
    const titleSeq = `${ESC}]99;i=${opts.id}:d=0:p=title;${title}${BEL}`
    const bodySeq = `${ESC}]99;i=${opts.id}:p=body;${opts.message}${BEL}`
    const focusSeq = `${ESC}]99;i=${opts.id}:d=1:a=focus;${BEL}`
    return titleSeq + bodySeq + focusSeq
  }

  /**
   * Generate Ghostty's OSC 777 notification protocol sequence.
   * Ghostty uses `notify` as the operation, then title + message.
   */
  export function ghostty(opts: Notification): string {
    const title = opts.title ?? ""
    return `${ESC}]777;notify;${title};${opts.message}${BEL}`
  }

  /**
   * Generate the bell character. Triggers tmux's bell-action when
   * inside tmux (window flag), and the terminal's bell behavior
   * elsewhere. Some terminals beep, some flash, some do nothing.
   *
   * Notably this is NOT wrapped for multiplexers — wrapping would
   * make it opaque DCS payload and lose tmux's bell-action fallback.
   */
  export function bell(): string {
    return BEL
  }

  /**
   * DCS passthrough wrapper for tmux/screen. When opencode is
   * running inside tmux, OSC sequences need to be wrapped in
   * `ESC P tmux; ESC <inner> ESC \\` so tmux passes them through
   * to the outer terminal instead of swallowing them.
   *
   * Inside the wrap, every literal ESC must be doubled. We use
   * the simpler form that preserves the original escape ESC.
   *
   * NOT auto-applied — caller must opt in via SendOptions.wrapForMultiplexer.
   */
  export function wrapForMultiplexer(sequence: string): string {
    // tmux DCS passthrough: ESC P tmux; <escaped-inner> ESC \
    // Inner ESCs are doubled so tmux unescapes back to the original.
    return `${ESC}Ptmux;${sequence.replaceAll(ESC, ESC + ESC)}${ESC}\\`
  }

  /**
   * Auto-detect the best channel based on env vars. Priority order:
   *   1. KITTY_WINDOW_ID → kitty (most reliable: only Kitty sets this)
   *   2. GHOSTTY_RESOURCES_DIR → ghostty
   *   3. TERM_PROGRAM = iTerm.app → iterm2
   *   4. fall back to bell
   *
   * Returns "bell" rather than "none" so a caller who explicitly
   * asked for auto still gets *some* signal.
   */
  export function detect(env: NodeJS.ProcessEnv = process.env): Exclude<Channel, "auto" | "none"> {
    if (env.KITTY_WINDOW_ID) return "kitty"
    if (env.GHOSTTY_RESOURCES_DIR) return "ghostty"
    if (env.TERM_PROGRAM === "iTerm.app") return "iterm2"
    return "bell"
  }

  /**
   * Counter for Kitty notification ids. Each notification needs a
   * unique id so the THREE OSC 99 commands group correctly. Module-
   * scoped + monotonic — safer than Math.random() which could
   * collide.
   */
  let kittyIdCounter = 1

  function nextKittyId(): number {
    const id = kittyIdCounter
    kittyIdCounter += 1
    if (kittyIdCounter > 0x7fff_ffff) kittyIdCounter = 1 // wrap before INT32_MAX
    return id
  }

  /**
   * Test escape hatch: reset the kitty id counter. Tests should call
   * this in beforeEach to get predictable ids.
   */
  export function _resetKittyIdCounter(): void {
    kittyIdCounter = 1
  }

  /**
   * Generate a notification escape sequence for the given channel
   * WITHOUT writing it. Useful for buffering, testing, or piping
   * into another writer.
   *
   * Returns an empty string for `channel: "none"`. Resolves "auto"
   * via `detect()`.
   */
  export function generate(notif: Notification, channel: Channel = "auto"): string {
    const resolved = channel === "auto" ? detect() : channel
    switch (resolved) {
      case "iterm2":
        return iterm2(notif)
      case "kitty":
        return kitty({ ...notif, id: nextKittyId() })
      case "ghostty":
        return ghostty(notif)
      case "bell":
        return bell()
      case "none":
        return ""
    }
  }

  /**
   * Send a notification. Auto-detects the channel by default,
   * generates the escape sequence, optionally wraps it for tmux,
   * and writes it to stdout (or the caller-supplied write function).
   *
   * Errors during write are logged but never thrown — a failed
   * notification should never block the agent loop.
   */
  export function send(notif: Notification, opts: SendOptions = {}): void {
    const channel = opts.channel ?? "auto"
    let sequence = generate(notif, channel)
    if (sequence === "") return // "none" channel
    if (opts.wrapForMultiplexer) {
      sequence = wrapForMultiplexer(sequence)
    }
    try {
      const writer = opts.write ?? ((data: string) => process.stdout.write(data))
      writer(sequence)
    } catch (e) {
      log.info("notifier write failed", { error: (e as Error).message, channel })
    }
  }

  /**
   * Inspect what channel `auto` would select right now. Useful for
   * `opencode debug notifier` and for tests.
   */
  export function autoChannel(): Exclude<Channel, "auto" | "none"> {
    return detect()
  }
}
