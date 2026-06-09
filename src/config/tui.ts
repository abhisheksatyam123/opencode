import { existsSync } from "fs"
import z from "zod"
import { mergeDeep, unique } from "remeda"
import { Config } from "@/config/config"
import { ConfigPaths } from "@/config/paths"
import { migrateTuiConfig } from "@/config/tui-migrate"
import { TuiInfo } from "@/config/tui-schema"
import { InstanceContextStorage } from "@/foundation/effect/instance-context"
import { Flag } from "@/foundation/flag/flag"
import { Log } from "@/foundation/util/log"
import { isRecord } from "@/foundation/util/record"
import { Global } from "@/filesystem/global"

export namespace TuiConfig {
  const log = Log.create({ service: "tui.config" })

  export const Info = TuiInfo

  type Acc = {
    result: Info
  }

  export type Info = z.output<typeof Info> & {
    // Internal resolved plugin list used by runtime loading.
    plugin_origins?: Config.PluginOrigin[]
  }

  function pluginScope(file: string): Config.PluginScope {
    if (InstanceContextStorage.containsPath(file)) return "local"
    return "global"
  }

  function customPath() {
    return Flag.OPENCODE_TUI_CONFIG
  }

  function normalize(raw: Record<string, unknown>) {
    const data = { ...raw }
    if (!("tui" in data)) return data
    if (!isRecord(data.tui)) {
      delete data.tui
      return data
    }

    const tui = data.tui
    delete data.tui
    return {
      ...tui,
      ...data,
    }
  }

  function installDeps(dir: string): Promise<void> {
    return Config.installDependencies(dir)
  }

  async function mergeFile(acc: Acc, file: string) {
    const data = await loadFile(file)
    acc.result = mergeDeep(acc.result, data)
    if (!data.plugin?.length) return

    const scope = pluginScope(file)
    const plugins = Config.deduplicatePluginOrigins([
      ...(acc.result.plugin_origins ?? []),
      ...data.plugin.map((spec) => ({ spec, scope, source: file })),
    ])
    acc.result.plugin = plugins.map((item) => item.spec)
    acc.result.plugin_origins = plugins
  }

  const states = new Map<string, Promise<{ config: Info; deps: Promise<void>[] }>>()

  function state() {
    const directory = InstanceContextStorage.directory
    let current = states.get(directory)
    if (current) return current
    current = (async () => {
      let projectFiles = Flag.OPENCODE_DISABLE_PROJECT_CONFIG
        ? []
        : await ConfigPaths.projectFiles("tui", InstanceContextStorage.directory, InstanceContextStorage.worktree)
      const directories = await ConfigPaths.directories(
        InstanceContextStorage.directory,
        InstanceContextStorage.worktree,
      )
      const configDirectories = unique(directories)
      const custom = customPath()
      const managed = Config.managedConfigDir()
      await migrateTuiConfig({ directories, custom, managed })
      // Re-compute after migration since migrateTuiConfig may have created new tui.json files
      projectFiles = Flag.OPENCODE_DISABLE_PROJECT_CONFIG
        ? []
        : await ConfigPaths.projectFiles("tui", InstanceContextStorage.directory, InstanceContextStorage.worktree)

      const acc: Acc = {
        result: {},
      }

      for (const file of ConfigPaths.fileInDirectory(Global.Path.config, "tui")) {
        await mergeFile(acc, file)
      }

      if (custom) {
        await mergeFile(acc, custom)
        log.debug("loaded custom tui config", { path: custom })
      }

      for (const file of projectFiles) {
        await mergeFile(acc, file)
      }

      for (const dir of configDirectories) {
        if (dir === Global.Path.config) continue
        for (const file of ConfigPaths.fileInDirectory(dir, "tui")) {
          await mergeFile(acc, file)
        }
      }

      if (existsSync(managed)) {
        for (const file of ConfigPaths.fileInDirectory(managed, "tui")) {
          await mergeFile(acc, file)
        }
      }

      const keybinds = { ...(acc.result.keybinds ?? {}) }
      if (process.platform === "win32") {
        // Native Windows terminals do not support POSIX suspend, so prefer prompt undo.
        keybinds.terminal_suspend = "none"
        keybinds.input_undo ??= unique([
          "ctrl+z",
          ...Config.Keybinds.shape.input_undo.parse(undefined).split(","),
        ]).join(",")
      }
      acc.result.keybinds = Config.Keybinds.parse(keybinds)

      const deps: Promise<void>[] = []
      if (acc.result.plugin?.length) {
        for (const dir of configDirectories) {
          deps.push(installDeps(dir))
        }
      }

      return {
        config: acc.result,
        deps,
      }
    })()
    states.set(directory, current)
    return current
  }

  export async function get() {
    return state().then((x) => x.config)
  }

  export async function waitForDependencies() {
    const deps = await state().then((x) => x.deps)
    await Promise.all(deps)
  }

  async function loadFile(filepath: string): Promise<Info> {
    const text = await ConfigPaths.readFile(filepath)
    if (!text) return {}
    return load(text, filepath).catch((error) => {
      log.warn("failed to load tui config", { path: filepath, error })
      return {}
    })
  }

  async function load(text: string, configFilepath: string): Promise<Info> {
    const raw = await ConfigPaths.parseText(text, configFilepath, "empty")
    if (!isRecord(raw)) return {}

    // Flatten a nested "tui" key so users who wrote `{ "tui": { ... } }` inside tui.json
    // (mirroring the old opencode.json shape) still get their settings applied.
    const normalized = normalize(raw)

    const parsed = Info.safeParse(normalized)
    if (!parsed.success) {
      log.warn("invalid tui config", { path: configFilepath, issues: parsed.error.issues })
      return {}
    }

    const data = parsed.data
    if (data.plugin) {
      for (let i = 0; i < data.plugin.length; i++) {
        data.plugin[i] = await Config.resolvePluginSpec(data.plugin[i], configFilepath)
      }
    }

    return data
  }
}
