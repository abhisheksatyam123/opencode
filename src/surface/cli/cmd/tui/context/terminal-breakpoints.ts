export const TUI_BREAKPOINTS = {
  narrow: 80,
  wide: 120,
  sidebar: 42,
  contentPadding: 4,
} as const

export function isWideTerminal(width: number) {
  return width > TUI_BREAKPOINTS.wide
}

export function contentWidth(width: number, sidebarVisible: boolean) {
  return width - (sidebarVisible ? TUI_BREAKPOINTS.sidebar : 0) - TUI_BREAKPOINTS.contentPadding
}

export function shouldSplitDiff(width: number) {
  return width > TUI_BREAKPOINTS.wide
}
