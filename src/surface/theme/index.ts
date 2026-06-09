import aura from "../cli/cmd/tui/context/theme/aura.json" with { type: "json" }
import ayu from "../cli/cmd/tui/context/theme/ayu.json" with { type: "json" }
import carbonfox from "../cli/cmd/tui/context/theme/carbonfox.json" with { type: "json" }
import catppuccin from "../cli/cmd/tui/context/theme/catppuccin.json" with { type: "json" }
import catppuccinFrappe from "../cli/cmd/tui/context/theme/catppuccin-frappe.json" with { type: "json" }
import catppuccinMacchiato from "../cli/cmd/tui/context/theme/catppuccin-macchiato.json" with { type: "json" }
import cobalt2 from "../cli/cmd/tui/context/theme/cobalt2.json" with { type: "json" }
import cursor from "../cli/cmd/tui/context/theme/cursor.json" with { type: "json" }
import dracula from "../cli/cmd/tui/context/theme/dracula.json" with { type: "json" }
import everforest from "../cli/cmd/tui/context/theme/everforest.json" with { type: "json" }
import flexoki from "../cli/cmd/tui/context/theme/flexoki.json" with { type: "json" }
import github from "../cli/cmd/tui/context/theme/github.json" with { type: "json" }
import gruvbox from "../cli/cmd/tui/context/theme/gruvbox.json" with { type: "json" }
import kanagawa from "../cli/cmd/tui/context/theme/kanagawa.json" with { type: "json" }
import lucentOrng from "../cli/cmd/tui/context/theme/lucent-orng.json" with { type: "json" }
import material from "../cli/cmd/tui/context/theme/material.json" with { type: "json" }
import matrix from "../cli/cmd/tui/context/theme/matrix.json" with { type: "json" }
import mercury from "../cli/cmd/tui/context/theme/mercury.json" with { type: "json" }
import monokai from "../cli/cmd/tui/context/theme/monokai.json" with { type: "json" }
import nightowl from "../cli/cmd/tui/context/theme/nightowl.json" with { type: "json" }
import nord from "../cli/cmd/tui/context/theme/nord.json" with { type: "json" }
import onedark from "../cli/cmd/tui/context/theme/one-dark.json" with { type: "json" }
import opencode from "../cli/cmd/tui/context/theme/opencode.json" with { type: "json" }
import orng from "../cli/cmd/tui/context/theme/orng.json" with { type: "json" }
import osakaJade from "../cli/cmd/tui/context/theme/osaka-jade.json" with { type: "json" }
import palenight from "../cli/cmd/tui/context/theme/palenight.json" with { type: "json" }
import rosepine from "../cli/cmd/tui/context/theme/rosepine.json" with { type: "json" }
import solarized from "../cli/cmd/tui/context/theme/solarized.json" with { type: "json" }
import synthwave84 from "../cli/cmd/tui/context/theme/synthwave84.json" with { type: "json" }
import tokyonight from "../cli/cmd/tui/context/theme/tokyonight.json" with { type: "json" }
import vercel from "../cli/cmd/tui/context/theme/vercel.json" with { type: "json" }
import vesper from "../cli/cmd/tui/context/theme/vesper.json" with { type: "json" }
import zenburn from "../cli/cmd/tui/context/theme/zenburn.json" with { type: "json" }

export type ThemeMode = "dark" | "light"
export type ThemeColorValue = string | number | { dark: ThemeColorValue; light: ThemeColorValue }
export type ThemeJson = {
  $schema?: string
  defs?: Record<string, ThemeColorValue>
  theme: Record<string, ThemeColorValue | undefined>
}
export type ResolvedTheme = Record<string, string>

export const DEFAULT_THEME_NAME = "opencode"

export const DEFAULT_THEMES: Record<string, ThemeJson> = {
  aura,
  ayu,
  catppuccin,
  ["catppuccin-frappe"]: catppuccinFrappe,
  ["catppuccin-macchiato"]: catppuccinMacchiato,
  cobalt2,
  cursor,
  dracula,
  everforest,
  flexoki,
  github,
  gruvbox,
  kanagawa,
  material,
  matrix,
  mercury,
  monokai,
  nightowl,
  nord,
  ["one-dark"]: onedark,
  ["osaka-jade"]: osakaJade,
  opencode,
  orng,
  ["lucent-orng"]: lucentOrng,
  palenight,
  rosepine,
  solarized,
  synthwave84,
  tokyonight,
  vesper,
  vercel,
  zenburn,
  carbonfox,
}

export function isThemeJson(value: unknown): value is ThemeJson {
  if (!value || typeof value !== "object") return false
  const theme = (value as { theme?: unknown }).theme
  return !!theme && typeof theme === "object" && !Array.isArray(theme)
}

export function resolveTheme(theme: ThemeJson, mode: ThemeMode): ResolvedTheme {
  const defs = theme.defs ?? {}

  function resolveColor(value: ThemeColorValue | undefined, chain: string[] = []): string {
    if (value === undefined) throw new Error("Theme color is undefined")
    if (typeof value === "number") return ansiToHex(value)
    if (typeof value === "string") {
      if (value === "transparent" || value === "none") return "rgba(0, 0, 0, 0)"
      if (value.startsWith("#")) return normalizeHex(value)
      if (chain.includes(value)) throw new Error(`Circular color reference: ${[...chain, value].join(" -> ")}`)

      const next = defs[value] ?? theme.theme[value]
      if (next === undefined) throw new Error(`Color reference "${value}" not found in defs or theme`)
      return resolveColor(next, [...chain, value])
    }
    return resolveColor(value[mode], chain)
  }

  return Object.fromEntries(
    Object.entries(theme.theme)
      .filter((entry): entry is [string, ThemeColorValue] => entry[1] !== undefined)
      .map(([key, value]) => [key, resolveColor(value)]),
  )
}

function normalizeHex(value: string) {
  if (/^#[0-9a-fA-F]{3}$/.test(value)) {
    return `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`.toLowerCase()
  }
  if (/^#[0-9a-fA-F]{4}$/.test(value)) {
    return `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}${value[4]}${value[4]}`.toLowerCase()
  }
  return value.toLowerCase()
}

function ansiToHex(code: number) {
  if (code < 16) {
    return (
      [
        "#000000",
        "#800000",
        "#008000",
        "#808000",
        "#000080",
        "#800080",
        "#008080",
        "#c0c0c0",
        "#808080",
        "#ff0000",
        "#00ff00",
        "#ffff00",
        "#0000ff",
        "#ff00ff",
        "#00ffff",
        "#ffffff",
      ][code] ?? "#000000"
    )
  }

  if (code < 232) {
    const index = code - 16
    const blue = index % 6
    const green = Math.floor(index / 6) % 6
    const red = Math.floor(index / 36)
    const value = (input: number) => (input === 0 ? 0 : input * 40 + 55)
    return rgbToHex(value(red), value(green), value(blue))
  }

  if (code < 256) {
    const gray = (code - 232) * 10 + 8
    return rgbToHex(gray, gray, gray)
  }

  return "#000000"
}

function rgbToHex(red: number, green: number, blue: number) {
  const hex = (value: number) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0")
  return `#${hex(red)}${hex(green)}${hex(blue)}`
}
