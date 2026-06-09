import path from "path"
import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import z from "zod"
import { Global } from "@/filesystem/global"
import { TuiConfig } from "@/config/tui"
import { Glob } from "@/foundation/util/glob"
import { Filesystem } from "@/foundation/util/filesystem"
import { lazy } from "@/foundation/util/lazy"
import { DEFAULT_THEME_NAME, DEFAULT_THEMES, isThemeJson, type ThemeJson } from "@/surface/theme"

const ThemeResponse = z.object({
  selected: z.string(),
  themes: z.record(z.string(), z.any()),
})

export const ThemeRoutes = lazy(() =>
  new Hono().get(
    "/",
    describeRoute({
      summary: "List UI themes",
      description: "List TUI-compatible themes available to the UI, including custom vault etc/themes entries.",
      operationId: "theme.list",
      responses: {
        200: {
          description: "Available UI themes",
          content: {
            "application/json": {
              schema: resolver(ThemeResponse),
            },
          },
        },
      },
    }),
    async (c) => {
      const config = (await TuiConfig.get().catch(() => ({}))) as Partial<TuiConfig.Info>
      const themes = {
        ...DEFAULT_THEMES,
        ...(await getCustomThemes()),
      }
      const configured = typeof config.theme === "string" ? config.theme : DEFAULT_THEME_NAME
      const selected = themes[configured] ? configured : DEFAULT_THEME_NAME
      return c.json({ selected, themes })
    },
  ),
)

async function getCustomThemes() {
  const themesDir = path.join(Global.Path.config, "themes")
  const result: Record<string, ThemeJson> = {}
  for (const item of await Glob.scan("*.json", {
    cwd: themesDir,
    absolute: true,
    dot: true,
    symlink: true,
  })) {
    const theme = await Filesystem.readJson(item).catch(() => undefined)
    if (!isThemeJson(theme)) continue
    result[path.basename(item, ".json")] = theme
  }
  return result
}
