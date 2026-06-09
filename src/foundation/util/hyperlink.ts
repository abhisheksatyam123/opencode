// util/hyperlink.ts
//
// Terminal hyperlink helper using OSC 8 escape sequences (parity gap-29).
//
// PROVENANCE: inspired by Claude's `utils/hyperlink.ts` (40 LOC) but
// adapted to drop the `chalk` + `supports-hyperlinks` npm dependencies
// that opencode doesn't have. The OSC 8 escape sequence is taken from
// the same source — both Claude's port and this one use the BEL (\x07)
// terminator which has wider compatibility than ST (\x1b\\).
//
// PROTOCOL: OSC 8 lets a terminal render a clickable link with display
// text different from the URL. The escape sequence is:
//
//   \x1b]8;;<URL>\x07<TEXT>\x1b]8;;\x07
//
// Supported by: iTerm2, kitty, wezterm, ghostty, foot, mintty,
// VTE-based terminals (gnome-terminal, tilix), and modern Windows
// Terminal. Not supported by: macOS Terminal, plain xterm, tmux <3.0a
// (which strips OSC 8 by default).
//
// FALLBACK: when the terminal doesn't support hyperlinks, this helper
// returns the plain URL (or the display text + URL if both differ) so
// the output is still useful in any environment.
//
// USE CASES IN OPENCODE:
//   * `opencode debug outputs-scanner` — make file paths clickable
//   * `opencode debug ripgrep` — make search hits clickable
//   * Future: TUI message timestamps that link to log files, error
//     messages that link to source locations, etc.

const OSC8_START = "\x1b]8;;"
const OSC8_END = "\x07"

let cachedSupports: boolean | null = null

export namespace Hyperlink {
  /**
   * Detect whether the current terminal supports OSC 8 hyperlinks.
   *
   * Resolution order:
   *   1. `OPENCODE_FORCE_HYPERLINK=1` / `FORCE_HYPERLINK=1` env var → true
   *    2. `OPENCODE_DISABLE_HYPERLINK=1` / `NO_COLOR=1` env var → false
   *   3. stdout is not a TTY → false (piped output, file redirect)
   *   4. Known-supported terminal env vars set → true
   *      - `TERM_PROGRAM=iTerm.app|WezTerm|ghostty|vscode|warp.app`
   *      - `KITTY_WINDOW_ID` set (kitty)
   *      - `WEZTERM_PANE` set (wezterm — alternate signal)
   *      - `GHOSTTY_RESOURCES_DIR` set (ghostty — alternate signal)
   *      - `WT_SESSION` set (Windows Terminal)
   *      - `VTE_VERSION` >= 0500 (gnome-terminal, tilix, hyper)
   *      - `TERM_PROGRAM=mintty` or `TERM=xterm-mintty`
   *   5. Otherwise → false (conservative default)
   *
   * Cached for the process lifetime — env vars don't change at runtime.
   * Use `Hyperlink.clearCache()` in tests that override env per-case.
   */
  export function supports(): boolean {
    if (cachedSupports !== null) return cachedSupports
    cachedSupports = computeSupports()
    return cachedSupports
  }

  /**
   * Test-only: clear the support cache so the next `supports()` call
   * re-reads `process.env`. Tests that override env vars per-case
   * should call this in a `beforeEach`.
   */
  export function clearCache(): void {
    cachedSupports = null
  }

  /**
   * Wrap `text` (defaulting to `url`) in an OSC 8 hyperlink escape
   * sequence pointing at `url`. If the terminal doesn't support
   * hyperlinks, returns the plain text fallback (text + parenthetical
   * URL when they differ, just the URL when they match).
   *
   * @param url   The link target (file:// URL, https://, etc.)
   * @param text  Optional display text. Defaults to the URL itself.
   * @param opts  Optional `forceSupports` to override detection (used
   *              for testing or when the caller knows better).
   */
  export function create(url: string, text?: string, opts?: { forceSupports?: boolean }): string {
    const display = text ?? url
    const useHyperlinks = opts?.forceSupports ?? supports()
    if (!useHyperlinks) {
      // Plain-text fallback: when display differs from url, show
      // both so the user can copy-paste the link manually
      return display === url ? url : `${display} (${url})`
    }
    return `${OSC8_START}${url}${OSC8_END}${display}${OSC8_START}${OSC8_END}`
  }

  /**
   * Convenience wrapper that builds a `file://` URL from an absolute
   * path and wraps it as a clickable hyperlink. The display text is
   * the path itself (caller can override).
   *
   * Uses absolute paths because relative paths in `file://` URLs are
   * not portable across terminal implementations.
   *
   * Plain-text fallback: when the terminal doesn't support
   * hyperlinks, this returns just the display text (not the
   * `file://` URL) — file:// URLs aren't useful in unsupported
   * terminals because users can't click them. If the display text
   * differs from the absolute path, the path is appended in
   * parentheses so the user can copy-paste it.
   */
  export function file(absolutePath: string, displayText?: string): string {
    const display = displayText ?? absolutePath
    if (!supports()) {
      return display === absolutePath ? display : `${display} (${absolutePath})`
    }
    const url = `file://${absolutePath}`
    return `${OSC8_START}${url}${OSC8_END}${display}${OSC8_START}${OSC8_END}`
  }
}

function computeSupports(): boolean {
  const env = process.env
  // 1. Explicit force/disable
  if (env["OPENCODE_FORCE_HYPERLINK"] === "1" || env["FORCE_HYPERLINK"] === "1") return true
  if (env["OPENCODE_DISABLE_HYPERLINK"] === "1" || env["NO_COLOR"] === "1") return false
  // 2. stdout must be a TTY (not piped/redirected)
  if (!process.stdout.isTTY) return false
  // 3. Known-supported terminals
  const termProgram = env["TERM_PROGRAM"]
  if (
    termProgram === "iTerm.app" ||
    termProgram === "WezTerm" ||
    termProgram === "ghostty" ||
    termProgram === "vscode" ||
    termProgram === "warp.app" ||
    termProgram === "mintty"
  ) {
    return true
  }
  if (env["KITTY_WINDOW_ID"]) return true
  if (env["WEZTERM_PANE"]) return true
  if (env["GHOSTTY_RESOURCES_DIR"]) return true
  if (env["WT_SESSION"]) return true
  if (env["TERM"] === "xterm-mintty") return true
  // VTE-based: VTE_VERSION is a 4-digit number, ≥ 0500 supports OSC 8
  const vte = env["VTE_VERSION"]
  if (vte && /^\d+$/.test(vte) && parseInt(vte, 10) >= 500) return true
  // 4. Conservative default
  return false
}
