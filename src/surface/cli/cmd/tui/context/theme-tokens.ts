import type { RGBA } from "@opentui/core"
import type { TuiThemeCurrent } from "@/foundation/vendor/plugin/tui"

/**
 * ThemeTokens — stable surface-layer contract for TUI theme properties.
 * Consumers import from this module, not from TuiThemeCurrent directly.
 * Construction (theme.tsx) maps TuiThemeCurrent → ThemeTokens.
 */
export interface ThemeTokens {
  // diff hunk rendering
  readonly diffHunkBg: RGBA
  readonly diffHunk: RGBA
  readonly diffLineNumberBg: RGBA
  // extend here as new tokens are added; TuiThemeCurrent is the upstream source
}

/**
 * extractThemeTokens — adapter from TuiThemeCurrent to ThemeTokens.
 * Isolates session renderer from vendor interface changes.
 */
export function extractThemeTokens(theme: TuiThemeCurrent): ThemeTokens {
  return {
    diffHunkBg: theme.diffHunkBg,
    diffHunk: theme.diffHunk,
    diffLineNumberBg: theme.diffLineNumberBg,
  }
}
