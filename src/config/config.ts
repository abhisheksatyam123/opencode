import { Log } from "@/foundation/util/log"
import path from "path"
import { pathToFileURL } from "url"
import os from "os"
import { Process } from "@/foundation/util/process"
import z from "zod"

import { mergeDeep, pipe, unique } from "remeda"
import { Global } from "@/filesystem/global"
import fsNode from "fs/promises"
import { NamedError } from "@opencode-ai/util/error"
import { Flag } from "@/foundation/flag/flag"
import { Auth } from "@/init/auth"
import { Env } from "@/filesystem/env"
import { applyEdits, modify, parse as parseJsonc, type ParseError as JsoncParseError } from "jsonc-parser"
import type { InstanceContext } from "@/foundation/effect/instance-context"
import { ConfigInstance } from "@/config/lifecycle"
import { Installation } from "@/init/installation"
import { ConfigMarkdown } from "@/config/markdown"
import { constants, existsSync } from "fs"
import { Bus, GlobalBus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { type PermissionMode } from "./types.ts"
import { Glob } from "@/foundation/util/glob"
import { iife } from "@/foundation/util/iife"
import { ConfigAccount } from "@/config/account-bridge"
import { isRecord } from "@/foundation/util/record"
import { ConfigPaths } from "@/config/paths"
import { Filesystem } from "@/foundation/util/filesystem"
import { hasHiddenSegment } from "@/foundation/util/path"
import { formatJsoncParseErrorMessage } from "@/foundation/util/jsonc"
import type { ConsoleState } from "@/config/console-state"
import { AppFileSystem } from "@/filesystem"
import { InstanceState } from "@/foundation/effect/instance-state"
import { makeRuntime } from "@/foundation/effect/run-service"
import { Duration, Effect, Layer, Option, ServiceMap } from "effect"
import { Flock } from "@/foundation/util/flock"
import { isPathPluginSpec, parsePluginSpecifier, resolvePathPluginTarget } from "@/init/npm/plugin-shared"
import { Npm } from "@/init/npm"

export namespace Config {
  const ModelId = z.string().meta({ $ref: "https://models.dev/model-schema.json#/$defs/Model" })
  const PluginOptions = z.record(z.string(), z.unknown())
  export const PluginSpec = z.union([z.string(), z.tuple([z.string(), PluginOptions])])

  export type PluginOptions = z.infer<typeof PluginOptions>
  export type PluginSpec = z.infer<typeof PluginSpec>
  export type PluginScope = "global" | "local"
  export type PluginOrigin = {
    spec: PluginSpec
    source: string
    scope: PluginScope
  }

  export const Event = {
    Error: BusEvent.define(
      "config.error",
      z.object({
        error: z.unknown(),
      }),
    ),
  }

  const log = Log.create({ service: "config" })

  function publishLoadError(message: string) {
    Bus.publish(Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
  }

  // Managed settings directory for enterprise deployments (highest priority, admin-controlled)
  // These settings override all user and project settings
  function systemManagedConfigDir(): string {
    switch (process.platform) {
      case "darwin":
        return "/Library/Application Support/opencode"
      case "win32":
        return path.join(process.env.ProgramData || "C:\\ProgramData", "opencode")
      default:
        return "/etc/opencode"
    }
  }

  export function managedConfigDir() {
    return process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR || systemManagedConfigDir()
  }

  const managedDir = managedConfigDir()

  const MANAGED_PLIST_DOMAIN = "ai.opencode.managed"

  // Keys injected by macOS/MDM into the managed plist that are not OpenCode config
  const PLIST_META = new Set([
    "PayloadDisplayName",
    "PayloadIdentifier",
    "PayloadType",
    "PayloadUUID",
    "PayloadVersion",
    "_manualProfile",
  ])

  /**
   * Parse raw JSON (from plutil conversion of a managed plist) into OpenCode config.
   * Strips MDM metadata keys before parsing through the config schema.
   * Pure function — no OS interaction, safe to unit test directly.
   */
  export function parseManagedPlist(json: string, source: string): Info {
    const raw = JSON.parse(json)
    for (const key of Object.keys(raw)) {
      if (PLIST_META.has(key)) delete raw[key]
    }
    return parseConfig(JSON.stringify(raw), source)
  }

  /**
   * Read macOS managed preferences deployed via .mobileconfig / MDM (Jamf, Kandji, etc).
   * MDM-installed profiles write to /Library/Managed Preferences/ which is only writable by root.
   * User-scoped plists are checked first, then machine-scoped.
   */
  async function readManagedPreferences(): Promise<Info> {
    if (process.platform !== "darwin") return {}

    const domain = MANAGED_PLIST_DOMAIN
    const user = os.userInfo().username
    const paths = [
      path.join("/Library/Managed Preferences", user, `${domain}.plist`),
      path.join("/Library/Managed Preferences", `${domain}.plist`),
    ]

    for (const plist of paths) {
      if (!existsSync(plist)) continue
      log.info("reading macOS managed preferences", { path: plist })
      const result = await Process.run(["plutil", "-convert", "json", "-o", "-", plist], { nothrow: true })
      if (result.code !== 0) {
        log.warn("failed to convert managed preferences plist", { path: plist })
        continue
      }
      return parseManagedPlist(result.stdout.toString(), `mobileconfig:${plist}`)
    }
    return {}
  }

  // Custom merge function that concatenates array fields instead of replacing them
  function mergeConfigConcatArrays(target: Info, source: Info): Info {
    const merged = mergeDeep(target, source)
    if (target.instructions && source.instructions) {
      merged.instructions = Array.from(new Set([...target.instructions, ...source.instructions]))
    }
    return merged
  }

  export type InstallInput = {
    signal?: AbortSignal
    waitTick?: (input: { dir: string; attempt: number; delay: number; waited: number }) => void | Promise<void>
  }

  export async function installDependencies(dir: string, input?: InstallInput) {
    if (!(await isWritable(dir))) return
    await using _ = await Flock.acquire(`config-install:${Filesystem.resolve(dir)}`, {
      signal: input?.signal,
      onWait: (tick) =>
        input?.waitTick?.({
          dir,
          attempt: tick.attempt,
          delay: tick.delay,
          waited: tick.waited,
        }),
    })
    input?.signal?.throwIfAborted()

    const pkg = path.join(dir, "package.json")
    const target = Installation.isLocal() ? "*" : Installation.VERSION
    const json = await Filesystem.readJson<{ dependencies?: Record<string, string> }>(pkg).catch(() => ({
      dependencies: {},
    }))
    json.dependencies = {
      ...json.dependencies,
      "@opencode-ai/plugin": target,
    }
    await Filesystem.writeJson(pkg, json)

    const gitignore = path.join(dir, ".gitignore")
    const ignore = await Filesystem.exists(gitignore)
    if (!ignore) {
      await Filesystem.write(
        gitignore,
        ["node_modules", "package.json", "package-lock.json", "bun.lock", ".gitignore"].join("\n"),
      )
    }
    await Npm.install(dir)
  }

  async function isWritable(dir: string) {
    try {
      await fsNode.access(dir, constants.W_OK)
      return true
    } catch {
      return false
    }
  }

  function rel(item: string, patterns: string[]) {
    const normalizedItem = item.replaceAll("\\", "/")
    for (const pattern of patterns) {
      const index = normalizedItem.indexOf(pattern)
      if (index === -1) continue
      return normalizedItem.slice(index + pattern.length)
    }
  }

  function trim(file: string) {
    const ext = path.extname(file)
    return ext.length ? file.slice(0, -ext.length) : file
  }

  async function loadCommand(dir: string) {
    const result: Record<string, Command> = {}
    for (const item of await Glob.scan("{command,commands}/**/*.md", {
      cwd: dir,
      absolute: true,
      dot: true,
      symlink: true,
    })) {
      const md = await ConfigMarkdown.parse(item).catch(async (err) => {
        const message = ConfigMarkdown.FrontmatterError.isInstance(err)
          ? err.data.message
          : `Failed to parse command ${item}`
        publishLoadError(message)
        log.error("failed to load command", { command: item, err })
        return undefined
      })
      if (!md) continue

      const patterns = ["/command/", "/commands/"]
      const file = rel(item, patterns) ?? path.basename(item)
      const name = trim(file)

      const config = {
        name,
        ...md.data,
        template: md.content.trim(),
      }
      const parsed = Command.safeParse(config)
      if (parsed.success) {
        result[config.name] = parsed.data
        continue
      }
      throw new InvalidError({ path: item, issues: parsed.error.issues }, { cause: parsed.error })
    }
    return result
  }

  async function loadPlugin(dir: string) {
    const plugins: PluginSpec[] = []

    for (const item of await Glob.scan("{plugin,plugins}/*.{ts,js}", {
      cwd: dir,
      absolute: true,
      dot: true,
      symlink: true,
    })) {
      plugins.push(pathToFileURL(item).href)
    }
    return plugins
  }

  export function pluginSpecifier(plugin: PluginSpec): string {
    return Array.isArray(plugin) ? plugin[0] : plugin
  }

  export function pluginOptions(plugin: PluginSpec): PluginOptions | undefined {
    return Array.isArray(plugin) ? plugin[1] : undefined
  }

  export async function resolvePluginSpec(plugin: PluginSpec, configFilepath: string): Promise<PluginSpec> {
    const spec = pluginSpecifier(plugin)
    if (!isPathPluginSpec(spec)) return plugin

    const base = path.dirname(configFilepath)
    const file = (() => {
      if (spec.startsWith("file://")) return spec
      if (path.isAbsolute(spec) || /^[A-Za-z]:[\\/]/.test(spec)) return pathToFileURL(spec).href
      return pathToFileURL(path.resolve(base, spec)).href
    })()

    const resolved = await resolvePathPluginTarget(file).catch(() => file)

    if (Array.isArray(plugin)) return [resolved, plugin[1]]
    return resolved
  }

  export function deduplicatePluginOrigins(plugins: PluginOrigin[]): PluginOrigin[] {
    const seen = new Set<string>()
    const list: PluginOrigin[] = []

    for (const plugin of plugins.toReversed()) {
      const spec = pluginSpecifier(plugin.spec)
      const name = spec.startsWith("file://") ? spec : parsePluginSpecifier(spec).pkg
      if (seen.has(name)) continue
      seen.add(name)
      list.push(plugin)
    }

    return list.toReversed()
  }

  export const McpLocal = z
    .object({
      type: z.literal("local").describe("Type of MCP server connection"),
      command: z.string().array().describe("Command and arguments to run the MCP server"),
      environment: z
        .record(z.string(), z.string())
        .optional()
        .describe("Environment variables to set when running the MCP server"),
      enabled: z.boolean().optional().describe("Enable or disable the MCP server on startup"),
      timeout: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Timeout in ms for MCP server requests. Defaults to 5000 (5 seconds) if not specified."),
    })
    .strict()
    .meta({
      ref: "McpLocalConfig",
    })

  export const McpOAuth = z
    .object({
      clientId: z
        .string()
        .optional()
        .describe("OAuth client ID. If not provided, dynamic client registration (RFC 7591) will be attempted."),
      clientSecret: z.string().optional().describe("OAuth client secret (if required by the authorization server)"),
      scope: z.string().optional().describe("OAuth scopes to request during authorization"),
    })
    .strict()
    .meta({
      ref: "McpOAuthConfig",
    })
  export type McpOAuth = z.infer<typeof McpOAuth>

  export const McpRemote = z
    .object({
      type: z.literal("remote").describe("Type of MCP server connection"),
      url: z.string().describe("URL of the remote MCP server"),
      enabled: z.boolean().optional().describe("Enable or disable the MCP server on startup"),
      headers: z.record(z.string(), z.string()).optional().describe("Headers to send with the request"),
      oauth: z
        .union([McpOAuth, z.literal(false)])
        .optional()
        .describe(
          "OAuth authentication configuration for the MCP server. Set to false to disable OAuth auto-detection.",
        ),
      timeout: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Timeout in ms for MCP server requests. Defaults to 5000 (5 seconds) if not specified."),
    })
    .strict()
    .meta({
      ref: "McpRemoteConfig",
    })

  export const Mcp = z.discriminatedUnion("type", [McpLocal, McpRemote])
  export type Mcp = z.infer<typeof Mcp>

  export const PermissionAction = z.enum(["ask", "allow", "deny"]).meta({
    ref: "PermissionActionConfig",
  })
  export type PermissionAction = z.infer<typeof PermissionAction>

  export const PermissionObject = z.record(z.string(), PermissionAction).meta({
    ref: "PermissionObjectConfig",
  })
  export type PermissionObject = z.infer<typeof PermissionObject>

  export const PermissionRule = z.union([PermissionAction, PermissionObject]).meta({
    ref: "PermissionRuleConfig",
  })
  export type PermissionRule = z.infer<typeof PermissionRule>

  // Capture original key order before zod reorders, then rebuild in original order
  const permissionPreprocess = (val: unknown) => {
    if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      return { __originalKeys: Object.keys(val), ...val }
    }
    return val
  }

  const permissionTransform = (x: unknown): Record<string, PermissionRule> => {
    if (typeof x === "string") return { "*": x as PermissionAction }
    const obj = x as { __originalKeys?: string[] } & Record<string, unknown>
    const { __originalKeys, ...rest } = obj
    if (!__originalKeys) return rest as Record<string, PermissionRule>
    const result: Record<string, PermissionRule> = {}
    for (const key of __originalKeys) {
      if (key in rest) result[key] = rest[key] as PermissionRule
    }
    return result
  }

  export const Permission = z
    .preprocess(
      permissionPreprocess,
      z
        .object({
          __originalKeys: z.string().array().optional(),
          bash: PermissionRule.optional(),
          task: PermissionRule.optional(),
          external_directory: PermissionRule.optional(),
          todo: PermissionAction.optional(),
          doom_loop: PermissionAction.optional(),
          skill: PermissionRule.optional(),
        })
        .catchall(PermissionRule)
        .or(PermissionAction),
    )
    .transform(permissionTransform)
    .meta({
      ref: "PermissionConfig",
    })
  export type Permission = z.infer<typeof Permission>

  export const Command = z.object({
    template: z.string(),
    description: z.string().optional(),
    agent: z.string().optional(),
    model: ModelId.optional(),
    subtask: z.boolean().optional(),
  })
  export type Command = z.infer<typeof Command>

  export const Skills = z.object({
    paths: z.array(z.string()).optional().describe("Additional paths to skill folders"),
    urls: z
      .array(z.string())
      .optional()
      .describe("URLs to fetch skills from (e.g., https://example.com/.well-known/skills/)"),
  })
  export type Skills = z.infer<typeof Skills>

  // Federation manifest contract — Stage 6 of file-loaded-os roadmap.
  // See specification/contract/federation-manifest. Generalises cfg.skills.urls
  // into cfg.federation.<kind>.urls so remote vaults can publish agent / skill /
  // command / policy / workflow cards. cfg.skills.urls remains accepted as a
  // back-compat alias for cfg.federation.skill.urls (merged at consumer time).
  export const FederationKindConfig = z
    .object({
      urls: z.array(z.string()).optional().describe("Index.json URLs for this kind"),
      disabled: z
        .array(z.string())
        .optional()
        .describe("source_id values to disable; useful for temporarily ignoring a federation source"),
      permission_cap: Permission.optional().describe(
        "Mask cap intersected with each federated card's permissionConfig before merge.",
      ),
    })
    .partial()
  export type FederationKindConfig = z.infer<typeof FederationKindConfig>

  export const FederationTrustEntry = z.object({
    publisher: z.string().optional().describe("Human-readable publisher name"),
    added_at: z.string().optional().describe("ISO date string for audit"),
  })
  export type FederationTrustEntry = z.infer<typeof FederationTrustEntry>

  export const Federation = z
    .object({
      agent: FederationKindConfig.optional(),
      skill: FederationKindConfig.optional(),
      command: FederationKindConfig.optional(),
      policy: FederationKindConfig.optional(),
      workflow: FederationKindConfig.optional(),
      trust: z
        .record(z.string(), FederationTrustEntry)
        .optional()
        .describe("Pinned ed25519 keys keyed by 'ed25519/<base64-32-bytes>'"),
      tofu: z
        .boolean()
        .optional()
        .describe(
          "Trust-on-first-use: dev-only opt-in to auto-pin keys on first manifest. Default false (rejects unknown keys).",
        ),
      allow_downgrade: z
        .boolean()
        .optional()
        .describe("Allow manifests with version lower than the cached version. Default false."),
    })
    .partial()
  export type Federation = z.infer<typeof Federation>

  export const Agent = z
    .object({
      temperature: z.number().optional(),
      top_p: z.number().optional(),
      prompt: z.string().optional(),
      tools: z
        .record(z.string(), z.boolean())
        .optional()
        .describe(
          "@deprecated Compatibility alias for 'permission'; migrated during AgentConfig transform and removable after legacy agent configs are no longer supported.",
        ),
      disable: z.boolean().optional(),
      description: z.string().optional().describe("Description of when to use the agent"),
      mode: z.enum(["subagent", "primary", "all"]).optional(),
      hidden: z
        .boolean()
        .optional()
        .describe("Hide this subagent from the @ autocomplete menu (default: false, only applies to mode: subagent)"),
      options: z.record(z.string(), z.any()).optional(),
      color: z
        .union([
          z.string().regex(/^#[0-9a-fA-F]{6}$/, "Invalid hex color format"),
          z.enum(["primary", "secondary", "accent", "success", "warning", "error", "info"]),
        ])
        .optional()
        .describe("Hex color code (e.g., #FF5733) or theme color (e.g., primary)"),
      steps: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum number of agentic iterations before forcing text-only response"),
      maxSteps: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "@deprecated Compatibility alias for 'steps'; migrated during AgentConfig transform and removable after legacy agent configs are no longer supported.",
        ),
      permission: Permission.optional(),
    })
    .catchall(z.any())
    .transform((agent, ctx) => {
      const knownKeys = new Set([
        "name",
        "prompt",
        "description",
        "temperature",
        "top_p",
        "mode",
        "hidden",
        "color",
        "steps",
        "maxSteps",
        "options",
        "permission",
        "disable",
        "tools",
      ])

      // Extract unknown properties into options
      const options: Record<string, unknown> = { ...agent.options }
      for (const [key, value] of Object.entries(agent)) {
        if (!knownKeys.has(key)) options[key] = value
      }

      // Convert legacy tools config to same-name permissions.
      const permission: Permission = {}
      for (const [tool, enabled] of Object.entries(agent.tools ?? {})) {
        permission[tool] = enabled ? "allow" : "deny"
      }
      Object.assign(permission, agent.permission)

      // Convert legacy maxSteps to steps
      const steps = agent.steps ?? agent.maxSteps

      return { ...agent, options, permission, steps } as typeof agent & {
        options?: Record<string, unknown>
        permission?: Permission
        steps?: number
      }
    })
    .meta({
      ref: "AgentConfig",
    })
  export type Agent = z.infer<typeof Agent>

  export const Keybinds = z
    .object({
      leader: z.string().optional().default("ctrl+x").describe("Leader key for keybind combinations"),
      app_exit: z.string().optional().default("ctrl+c,ctrl+d,<leader>q").describe("Exit the application"),
      editor_open: z.string().optional().default("<leader>e").describe("Open external editor"),
      theme_list: z.string().optional().default("<leader>t").describe("List available themes"),
      sidebar_toggle: z.string().optional().default("<leader>b").describe("Deprecated: sidebar panel has been removed"),
      scrollbar_toggle: z.string().optional().default("none").describe("Toggle session scrollbar"),
      username_toggle: z.string().optional().default("none").describe("Toggle username visibility"),
      status_view: z.string().optional().default("<leader>s").describe("View status"),
      session_export: z.string().optional().default("<leader>x").describe("Export session to editor"),
      session_new: z.string().optional().default("<leader>n").describe("Create a new session"),
      session_list: z.string().optional().default("<leader>l").describe("List all sessions"),
      session_timeline: z.string().optional().default("<leader>g").describe("Show session timeline"),
      session_fork: z.string().optional().default("none").describe("Fork session from message"),
      session_rename: z.string().optional().default("ctrl+r").describe("Rename session"),
      session_delete: z.string().optional().default("ctrl+d").describe("Delete session"),
      stash_delete: z.string().optional().default("ctrl+d").describe("Delete stash entry"),
      model_provider_list: z.string().optional().default("ctrl+a").describe("Open provider list from model dialog"),
      model_favorite_toggle: z.string().optional().default("ctrl+f").describe("Toggle model favorite status"),
      session_share: z.string().optional().default("none").describe("Share current session"),
      session_unshare: z.string().optional().default("none").describe("Unshare current session"),
      session_interrupt: z.string().optional().default("escape").describe("Interrupt current session"),
      session_compact: z.string().optional().default("<leader>c").describe("Compact the session"),
      messages_page_up: z.string().optional().default("pageup,ctrl+alt+b").describe("Scroll messages up by one page"),
      messages_page_down: z
        .string()
        .optional()
        .default("pagedown,ctrl+alt+f")
        .describe("Scroll messages down by one page"),
      messages_line_up: z.string().optional().default("ctrl+alt+y").describe("Scroll messages up by one line"),
      messages_line_down: z.string().optional().default("ctrl+alt+e").describe("Scroll messages down by one line"),
      messages_half_page_up: z.string().optional().default("ctrl+alt+u").describe("Scroll messages up by half page"),
      messages_half_page_down: z
        .string()
        .optional()
        .default("ctrl+alt+d")
        .describe("Scroll messages down by half page"),
      messages_first: z.string().optional().default("ctrl+g,home").describe("Navigate to first message"),
      messages_last: z.string().optional().default("ctrl+alt+g,end").describe("Navigate to last message"),
      messages_next: z.string().optional().default("none").describe("Navigate to next message"),
      messages_previous: z.string().optional().default("none").describe("Navigate to previous message"),
      messages_last_user: z.string().optional().default("none").describe("Navigate to last user message"),
      messages_copy: z.string().optional().default("<leader>y").describe("Copy message"),
      messages_undo: z.string().optional().default("<leader>u").describe("Undo message"),
      messages_redo: z.string().optional().default("<leader>r").describe("Redo message"),
      messages_toggle_conceal: z
        .string()
        .optional()
        .default("<leader>h")
        .describe("Toggle code block concealment in messages"),
      tool_details: z.string().optional().default("none").describe("Toggle tool details visibility"),
      todo_edit_file: z
        .string()
        .optional()
        .default("ctrl+e")
        .describe("Open active todo file in nvim (todo view only)"),
      model_list: z.string().optional().default("<leader>m").describe("List available models"),
      model_cycle_recent: z.string().optional().default("f2").describe("Next recently used model"),
      model_cycle_recent_reverse: z.string().optional().default("shift+f2").describe("Previous recently used model"),
      model_cycle_favorite: z.string().optional().default("none").describe("Next favorite model"),
      model_cycle_favorite_reverse: z.string().optional().default("none").describe("Previous favorite model"),
      command_list: z.string().optional().default("ctrl+p").describe("List available commands"),
      agent_list: z.string().optional().default("<leader>a").describe("List agents"),
      agent_cycle: z.string().optional().default("tab").describe("Next agent"),
      agent_cycle_reverse: z.string().optional().default("shift+tab").describe("Previous agent"),
      variant_cycle: z.string().optional().default("ctrl+t").describe("Cycle model variants"),
      input_clear: z.string().optional().default("ctrl+c").describe("Clear input field"),
      input_paste: z.string().optional().default("ctrl+v").describe("Paste from clipboard"),
      input_submit: z.string().optional().default("return").describe("Submit input"),
      input_newline: z
        .string()
        .optional()
        .default("shift+return,ctrl+return,alt+return,ctrl+j")
        .describe("Insert newline in input"),
      input_move_left: z.string().optional().default("left,ctrl+b").describe("Move cursor left in input"),
      input_move_right: z.string().optional().default("right,ctrl+f").describe("Move cursor right in input"),
      input_move_up: z.string().optional().default("up").describe("Move cursor up in input"),
      input_move_down: z.string().optional().default("down").describe("Move cursor down in input"),
      input_select_left: z.string().optional().default("shift+left").describe("Select left in input"),
      input_select_right: z.string().optional().default("shift+right").describe("Select right in input"),
      input_select_up: z.string().optional().default("shift+up").describe("Select up in input"),
      input_select_down: z.string().optional().default("shift+down").describe("Select down in input"),
      input_line_home: z.string().optional().default("ctrl+a").describe("Move to start of line in input"),
      input_line_end: z.string().optional().default("ctrl+e").describe("Move to end of line in input"),
      input_select_line_home: z
        .string()
        .optional()
        .default("ctrl+shift+a")
        .describe("Select to start of line in input"),
      input_select_line_end: z.string().optional().default("ctrl+shift+e").describe("Select to end of line in input"),
      input_visual_line_home: z.string().optional().default("alt+a").describe("Move to start of visual line in input"),
      input_visual_line_end: z.string().optional().default("alt+e").describe("Move to end of visual line in input"),
      input_select_visual_line_home: z
        .string()
        .optional()
        .default("alt+shift+a")
        .describe("Select to start of visual line in input"),
      input_select_visual_line_end: z
        .string()
        .optional()
        .default("alt+shift+e")
        .describe("Select to end of visual line in input"),
      input_buffer_home: z.string().optional().default("home").describe("Move to start of buffer in input"),
      input_buffer_end: z.string().optional().default("end").describe("Move to end of buffer in input"),
      input_select_buffer_home: z
        .string()
        .optional()
        .default("shift+home")
        .describe("Select to start of buffer in input"),
      input_select_buffer_end: z.string().optional().default("shift+end").describe("Select to end of buffer in input"),
      input_delete_line: z.string().optional().default("ctrl+shift+d").describe("Delete line in input"),
      input_delete_to_line_end: z.string().optional().default("ctrl+k").describe("Delete to end of line in input"),
      input_delete_to_line_start: z.string().optional().default("ctrl+u").describe("Delete to start of line in input"),
      input_backspace: z.string().optional().default("backspace,shift+backspace").describe("Backspace in input"),
      input_delete: z.string().optional().default("ctrl+d,delete,shift+delete").describe("Delete character in input"),
      input_undo: z.string().optional().default("ctrl+-,super+z").describe("Undo in input"),
      input_redo: z.string().optional().default("ctrl+.,super+shift+z").describe("Redo in input"),
      input_word_forward: z
        .string()
        .optional()
        .default("alt+f,alt+right,ctrl+right")
        .describe("Move word forward in input"),
      input_word_backward: z
        .string()
        .optional()
        .default("alt+b,alt+left,ctrl+left")
        .describe("Move word backward in input"),
      input_select_word_forward: z
        .string()
        .optional()
        .default("alt+shift+f,alt+shift+right")
        .describe("Select word forward in input"),
      input_select_word_backward: z
        .string()
        .optional()
        .default("alt+shift+b,alt+shift+left")
        .describe("Select word backward in input"),
      input_delete_word_forward: z
        .string()
        .optional()
        .default("alt+d,alt+delete,ctrl+delete")
        .describe("Delete word forward in input"),
      input_delete_word_backward: z
        .string()
        .optional()
        .default("ctrl+w,ctrl+backspace,alt+backspace")
        .describe("Delete word backward in input"),
      history_previous: z.string().optional().default("up").describe("Previous history item"),
      history_next: z.string().optional().default("down").describe("Next history item"),
      session_child_first: z.string().optional().default("<leader>down").describe("Go to first child session"),
      session_child_cycle: z.string().optional().default("right").describe("Go to next child session"),
      session_child_cycle_reverse: z.string().optional().default("left").describe("Go to previous child session"),
      session_parent: z.string().optional().default("up").describe("Go to parent session"),
      terminal_suspend: z.string().optional().default("ctrl+z").describe("Suspend terminal"),
      terminal_title_toggle: z.string().optional().default("none").describe("Toggle terminal title"),
      tips_toggle: z.string().optional().default("<leader>h").describe("Toggle tips on home screen"),
      plugin_manager: z.string().optional().default("none").describe("Open plugin manager dialog"),
      display_thinking: z.string().optional().default("none").describe("Toggle thinking blocks visibility"),
    })
    .strict()
    .meta({
      ref: "KeybindsConfig",
    })

  export const Server = z
    .object({
      port: z.number().int().positive().optional().describe("Port to listen on"),
      hostname: z.string().optional().describe("Hostname to listen on"),
      mdns: z.boolean().optional().describe("Enable mDNS service discovery"),
      mdnsDomain: z.string().optional().describe("Custom domain name for mDNS service (default: opencode.local)"),
      cors: z.array(z.string()).optional().describe("Additional domains to allow for CORS"),
      web: z.boolean().optional().describe("Enable parallel web server alongside TUI (Mode A)"),
      noAuth: z.boolean().optional().describe("Disable authentication"),
      permissionMode: z.enum(["default", "plan", "bypass"]).optional().describe("Permission mode"),
    })
    .strict()
    .meta({
      ref: "ServerConfig",
    })

  export const Layout = z.enum(["auto", "stretch"]).meta({
    ref: "LayoutConfig",
  })
  export type Layout = z.infer<typeof Layout>

  export const Provider = z
    .object({
      api: z.string().optional(),
      name: z.string().optional(),
      env: z.array(z.string()).optional(),
      id: z.string().optional(),
      npm: z.string().optional(),
    })
    .extend({
      whitelist: z.array(z.string()).optional(),
      blacklist: z.array(z.string()).optional(),
      models: z
        .record(
          z.string(),
          z
            .object({
              id: z.string().optional(),
              name: z.string().optional(),
              family: z.string().optional(),
              release_date: z.string().optional(),
              attachment: z.boolean().optional(),
              reasoning: z.boolean().optional(),
              temperature: z.boolean().optional(),
              tool_call: z.boolean().optional(),
              interleaved: z
                .union([
                  z.literal(true),
                  z.object({ field: z.enum(["reasoning_content", "reasoning_details"]) }).strict(),
                ])
                .optional(),
              cost: z
                .object({
                  input: z.number().optional(),
                  output: z.number().optional(),
                  cache_read: z.number().optional(),
                  cache_write: z.number().optional(),
                  context_over_200k: z
                    .object({
                      input: z.number(),
                      output: z.number(),
                      cache_read: z.number().optional(),
                      cache_write: z.number().optional(),
                    })
                    .optional(),
                })
                .optional(),
              limit: z
                .object({
                  context: z.number().optional(),
                  input: z.number().optional(),
                  output: z.number().optional(),
                })
                .optional(),
              modalities: z
                .object({
                  input: z.array(z.enum(["text", "audio", "image", "video", "pdf"])).optional(),
                  output: z.array(z.enum(["text", "audio", "image", "video", "pdf"])).optional(),
                })
                .optional(),
              experimental: z.boolean().optional(),
              status: z.enum(["alpha", "beta", "deprecated"]).optional(),
              options: z.record(z.string(), z.any()).optional(),
              headers: z.record(z.string(), z.string()).optional(),
              provider: z.object({ npm: z.string().optional(), api: z.string().optional() }).optional(),
              variants: z.record(z.string(), z.record(z.string(), z.any())).optional(),
            })
            .extend({
              tier: z
                .enum(["tier0", "tier1", "tier2"])
                .optional()
                .describe(
                  "Capability tier for this model: tier0=highest (orchestration), tier1=delivery (impl/test), tier2=cheap/fast (search/docs).",
                ),
              capabilities: z
                .record(z.string(), z.number().min(0).max(1))
                .optional()
                .describe("Capability scores keyed by capability name, values in [0,1]."),
              context_tokens: z
                .number()
                .int()
                .positive()
                .optional()
                .describe("Context window size in tokens for this model."),
              output_tokens: z.number().int().positive().optional().describe("Maximum output tokens for this model."),
              endpoint: z
                .string()
                .optional()
                .describe("Provider-specific endpoint path used for config-driven model routing, e.g. /v1/responses."),
              variants: z
                .record(
                  z.string(),
                  z
                    .object({
                      disabled: z.boolean().optional().describe("Disable this variant for the model"),
                    })
                    .catchall(z.any()),
                )
                .optional()
                .describe("Variant-specific configuration"),
            }),
        )
        .optional(),
      options: z
        .object({
          apiKey: z.string().optional(),
          endpoint: z
            .string()
            .optional()
            .describe("Alias of baseURL. When set, provider SDK requests use this endpoint URL."),
          baseURL: z.string().optional(),
          enterpriseUrl: z.string().optional().describe("GitHub Enterprise URL for copilot authentication"),
          setCacheKey: z.boolean().optional().describe("Enable promptCacheKey for this provider (default false)"),
          timeout: z
            .union([
              z
                .number()
                .int()
                .positive()
                .describe(
                  "Timeout in milliseconds for requests to this provider. Default is 300000 (5 minutes). Set to false to disable timeout.",
                ),
              z.literal(false).describe("Disable timeout for this provider entirely."),
            ])
            .optional()
            .describe(
              "Timeout in milliseconds for requests to this provider. Default is 300000 (5 minutes). Set to false to disable timeout.",
            ),
          chunkTimeout: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              "Timeout in milliseconds between streamed SSE chunks for this provider. If no chunk arrives within this window, the request is aborted.",
            ),
        })
        .catchall(z.any())
        .optional(),
    })
    .strict()
    .meta({
      ref: "ProviderConfig",
    })
  export type Provider = z.infer<typeof Provider>

  const ModelTier = z.enum(["tier0", "tier1", "tier2"])
  export type ModelTier = z.infer<typeof ModelTier>

  const ProviderModelOverride = z
    .object({
      tier: ModelTier.optional(),
    })
    .passthrough()
  export type ProviderModelOverride = z.infer<typeof ProviderModelOverride>

  export const ModelRoutingConfigSchema = z
    .object({
      enabled_providers: z.array(z.string().min(1)).optional(),
      provider: z
        .record(
          z.string(),
          z
            .object({
              models: z.record(z.string(), ProviderModelOverride).optional(),
            })
            .passthrough(),
        )
        .optional(),
      model_routing: z
        .object({
          cooldown_ms: z.number().int().positive().optional(),
          rate_limit_cooldown_ms: z.number().int().positive().optional(),
          min_samples: z.number().int().positive().optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough()
    .superRefine(() => {
      // Tier coverage is a hint — not a hard requirement. Cross-provider
      // fallback covers gaps. Relaxed 2026-05-03 to match Config.Info.
    })

  export type ModelRoutingConfig = z.infer<typeof ModelRoutingConfigSchema>

  export const ModelRoutingConfigContractSchema = ModelRoutingConfigSchema

  export function generateModelRoutingConfigJsonSchema(): Record<string, unknown> {
    return {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://opencode.ai/schemas/model-routing-config.schema.json",
      title: "OpenCode Model Routing Config",
      description:
        "Provider model registry with per-model tier annotation (tier0=best, tier1=delivery, tier2=cheap). Agent tier is declared in each local prompt card (src/agent/prompts/<name>.md) via model_tier frontmatter.",
      type: "object",
      properties: {
        enabled_providers: {
          type: "array",
          uniqueItems: true,
          items: { type: "string", minLength: 1 },
        },
        provider: {
          type: "object",
          description: "Custom provider configurations and model overrides including tier annotations.",
          additionalProperties: {
            type: "object",
            properties: {
              models: {
                type: "object",
                description: "Per-model overrides keyed by model ID.",
                additionalProperties: {
                  type: "object",
                  properties: {
                    tier: {
                      enum: ["tier0", "tier1", "tier2"],
                      description: "Capability tier for this model.",
                    },
                  },
                  additionalProperties: true,
                },
              },
            },
            additionalProperties: true,
          },
        },
        model_routing: {
          type: "object",
          description: "Tuning knobs for the model router. No agent mappings or model inventory here.",
          properties: {
            cooldown_ms: { type: "integer", exclusiveMinimum: 0 },
            rate_limit_cooldown_ms: { type: "integer", exclusiveMinimum: 0 },
            min_samples: { type: "integer", exclusiveMinimum: 0 },
          },
          additionalProperties: true,
        },
      },
      required: [],
      additionalProperties: true,
      allowComments: true,
      allowTrailingCommas: true,
    }
  }

  export const generateModelRoutingConfigContractJsonSchema = generateModelRoutingConfigJsonSchema

  export const Info = z
    .object({
      $schema: z.string().optional().describe("JSON schema reference for configuration validation"),
      logLevel: Log.Level.optional().describe("Log level"),
      server: Server.optional().describe("Server configuration for opencode serve and web commands"),
      command: z
        .record(z.string(), Command)
        .optional()
        .describe("Command configuration, see https://opencode.ai/docs/commands"),
      skills: Skills.optional().describe("Additional skill folder paths"),
      federation: Federation.optional().describe(
        "Federation manifest configuration. Generalises cfg.skills.urls — see " +
          "specification/contract/federation-manifest for the signed-manifest + ed25519 + sha256 contract.",
      ),
      watcher: z
        .object({
          ignore: z.array(z.string()).optional(),
        })
        .optional(),
      snapshot: z
        .boolean()
        .optional()
        .describe(
          "Enable or disable snapshot tracking. When false, filesystem snapshots are not recorded and undoing or reverting will not undo/redo file changes. Defaults to true.",
        ),
      plugin: PluginSpec.array().optional(),
      share: z
        .enum(["manual", "auto", "disabled"])
        .optional()
        .describe(
          "Control sharing behavior:'manual' allows manual sharing via commands, 'auto' enables automatic sharing, 'disabled' disables all sharing",
        ),
      autoshare: z
        .boolean()
        .optional()
        .describe("@deprecated Compatibility alias for 'share'; true migrates to share='auto' during config load."),
      autoupdate: z
        .union([z.boolean(), z.literal("notify")])
        .optional()
        .describe(
          "Automatically update to the latest version. Set to true to auto-update, false to disable, or 'notify' to show update notifications",
        ),
      disabled_providers: z.array(z.string()).optional().describe("Disable providers that are loaded automatically"),
      enabled_providers: z
        .array(z.string())
        .optional()
        .describe("When set, ONLY these providers will be enabled. All other providers will be ignored"),
      username: z
        .string()
        .optional()
        .describe("Custom username to display in conversations instead of system username"),
      mode: z
        .object({
          build: Agent.optional(),
          plan: Agent.optional(),
        })
        .catchall(Agent)
        .optional()
        .describe("@deprecated Compatibility alias for `agent`; entries are merged into agent config during load."),
      // Open record: any local prompt-card agent name accepted as a key. The
      // registry is open (loaded via src/agent/prompt-loader.ts), so
      // hardcoding a fixed list of "known" agent keys (plan/build/general/
      // explore/title/summary/compaction) coupled config validation to a
      // specific prompt set. Keys are validated at apply time by the modifier
      // overlay (see src/agent/agent.ts applyConfigOverlay) which logs and
      // skips entries whose name does not exist in local prompts.
      agent: z
        .record(z.string(), Agent)
        .optional()
        .describe("Agent configuration, see https://opencode.ai/docs/agents"),
      runtime_roles: z
        .object({
          compaction: z.string().optional(),
          "user-proxy": z.string().optional(),
          "halt-auditor": z.string().optional(),
          title: z.string().optional(),
          adviser: z.string().optional(),
        })
        .partial()
        .optional()
        .describe(
          "Bind internal-runtime roles to agent names. Each value is the name of an agent " +
            "card under src/agent/prompts/. Omitted keys fall through to built-in defaults " +
            "(role name == agent name). See src/agent/runtime-roles.ts.",
        ),
      plan_mode_agents: z
        .array(z.string().min(1))
        .min(1)
        .optional()
        .describe(
          "Agent names treated as 'plan-mode' (research-only — bootstrap restricted, " +
            "edit/write gates apply). Default: ['planner']. See src/agent/agent-roles.ts.",
        ),
      dispatch_roles: z
        .object({
          phase: z
            .object({
              Plan: z.string().optional(),
              Design: z.string().optional(),
              "Root cause": z.string().optional(),
              Contract: z.string().optional(),
              Spec: z.string().optional(),
              Implement: z.string().optional(),
              "Rethink & Redesign": z.string().optional(),
              "Test Strategy": z.string().optional(),
              Verification: z.string().optional(),
              Research: z.string().optional(),
              Notes: z.string().optional(),
            })
            .partial()
            .optional()
            .describe(
              "Phase → agent overrides. Used by task-note seeding to populate the placeholder " +
                "leaf under each ### <Phase> heading. Omitted keys fall through to built-in defaults.",
            ),
          reason: z
            .object({
              "default-fallback": z.string().optional(),
              "missing-discovery": z.string().optional(),
              "pending-dispatch": z.string().optional(),
              "failed-progress": z.string().optional(),
              "open-questions": z.string().optional(),
              "notes-empty": z.string().optional(),
              "phase-gate-verify": z.string().optional(),
            })
            .partial()
            .optional()
            .describe(
              "Dispatch-reason → agent overrides. Used by reconcile engine when emitting " +
                "next_actions to route the orchestrator. Omitted keys fall through to built-in defaults.",
            ),
        })
        .partial()
        .optional()
        .describe(
          "Routing-policy bindings consumed by note-seed and reconcile-engine. " +
            "See src/agent/dispatch-roles.ts for the closed enum of phase + reason keys.",
        ),
      provider: z
        .record(z.string(), Provider)
        .optional()
        .describe("Custom provider configurations and model overrides"),
      mcp: z
        .record(
          z.string(),
          z
            .object({
              enabled: z.boolean().optional(),
            })
            .catchall(z.unknown()),
        )
        .optional()
        .describe("Deprecated. MCP configuration is ignored in this simplified build."),
      formatter: z
        .union([
          z.literal(false),
          z.record(
            z.string(),
            z.object({
              disabled: z.boolean().optional(),
              command: z.array(z.string()).optional(),
              environment: z.record(z.string(), z.string()).optional(),
              extensions: z.array(z.string()).optional(),
            }),
          ),
        ])
        .optional(),
      lsp: z
        .union([z.literal(false), z.record(z.string(), z.unknown())])
        .optional()
        .describe("Deprecated. LSP configuration is ignored in this simplified build."),
      instructions: z.array(z.string()).optional().describe("Additional instruction files or patterns to include"),
      notes: z
        .object({
          root: z
            .string()
            .optional()
            .describe(
              "Filesystem path to the notes vault root. Precedence: this field (project opencode.json) > global ~/.config/opencode/opencode.json notes.root > OPENCODE_NOTES_ROOT env var > hardcoded default /local/mnt/workspace/notes.",
            ),
        })
        .optional()
        .describe("Notes vault configuration."),
      layout: Layout.optional().describe("@deprecated Ignored compatibility field; layout is always stretch."),
      permission: Permission.optional(),
      tools: z
        .record(z.string(), z.boolean())
        .optional()
        .describe("@deprecated Compatibility alias for permission; migrated during config load."),
      enterprise: z
        .object({
          url: z.string().optional().describe("Enterprise URL"),
        })
        .optional(),
      compaction: z
        .object({
          auto: z.boolean().optional().describe("Enable automatic compaction when context is full (default: true)"),
          prune: z.boolean().optional().describe("Enable pruning of old tool outputs (default: true)"),
          trigger_tokens: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              "Token count at which auto-compaction fires for all agents, regardless of model context window size. Default: 150000. Set to 0 to disable the fixed trigger and fall back to model-context-based overflow detection.",
            ),
          reserved: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe("Token buffer for compaction. Leaves enough window to avoid overflow during compaction."),
          session_budget_tokens: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              "Session-level cumulative-token budget. When set, the per-step token-budget tracker uses this as the cap for top-level (non-subagent) sessions. Triggers diminishing-returns detection and graceful loop termination once the budget is exhausted.",
            ),
          api_clear_tool_uses: z
            .object({
              enabled: z
                .boolean()
                .optional()
                .describe("Enable Anthropic context_management beta (clear_tool_uses_20250919)."),
              trigger_tokens: z
                .number()
                .int()
                .positive()
                .optional()
                .describe("Input-token threshold at which the API begins clearing tool uses (default: 180000)."),
              target_tokens: z
                .number()
                .int()
                .positive()
                .optional()
                .describe("Approximate post-clear input-token target (default: 40000)."),
              exclude_tools: z
                .array(z.string())
                .optional()
                .describe(
                  "Tool names whose tool_use blocks must never be cleared (default: notes/todo/task/edit/write).",
                ),
            })
            .optional()
            .describe(
              "Anthropic API context-management beta config. Server-side tool-use clearing on Anthropic models only; other providers fall back to client-side compaction.",
            ),
        })
        .optional(),
      model_routing: z
        .object({
          state_path: z
            .string()
            .optional()
            .describe(
              "Filesystem path to the dynamic model-health state file (model-routing.json). Defaults to <global-config-dir>/model-routing.json.",
            ),
          cooldown_ms: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              "Duration in milliseconds a model is cooled down after a failure before being re-ranked (default: 60000).",
            ),
          rate_limit_cooldown_ms: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              "Duration in milliseconds a model is strongly deprioritized after a detected rate-limit event (default: 300000).",
            ),
          min_samples: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              "Minimum number of recorded executions before dynamic health ranking overrides configured candidate order (default: 5).",
            ),
          enabled: z
            .boolean()
            .optional()
            .describe(
              "When true, enable capability-driven model resolver. When false/absent, legacy tier-only resolver is used.",
            ),
          enabled_providers: z
            .array(z.string())
            .optional()
            .describe("Provider IDs whose models are eligible for capability-driven selection."),
          policy_denied: z
            .array(z.string())
            .optional()
            .describe(
              "Model IDs (in 'provider::model' form) that must never be selected regardless of capability score.",
            ),
          tier_floor: z
            .record(z.string(), z.enum(["tier0", "tier1", "tier2"]))
            .optional()
            .describe(
              "Per-agent minimum tier ceiling. Agents listed here only consider candidates whose tier rank is ≤ the floor.",
            ),
          fallback_chain_length: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Number of candidates returned in the fallback chain (default 3)."),
          cross_provider_rotation: z
            .boolean()
            .optional()
            .describe(
              "When true, prefer fallbacks from providers different from the primary when scores are within tolerance.",
            ),
          context_overrides: z
            .object({
              huge_context_threshold_tokens: z.number().int().positive().optional(),
            })
            .optional()
            .describe(
              "Per-resolution overrides triggered by request shape, e.g. huge-context bumps long_context weight.",
            ),
        })
        .optional()
        .describe(
          "Model-routing tuning knobs. Agent tier is declared in each local prompt card (src/agent/prompts/<name>.md) and model tiers are annotated at provider.*.models.<model>.tier.",
        ),
      agent_capability_requirements: z
        .record(
          z.string(),
          z.object({
            thresholds: z.record(z.string(), z.number().min(0).max(1)).optional(),
            weight: z.record(z.string(), z.number()).optional(),
          }),
        )
        .optional()
        .describe(
          "Per-agent capability thresholds (must-have minimums in [0,1]) and weight map (used for weighted score). Keyed by agent name.",
        ),
      experimental: z
        .object({
          disable_paste_summary: z.boolean().optional(),
          openTelemetry: z
            .boolean()
            .optional()
            .describe("Enable OpenTelemetry spans for AI SDK calls (using the 'experimental_telemetry' flag)"),
          primary_tools: z
            .array(z.string())
            .optional()
            .describe("Tools that should only be available to primary agents."),
          continue_loop_on_deny: z.boolean().optional().describe("Continue the agent loop when a tool call is denied"),
          autocontinue_max_turns: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Maximum autonomous continuation turns before stopping the loop (default: 3000)"),
          autocontinue_inactivity_ms: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              "Milliseconds of assistant inactivity before user-proxy continuation is injected (default: 8000)",
            ),
          user_proxy_check_interval: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Number of loop steps between proactive user-proxy progress checks (default: 5)"),
          mcp_timeout: z.number().int().positive().optional().describe("Deprecated. Ignored in this simplified build."),
        })
        .optional(),
    })
    .strict()
    .superRefine((cfg, ctx) => {
      // Tier coverage is a HINT, not a requirement. When a provider lacks a
      // model for some tier, the dispatcher falls back to another enabled
      // provider (model_routing.fallback + cross-provider routing handles
      // gaps). Logging a warning preserves operator visibility without
      // refusing to start. Originally this was a hard validation error;
      // relaxed per [[opencode-config-file]] amendment 2026-05-03 — forcing
      // anthropic to register a model for every tier was preventing valid
      // configs from booting.
      const enabledProviders = cfg.enabled_providers
      const providerMap = cfg.provider as Record<string, { models?: Record<string, { tier?: string }> }> | undefined
      if (enabledProviders && enabledProviders.length > 0 && providerMap) {
        for (const providerID of enabledProviders) {
          const providerCfg = providerMap[providerID]
          if (!providerCfg?.models) continue
          const models = providerCfg.models
          for (const tier of ["tier0", "tier1", "tier2"] as const) {
            const has = Object.values(models).some((m) => (m as { tier?: string }).tier === tier)
            if (!has) {
              log.warn(
                `provider "${providerID}" has no model registered for ${tier} — cross-provider fallback will cover gaps`,
              )
            }
          }
        }
      }

      // When capability-driven routing is enabled, every provider model that
      // declares a `capabilities` map must also supply `context_tokens`,
      // `output_tokens`, and `cost` so the resolver can score and rank it.
      if (cfg.model_routing?.enabled !== true) return

      type ModelEntry = {
        capabilities?: Record<string, number>
        context_tokens?: number
        output_tokens?: number
        cost?: unknown
      }
      const capProviderMap = cfg.provider as Record<string, { models?: Record<string, ModelEntry> }> | undefined
      if (!capProviderMap) return

      for (const [providerID, providerCfg] of Object.entries(capProviderMap)) {
        if (!providerCfg?.models) continue
        for (const [modelID, model] of Object.entries(providerCfg.models)) {
          if (!model?.capabilities) continue
          if (model.context_tokens == null) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["provider", providerID, "models", modelID, "context_tokens"],
              message: `model "${providerID}/${modelID}" has capabilities but is missing required context_tokens`,
            })
          }
          if (model.output_tokens == null) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["provider", providerID, "models", modelID, "output_tokens"],
              message: `model "${providerID}/${modelID}" has capabilities but is missing required output_tokens`,
            })
          }
          if (model.cost == null) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["provider", providerID, "models", modelID, "cost"],
              message: `model "${providerID}/${modelID}" has capabilities but is missing required cost`,
            })
          }
        }
      }
    })
    .meta({
      ref: "Config",
    })

  export type Info = z.output<typeof Info> & {
    plugin_origins?: PluginOrigin[]
  }

  type State = {
    config: Info
    directories: string[]
    deps: Promise<void>[]
    consoleState: ConsoleState
  }

  export interface Interface {
    readonly get: () => Effect.Effect<Info>
    readonly getGlobal: () => Effect.Effect<Info>
    readonly getConsoleState: () => Effect.Effect<ConsoleState>
    readonly invalidate: (wait?: boolean) => Effect.Effect<void>
    readonly directories: () => Effect.Effect<string[]>
    readonly waitForDependencies: () => Effect.Effect<void>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/Config") {}

  function warnDeprecatedConfigPath(filepath: string, reason: string) {
    if (!existsSync(filepath)) return
    log.warn("deprecated config location", { path: filepath, reason })
  }

  function globalConfigFile() {
    const canonical = path.join(Global.Path.config, "opencode.json")
    warnDeprecatedConfigPath(path.join(Global.Path.config, "opencode.jsonc"), "jsonc filename is deprecated")
    warnDeprecatedConfigPath(path.join(Global.Path.config, "config.json"), "config.json filename is deprecated")
    const legacyXdgDir = path.join(os.homedir(), ".config", "opencode")
    warnDeprecatedConfigPath(path.join(legacyXdgDir, "opencode.json"), "legacy xdg path is deprecated")
    warnDeprecatedConfigPath(path.join(legacyXdgDir, "opencode.jsonc"), "legacy xdg path is deprecated")
    return canonical
  }

  function resolveExplicitOverridePath(source: "OPENCODE_CONFIG" | "OPENCODE_CONFIG_DIR", input: string) {
    const resolved = path.resolve(input)
    if (hasHiddenSegment(resolved)) {
      if (source === "OPENCODE_CONFIG") {
        throw new Error(
          `hidden-config-path-unsupported: OPENCODE_CONFIG resolves inside a hidden directory (${resolved}); use ${path.join(Global.Path.config, "opencode.json")} or a non-hidden file path`,
        )
      }
      throw new Error(
        `hidden-config-path-unsupported: OPENCODE_CONFIG_DIR resolves inside a hidden directory (${resolved}); use ${Global.Path.config} or a non-hidden directory`,
      )
    }
    return resolved
  }

  function parseConfig(text: string, filepath: string): Info {
    const errors: JsoncParseError[] = []
    const data = parseJsonc(text, errors, { allowTrailingComma: true })
    if (errors.length) {
      throw new JsonError({
        path: filepath,
        message: formatJsoncParseErrorMessage(text, errors),
      })
    }

    const parsed = Info.safeParse(data)
    if (parsed.success) return parsed.data

    throw new InvalidError({
      path: filepath,
      issues: parsed.error.issues,
    })
  }

  export const { JsonError, InvalidError } = ConfigPaths

  export const ConfigDirectoryTypoError = NamedError.create(
    "ConfigDirectoryTypoError",
    z.object({
      path: z.string(),
      dir: z.string(),
      suggestion: z.string(),
    }),
  )

  export const layer: Layer.Layer<Service, never, AppFileSystem.Service | Auth.Service> = Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* AppFileSystem.Service
      const authSvc = yield* Auth.Service

      const readConfigFile = Effect.fnUntraced(function* (filepath: string) {
        return yield* fs.readFileString(filepath).pipe(
          Effect.catchIf(
            (e) => e.reason._tag === "NotFound",
            () => Effect.succeed(undefined),
          ),
          Effect.orDie,
        )
      })

      const loadConfig = Effect.fnUntraced(function* (
        text: string,
        options: { path: string } | { dir: string; source: string },
      ) {
        const source = "path" in options ? options.path : options.source
        const isFile = "path" in options
        const data = yield* Effect.promise(() =>
          ConfigPaths.parseText(text, "path" in options ? options.path : { source: options.source, dir: options.dir }),
        )

        const normalized = (() => {
          if (!data || typeof data !== "object" || Array.isArray(data)) return data
          const copy = { ...(data as Record<string, unknown>) }
          const hadLegacy = "theme" in copy || "keybinds" in copy || "tui" in copy
          if (!hadLegacy) return copy
          delete copy.theme
          delete copy.keybinds
          delete copy.tui
          log.warn("tui keys in opencode config are deprecated; move them to tui.json", { path: source })
          return copy
        })()

        const parsed = Info.safeParse(normalized)
        if (parsed.success) {
          const data = parsed.data
          if (data.plugin && isFile) {
            const list = data.plugin
            for (let i = 0; i < list.length; i++) {
              list[i] = yield* Effect.promise(() => resolvePluginSpec(list[i], options.path))
            }
          }
          return data
        }

        throw new InvalidError({
          path: source,
          issues: parsed.error.issues,
        })
      })

      const loadFile = Effect.fnUntraced(function* (filepath: string) {
        log.info("loading", { path: filepath })
        const text = yield* readConfigFile(filepath)
        if (!text) return {} as Info
        return yield* loadConfig(text, { path: filepath })
      })

      const loadGlobal = Effect.fnUntraced(function* () {
        const globalFile = globalConfigFile()
        const result: Info = pipe({}, mergeDeep(yield* loadFile(globalFile)))

        // Legacy TOML adoption path retired 2026-05-03 — it would silently
        // OVERWRITE <vault>/etc/opencode.json + DELETE the legacy TOML on
        // first boot. Operators rely on opencode.json being authoritative;
        // any auto-merge against a stale legacy TOML is a footgun. If a
        // user still has a legacy `<vault>/etc/config` TOML, warn and
        // leave both files alone — they can manually port settings.
        const legacy = path.join(Global.Path.config, "config")
        if (existsSync(legacy)) {
          log.warn(
            `legacy TOML config detected at ${legacy} — ignored. Migrate manually to ${globalFile}; the legacy file will not be auto-merged or deleted.`,
          )
        }

        return result
      })

      const [cachedGlobal, invalidateGlobal] = yield* Effect.cachedInvalidateWithTTL(
        loadGlobal().pipe(
          Effect.tapError((error) =>
            Effect.sync(() => log.error("failed to load global config, using defaults", { error: String(error) })),
          ),
          Effect.orElseSucceed((): Info => ({})),
        ),
        Duration.infinity,
      )

      const getGlobal = Effect.fn("Config.getGlobal")(function* () {
        return yield* cachedGlobal
      })

      const loadInstanceState = Effect.fnUntraced(function* (ctx: InstanceContext) {
        const auth = yield* authSvc.all().pipe(Effect.orDie)

        let result: Info = {}
        const consoleManagedProviders = new Set<string>()
        let activeOrgName: string | undefined

        const explicitConfigPathInput = process.env.OPENCODE_CONFIG ?? Flag.OPENCODE_CONFIG
        const explicitConfigDirInput = process.env.OPENCODE_CONFIG_DIR ?? Flag.OPENCODE_CONFIG_DIR
        const explicitConfigPath = explicitConfigPathInput
          ? resolveExplicitOverridePath("OPENCODE_CONFIG", explicitConfigPathInput)
          : undefined
        const explicitConfigDir = explicitConfigDirInput
          ? resolveExplicitOverridePath("OPENCODE_CONFIG_DIR", explicitConfigDirInput)
          : undefined

        const scope = (source: string): PluginScope => {
          if (source.startsWith("http://") || source.startsWith("https://")) return "global"
          if (source === "OPENCODE_CONFIG_CONTENT") return "local"
          if (ConfigInstance.containsPath(source)) return "local"
          return "global"
        }

        const track = (source: string, list: PluginSpec[] | undefined, kind?: PluginScope) => {
          if (!list?.length) return
          const hit = kind ?? scope(source)
          const plugins = deduplicatePluginOrigins([
            ...(result.plugin_origins ?? []),
            ...list.map((spec) => ({ spec, source, scope: hit })),
          ])
          result.plugin = plugins.map((item) => item.spec)
          result.plugin_origins = plugins
        }

        const merge = (source: string, next: Info, kind?: PluginScope) => {
          result = mergeConfigConcatArrays(result, next)
          track(source, next.plugin, kind)
        }

        for (const [key, value] of Object.entries(auth)) {
          if (value.type === "wellknown") {
            const url = key.replace(/\/+$/, "")
            process.env[value.key] = value.token
            log.debug("fetching remote config", { url: `${url}/.well-known/opencode` })
            const response = yield* Effect.promise(() => fetch(`${url}/.well-known/opencode`))
            if (!response.ok) {
              throw new Error(`failed to fetch remote config from ${url}: ${response.status}`)
            }
            const wellknown = (yield* Effect.promise(() => response.json())) as any
            const remoteConfig = wellknown.config ?? {}
            const source = `${url}/.well-known/opencode`
            const next = yield* loadConfig(JSON.stringify(remoteConfig), {
              dir: path.dirname(source),
              source,
            })
            merge(source, next, "global")
            log.debug("loaded remote config from well-known", { url })
          }
        }

        const global = yield* getGlobal()
        merge(globalConfigFile(), global, "global")

        if (explicitConfigPath) {
          merge(explicitConfigPath, yield* loadFile(explicitConfigPath))
          log.debug("loaded custom config", { path: explicitConfigPath })
        }

        if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
          const workspaceFile = path.join(ctx.directory, "opencode.json")
          warnDeprecatedConfigPath(path.join(ctx.directory, "opencode.jsonc"), "jsonc filename is deprecated")
          warnDeprecatedConfigPath(path.join(ctx.directory, "config.json"), "config.json filename is deprecated")
          merge(workspaceFile, yield* loadFile(workspaceFile), "local")
        }

        result.agent = result.agent || {}
        result.mode = result.mode || {}
        result.plugin = result.plugin || []

        const directories = yield* Effect.promise(() => ConfigPaths.directories(ctx.directory, ctx.worktree))

        if (explicitConfigDir) {
          log.debug("loading config from OPENCODE_CONFIG_DIR", { path: explicitConfigDir })
        }

        const deps: Promise<void>[] = []

        for (const dir of unique(directories)) {
          const list = yield* Effect.promise(() => loadPlugin(dir))
          const dep = iife(async () => {
            if (list.length === 0) return
            const pluginsDir = path.join(dir, "plugins")
            await fsNode.mkdir(pluginsDir, { recursive: true }).catch(() => {})
            await installDependencies(pluginsDir)
          })
          void dep.catch((err) => {
            log.warn("background dependency install failed", { dir, error: err })
          })
          deps.push(dep)

          result.command = mergeDeep(result.command ?? {}, yield* Effect.promise(() => loadCommand(dir)))
          track(dir, list)
        }

        if (process.env.OPENCODE_CONFIG_CONTENT) {
          const source = "OPENCODE_CONFIG_CONTENT"
          const next = yield* loadConfig(process.env.OPENCODE_CONFIG_CONTENT, {
            dir: ctx.directory,
            source,
          })
          merge(source, next, "local")
          log.debug("loaded custom config from OPENCODE_CONFIG_CONTENT")
        }

        const accountResult = yield* Effect.tryPromise({
          try: async () => {
            const activeOrg = await ConfigAccount.activeOrg()
            if (!activeOrg) return undefined
            const [configOpt, tokenOpt] = await Promise.all([
              ConfigAccount.config(activeOrg.account.id, activeOrg.org.id),
              ConfigAccount.token(activeOrg.account.id),
            ])
            return { activeOrg, configOpt, tokenOpt }
          },
          catch: (err) => err,
        }).pipe(
          Effect.catch((err) => {
            log.debug("failed to fetch remote account config", {
              error: err instanceof Error ? err.message : String(err),
            })
            return Effect.succeed(undefined)
          }),
        )

        if (accountResult) {
          const { activeOrg, configOpt, tokenOpt } = accountResult
          if (tokenOpt) {
            process.env["OPENCODE_CONSOLE_TOKEN"] = tokenOpt
            Env.set("OPENCODE_CONSOLE_TOKEN", tokenOpt)
          }

          activeOrgName = activeOrg.org.name

          if (configOpt) {
            const source = `${activeOrg.account.url}/api/config`
            const next = yield* loadConfig(JSON.stringify(configOpt), {
              dir: path.dirname(source),
              source,
            })
            for (const providerID of Object.keys(next.provider ?? {})) {
              consoleManagedProviders.add(providerID)
            }
            merge(source, next, "global")
          }
        }

        if (existsSync(managedDir)) {
          warnDeprecatedConfigPath(path.join(managedDir, "opencode.jsonc"), "jsonc filename is deprecated")
          const source = path.join(managedDir, "opencode.json")
          merge(source, yield* loadFile(source), "global")
        }

        // macOS managed preferences (.mobileconfig deployed via MDM) override everything
        result = mergeConfigConcatArrays(result, yield* Effect.promise(() => readManagedPreferences()))

        for (const [name, mode] of Object.entries(result.mode ?? {})) {
          result.agent = mergeDeep(result.agent ?? {}, {
            [name]: {
              ...mode,
              mode: "primary" as const,
            },
          })
        }

        if (Flag.OPENCODE_PERMISSION) {
          result.permission = mergeDeep(result.permission ?? {}, JSON.parse(Flag.OPENCODE_PERMISSION))
        }

        if (result.tools) {
          const perms: Record<string, Config.PermissionAction> = {}
          for (const [tool, enabled] of Object.entries(result.tools)) {
            perms[tool] = enabled ? "allow" : "deny"
          }
          result.permission = mergeDeep(perms, result.permission ?? {})
        }

        if (!result.username) result.username = os.userInfo().username

        if (result.autoshare === true && !result.share) {
          result.share = "auto"
        }

        if (Flag.OPENCODE_DISABLE_AUTOCOMPACT) {
          result.compaction = { ...result.compaction, auto: false }
        }
        if (Flag.OPENCODE_DISABLE_PRUNE) {
          result.compaction = { ...result.compaction, prune: false }
        }

        return {
          config: result,
          directories,
          deps,
          consoleState: {
            consoleManagedProviders: Array.from(consoleManagedProviders),
            activeOrgName,
            switchableOrgCount: 0,
          },
        }
      })

      const state = yield* InstanceState.make<State>(
        Effect.fn("Config.state")(function* (ctx) {
          return yield* loadInstanceState(ctx)
        }),
      )

      const get = Effect.fn("Config.get")(function* () {
        return yield* InstanceState.use(state, (s) => s.config)
      })

      const directories = Effect.fn("Config.directories")(function* () {
        return yield* InstanceState.use(state, (s) => s.directories)
      })

      const getConsoleState = Effect.fn("Config.getConsoleState")(function* () {
        return yield* InstanceState.use(state, (s) => s.consoleState)
      })

      const waitForDependencies = Effect.fn("Config.waitForDependencies")(function* () {
        yield* InstanceState.useEffect(state, (s) =>
          Effect.promise(async () => {
            if (s.deps.length === 0) return

            const raw = Number(process.env.OPENCODE_CONFIG_DEPS_WAIT_TIMEOUT_MS ?? "5000")
            const timeoutMs = Number.isFinite(raw) && raw > 0 ? raw : 5_000

            let timer: NodeJS.Timeout | undefined
            const timedOut = new Promise<"timeout">((resolve) => {
              timer = setTimeout(() => resolve("timeout"), timeoutMs)
            })
            timer?.unref?.()

            const status = await Promise.race([
              Promise.allSettled(s.deps).then(() => "done" as const),
              timedOut,
            ]).finally(() => {
              if (timer) clearTimeout(timer)
            })

            if (status === "timeout") {
              log.warn("timed out waiting for background config dependency installs", {
                timeoutMs,
                pending: s.deps.length,
              })
            }
          }),
        )
      })

      const invalidate = Effect.fn("Config.invalidate")(function* (wait?: boolean) {
        yield* invalidateGlobal
        const task = ConfigInstance.disposeAll()
          .catch(() => undefined)
          .finally(() =>
            GlobalBus.emit("event", {
              directory: "global",
              payload: {
                type: "global.disposed",
                properties: {},
              },
            }),
          )
        if (wait) yield* Effect.promise(() => task)
        else void task
      })

      return Service.of({
        get,
        getGlobal,
        getConsoleState,
        invalidate,
        directories,
        waitForDependencies,
      })
    }),
  )

  export const defaultLayer = layer.pipe(Layer.provide(AppFileSystem.defaultLayer), Layer.provide(Auth.defaultLayer))

  const { runPromise } = makeRuntime(Service, defaultLayer)

  /**
   * Last config snapshot returned by `get()`. Populated as a side effect
   * of every `get()` call so consumers on the synchronous hot path
   * (e.g. `tool/task` delegation provider allowlist) can read the
   * latest config without awaiting. May be `undefined` until the first
   * `get()` resolves.
   */
  let syncCache: Info | undefined

  export async function get() {
    const cfg = await runPromise((svc) => svc.get())
    syncCache = cfg
    return cfg
  }

  /**
   * Synchronous read of the most recently resolved config. Returns
   * `undefined` if `get()` has not completed at least once. Hot-path
   * callers must tolerate `undefined` (cold-boot or pre-resolution
   * code path) and fall back to safe defaults.
   */
  export function getSync(): Info | undefined {
    return syncCache
  }

  export async function getGlobal() {
    return runPromise((svc) => svc.getGlobal())
  }

  export async function getConsoleState() {
    return runPromise((svc) => svc.getConsoleState())
  }

  export async function invalidate(wait = false) {
    const result = await runPromise((svc) => svc.invalidate(wait))
    // Lifecycle hook: config invalidation is surfaced as a bus event so
    // interface/plugin can observe it without platform importing interface.
    // Some test helpers call invalidate() outside Instance.provide(); keep
    // invalidation side effects non-throwing in that context.
    const directory = (() => {
      try {
        return ConfigInstance.directory
      } catch {
        return process.cwd()
      }
    })()
    GlobalBus.emit("event", {
      directory,
      payload: {
        type: "config.change",
        properties: { directory },
      },
    })
    return result
  }

  export async function directories() {
    return runPromise((svc) => svc.directories())
  }

  export async function waitForDependencies() {
    return runPromise((svc) => svc.waitForDependencies())
  }
}
