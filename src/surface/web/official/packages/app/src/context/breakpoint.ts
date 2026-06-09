import { createMediaQuery } from "@solid-primitives/media"

export const BREAKPOINT_QUERY = {
  sm: "(min-width: 40rem)",
  md: "(min-width: 48rem)",
  lg: "(min-width: 64rem)",
  xl: "(min-width: 80rem)",
  "2xl": "(min-width: 96rem)",
  touch: "(hover: none) and (pointer: coarse)",
} as const

export function useBreakpoints() {
  const isSm = createMediaQuery(BREAKPOINT_QUERY.sm)
  const isMd = createMediaQuery(BREAKPOINT_QUERY.md)
  const isLg = createMediaQuery(BREAKPOINT_QUERY.lg)
  const isXl = createMediaQuery(BREAKPOINT_QUERY.xl)
  const is2Xl = createMediaQuery(BREAKPOINT_QUERY["2xl"])
  const isTouch = createMediaQuery(BREAKPOINT_QUERY.touch)

  return {
    isSm,
    isMd,
    isLg,
    isXl,
    is2Xl,
    isTouch,
    isMobile: () => !isSm(),
    isDesktop: isMd,
  } as const
}
