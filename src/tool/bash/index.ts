// Contract surface for the bash tool (modes/version/port schema) is defined in contract/port.
// Keep this export in sync with any contract evolution.
export * from "@/tool/bash/contract/port"
import z from "zod"
import os from "os"
import { Tool } from "@/tool/tool"
import path from "path"
import { access } from "node:fs/promises"
import { constants as fsConstants } from "node:fs"
// vault-as-sole-filesystem (Stage 0.5, I0.2): vaultPath replaces os.tmpdir()
// for storage destinations. The legacy `os` import remains for `os.homedir()`
// in `~`-substitution helpers (read-only display use).
import { vaultPath } from "@/notes/root"
import { ToolCard } from "@/tool/card"
import { Log } from "@/foundation/util/log"
import { InstanceContextStorage as Instance } from "@/foundation/effect/instance-context"
import { lazy } from "@/foundation/util/lazy"
import { Language, type Node } from "web-tree-sitter"

import { Filesystem } from "@/foundation/util/filesystem"
import { Process } from "@/foundation/util/process"
import { fileURLToPath } from "url"
import { Flag } from "@/foundation/flag/flag"
import { Shell } from "@/filesystem/shell/shell"

import { BashArity } from "@/permission/arity"
import { Truncate } from "@/tool/truncate"
import { ProviderPluginHooks } from "@/provider/plugin-hooks"
import { Cause, Effect, Exit, Fiber, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import * as CrossSpawnSpawner from "@/foundation/effect/cross-spawn-spawner"
import { TaskOutput } from "@/tool/bash/TaskOutput"
import { createDiskOutput } from "@/tool/bash/diskOutput"
import { createCwdTracker } from "@/tool/bash/cwd-tracker"
import { ShellCommandImpl } from "@/tool/bash/ShellCommand"
import {
  backgroundRegistry,
  cleanupBackgroundTasks,
  getBackgroundTask,
  killBackgroundTask,
  listBackgroundTaskDetails,
  listBackgroundTasks,
  removeBackgroundTask,
} from "@/tool/bash/background-registry"
import { isCommandSafeViaFlagParsing } from "./flagParseSafety.js"
import { getDestructiveCommandWarning } from "./destructiveCommandWarning.js"
import { extractPathsFromCommand } from "./pathExtractors.js"
import {
  classifyBashConcurrency,
  formatAvailability,
  formatCustomScriptsBlock,
  probeBinaries,
  scanScriptDirs,
} from "@/tool/bash/extras"
import { secondaryToolDirs } from "@/tool/secondary"

const MAX_METADATA_LENGTH = 30_000
const DEFAULT_TIMEOUT = Flag.OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS || 2 * 60 * 1000
const READ_DATA_MAX_CHARS = 16 * 1024
const PS = new Set(["powershell", "pwsh"])
const CWD = new Set(["cd", "push-location", "set-location"])
const FILES = new Set([
  ...CWD,
  "rm",
  "cp",
  "mv",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "cat",
  // Leave PowerShell aliases out for now. Common ones like cat/cp/mv/rm/mkdir
  // already hit the entries above, and alias normalization should happen in one
  // place later so we do not risk double-prompting.
  "get-content",
  "set-content",
  "add-content",
  "copy-item",
  "move-item",
  "remove-item",
  "new-item",
  "rename-item",
])
const FLAGS = new Set(["-destination", "-literalpath", "-path"])
const SWITCHES = new Set(["-confirm", "-debug", "-force", "-nonewline", "-recurse", "-verbose", "-whatif"])

type Part = {
  type: string
  text: string
}

type Scan = {
  dirs: Set<string>
  patterns: Set<string>
  always: Set<string>
}

export const log = Log.create({ service: "bash-tool" })

export {
  listBackgroundTasks,
  listBackgroundTaskDetails,
  getBackgroundTask,
  removeBackgroundTask,
  killBackgroundTask,
  cleanupBackgroundTasks,
}

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

function parts(node: Node) {
  const out: Part[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue
        out.push({ type: item.type, text: item.text })
      }
      continue
    }
    if (
      child.type !== "command_name" &&
      child.type !== "command_name_expr" &&
      child.type !== "word" &&
      child.type !== "string" &&
      child.type !== "raw_string" &&
      child.type !== "concatenation"
    ) {
      continue
    }
    out.push({ type: child.type, text: child.text })
  }
  return out
}

function source(node: Node) {
  return (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim()
}

function commands(node: Node) {
  return node.descendantsOfType("command").filter((child): child is Node => Boolean(child))
}

function unquote(text: string) {
  if (text.length < 2) return text
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1)
  return text
}

function home(text: string) {
  if (text === "~") return os.homedir()
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(os.homedir(), text.slice(2))
  return text
}

function envValue(key: string) {
  if (process.platform !== "win32") return process.env[key]
  const name = Object.keys(process.env).find((item) => item.toLowerCase() === key.toLowerCase())
  return name ? process.env[name] : undefined
}

function auto(key: string, cwd: string, shell: string) {
  const name = key.toUpperCase()
  if (name === "HOME") return os.homedir()
  if (name === "PWD") return cwd
  if (name === "PSHOME") return path.dirname(shell)
}

function expand(text: string, cwd: string, shell: string) {
  const out = unquote(text)
    .replace(/\$\{env:([^}]+)\}/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$(HOME|PWD|PSHOME)(?=$|[\\/])/gi, (_, key: string) => auto(key, cwd, shell) || "")
  return home(out)
}

function provider(text: string) {
  const match = text.match(/^([A-Za-z]+)::(.*)$/)
  if (match) {
    if (match[1].toLowerCase() !== "filesystem") return
    return match[2]
  }
  const prefix = text.match(/^([A-Za-z]+):(.*)$/)
  if (!prefix) return text
  if (prefix[1].length === 1) return text
  return
}

function dynamic(text: string, ps: boolean) {
  if (text.startsWith("(") || text.startsWith("@(")) return true
  if (text.includes("$(") || text.includes("${") || text.includes("`")) return true
  if (ps) return /\$(?!env:)/i.test(text)
  return text.includes("$")
}

function prefix(text: string) {
  const match = /[?*\[]/.exec(text)
  if (!match) return text
  if (match.index === 0) return
  return text.slice(0, match.index)
}

async function cygpath(shell: string, text: string) {
  const out = await Process.text([shell, "-lc", 'cygpath -w -- "$1"', "_", text], { nothrow: true })
  if (out.code !== 0) return
  const file = out.text.trim()
  if (!file) return
  return Filesystem.normalizePath(file)
}

async function resolvePath(text: string, root: string, shell: string) {
  if (process.platform === "win32") {
    if (Shell.posix(shell) && text.startsWith("/") && Filesystem.windowsPath(text) === text) {
      const file = await cygpath(shell, text)
      if (file) return file
    }
    return Filesystem.normalizePath(path.resolve(root, Filesystem.windowsPath(text)))
  }
  return path.resolve(root, text)
}

async function argPath(arg: string, cwd: string, ps: boolean, shell: string) {
  const text = ps ? expand(arg, cwd, shell) : home(unquote(arg))
  const file = text && prefix(text)
  if (!file || dynamic(file, ps)) return
  const next = ps ? provider(file) : file
  if (!next) return
  return resolvePath(next, cwd, shell)
}

function pathArgs(list: Part[], ps: boolean) {
  if (!ps) {
    return list
      .slice(1)
      .filter((item) => !item.text.startsWith("-") && !(list[0]?.text === "chmod" && item.text.startsWith("+")))
      .map((item) => item.text)
  }

  const out: string[] = []
  let want = false
  for (const item of list.slice(1)) {
    if (want) {
      out.push(item.text)
      want = false
      continue
    }
    if (item.type === "command_parameter") {
      const flag = item.text.toLowerCase()
      if (SWITCHES.has(flag)) continue
      want = FLAGS.has(flag)
      continue
    }
    out.push(item.text)
  }
  return out
}

async function collect(root: Node, cwd: string, ps: boolean, shell: string): Promise<Scan> {
  const scan: Scan = {
    dirs: new Set<string>(),
    patterns: new Set<string>(),
    always: new Set<string>(),
  }

  for (const node of commands(root)) {
    const command = parts(node)
    const tokens = command.map((item) => item.text)
    const cmd = ps ? tokens[0]?.toLowerCase() : tokens[0]

    if (cmd && FILES.has(cmd)) {
      for (const arg of pathArgs(command, ps)) {
        const resolved = await argPath(arg, cwd, ps, shell)
        log.info("resolved path", { arg, resolved })
        if (!resolved || Instance.containsPath(resolved)) continue
        const dir = (await Filesystem.isDir(resolved)) ? resolved : path.dirname(resolved)
        scan.dirs.add(dir)
      }
    }

    if (tokens.length && (!cmd || !CWD.has(cmd))) {
      scan.patterns.add(source(node))
      scan.always.add(BashArity.prefix(tokens).join(" ") + " *")
    }
  }

  return scan
}

function preview(text: string) {
  if (text.length <= MAX_METADATA_LENGTH) return text
  return text.slice(0, MAX_METADATA_LENGTH) + "\n\n..."
}

async function parse(command: string, ps: boolean) {
  const tree = await parser().then((p) => (ps ? p.ps : p.bash).parse(command))
  if (!tree) throw new Error("Failed to parse command")
  return tree.rootNode
}

async function ask(ctx: Tool.Context, scan: Scan, command: string) {
  if (scan.dirs.size > 0) {
    const globs = Array.from(scan.dirs).map((dir) => {
      if (process.platform === "win32") return Filesystem.normalizePathPattern(path.join(dir, "*"))
      return path.join(dir, "*")
    })
    await ctx.ask({
      permission: "external_directory",
      patterns: globs,
      always: globs,
      metadata: {},
    })
  }

  if (scan.patterns.size === 0) return
  const risk = classifyCommandRisk(command)
  await ctx.ask({
    permission: "bash",
    patterns: Array.from(scan.patterns),
    always: Array.from(scan.always),
    metadata: {
      risk,
      commandCount: scan.patterns.size,
    },
  })
}

const fdShimByPath = new Map<string, string | undefined>()

async function resolveOnPath(bin: string, pathValue: string): Promise<string | undefined> {
  const dirs = pathValue.split(path.delimiter).filter(Boolean)
  if (dirs.length === 0) return
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""]
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, bin + ext)
      try {
        await access(candidate, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK)
        return candidate
      } catch {
        continue
      }
    }
  }
}

async function resolveFdShimDir(pathValue: string): Promise<string | undefined> {
  if (process.platform === "win32") return
  if (fdShimByPath.has(pathValue)) return fdShimByPath.get(pathValue)

  const fd = await resolveOnPath("fd", pathValue)
  if (fd) {
    fdShimByPath.set(pathValue, undefined)
    return
  }

  const fdfind = await resolveOnPath("fdfind", pathValue)
  if (!fdfind) {
    fdShimByPath.set(pathValue, undefined)
    return
  }

  const shimDir = path.join(vaultPath.tmpRoot(), "bash-shims")
  const shimPath = path.join(shimDir, "fd")
  const escaped = fdfind.replaceAll(`"`, `\\"`)
  await Filesystem.write(shimPath, `#!/usr/bin/env sh\nexec "${escaped}" "$@"\n`, 0o755)
  fdShimByPath.set(pathValue, shimDir)
  return shimDir
}

async function shellEnv(ctx: Tool.Context, cwd: string) {
  const extra = await ProviderPluginHooks.trigger(
    "shell.env",
    { cwd, sessionID: ctx.sessionID, callID: ctx.callID },
    { env: {} },
  )
  const scriptDirs = await secondaryToolDirs(cwd)
  const merged: NodeJS.ProcessEnv = {
    ...process.env,
    ...extra.env,
  }
  const basePath = merged.PATH ?? process.env.PATH ?? ""
  const pathParts = [...scriptDirs, basePath].filter(Boolean)
  const fdShimDir = await resolveFdShimDir(pathParts.join(path.delimiter))
  if (fdShimDir) pathParts.unshift(fdShimDir)
  if (pathParts.length > 0) {
    merged.PATH = Array.from(new Set(pathParts)).join(path.delimiter)
  }
  return merged
}

function cmd(shell: string, name: string, command: string, cwd: string, env: NodeJS.ProcessEnv) {
  if (process.platform === "win32" && PS.has(name)) {
    return ChildProcess.make(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      cwd,
      env,
      stdin: "ignore",
      detached: false,
    })
  }

  return ChildProcess.make(command, [], {
    shell,
    cwd,
    env,
    stdin: "ignore",
    detached: process.platform !== "win32",
  })
}

async function run(
  input: {
    shell: string
    name: string
    command: string
    cwd: string
    env: NodeJS.ProcessEnv
    timeout: number
    auto_background?: boolean
    description: string
  },
  ctx: Tool.Context,
) {
  let expired = false
  let aborted = false
  let backgrounded = false
  let backgroundId: string | undefined
  let backgroundOutputPath: string | undefined
  const taskOutput = new TaskOutput({
    previewTailLines: 5,
    ringCapacity: 1000,
    accumulatorMaxBytes: 8 * 1024 * 1024,
    pollerIntervalMs: 1000,
    diskFactory: (outputPath) =>
      createDiskOutput({
        outputPath,
        createParents: true,
        rotateAtBytes: 64 * 1024 * 1024,
      }),
  })

  ctx.metadata({
    metadata: {
      output: "",
      description: input.description,
    },
  })

  const destructiveWarning = getDestructiveCommandWarning(input.command)
  if (destructiveWarning) {
    ctx.metadata({ metadata: { destructive_warning: destructiveWarning } })
  }

  const extractedPaths = extractPathsFromCommand(input.command)
  if (extractedPaths) {
    ctx.metadata({ metadata: { extracted_paths: extractedPaths.paths } })
  }

  const exit = await CrossSpawnSpawner.runPromiseExit((spawner) =>
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(cmd(input.shell, input.name, input.command, input.cwd, input.env))

      yield* Effect.forkScoped(
        Stream.runForEach(Stream.decodeText(handle.all), (chunk) =>
          Effect.sync(() => {
            taskOutput.write(chunk, "stdout")
            const previewTail = taskOutput.getPreview().tailLines.join("\n")
            ctx.metadata({
              metadata: {
                output: preview(previewTail),
                description: input.description,
              },
            })
          }),
        ),
      )

      const abort = Effect.callback<void>((resume) => {
        if (ctx.abort.aborted) return resume(Effect.void)
        const handler = () => resume(Effect.void)
        ctx.abort.addEventListener("abort", handler, { once: true })
        return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
      })

      const timeout = Effect.sleep(`${input.timeout} millis`)

      const exit = yield* Effect.raceAll([
        handle.exitCode.pipe(Effect.map((code) => ({ kind: "exit" as const, code }))),
        abort.pipe(Effect.map(() => ({ kind: "abort" as const, code: null }))),
        timeout.pipe(Effect.map(() => ({ kind: "timeout" as const, code: null }))),
      ])

      if (exit.kind === "abort") {
        aborted = true
        yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
      }
      if (exit.kind === "timeout") {
        if (input.auto_background !== false) {
          // vault-as-sole-filesystem (I0.2): bg-task output lands under
          // <vault>/tmp/ instead of /tmp/, so all opencode persistence
          // shares one filesystem mount.
          const outputPath = path.join(
            vaultPath.tmpRoot(),
            `opencode-bg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`,
          )
          yield* taskOutput.switchToDisk(outputPath).pipe(Effect.orDie)

          const env: Record<string, string> = {}
          for (const [k, v] of Object.entries(input.env)) {
            if (typeof v === "string") env[k] = v
          }

          const shellCommand = new ShellCommandImpl({
            command: input.command,
            args: [],
            cwd: input.cwd,
            env,
            shell: input.shell,
            timeoutMs: input.timeout,
            forceKillAfterMs: 3000,
            output: taskOutput,
            mode: "disk",
            watchdogMaxBytes: 64 * 1024 * 1024,
            abortSignal: ctx.abort,
          })

          yield* shellCommand.start()
          const bg = yield* shellCommand.background()

          backgroundRegistry.register({
            id: bg.id,
            pid: bg.pid,
            command: input.command,
            cwd: input.cwd,
            startedAt: bg.startedAt,
            outputPath: bg.outputPath || outputPath,
            shellCommand,
            output: taskOutput,
          })

          shellCommand.onExit((info) => {
            backgroundRegistry.markExited(bg.id, info)
            void taskOutput.finalize({ persist: true }).pipe(Effect.runPromise)
          })

          backgrounded = true
          backgroundId = bg.id
          backgroundOutputPath = bg.outputPath || outputPath

          yield* Effect.sync(() => {
            Effect.runFork(handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie))
          })

          return {
            code: null,
            snapshot: taskOutput.getSnapshot(),
          }
        }

        expired = true
        yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
      }

      // Small delay to allow the stream reader to drain remaining output
      yield* Effect.sleep("50 millis")

      const snapshot = yield* taskOutput.finalize({ persist: false })

      return {
        code: exit.kind === "exit" ? exit.code : null,
        snapshot,
      }
    }).pipe(Effect.scoped, Effect.orDie),
  )

  let code: number | null = null
  let output = ""
  if (Exit.isSuccess(exit)) {
    const value = exit.value as { code: number | null; snapshot: { combined: string } }
    code = value.code
    output = value.snapshot.combined
  } else if (!Cause.hasInterruptsOnly(exit.cause)) {
    throw Cause.squash(exit.cause)
  }

  const meta: string[] = []
  if (expired) meta.push(`bash tool terminated command after exceeding timeout ${input.timeout} ms`)
  if (aborted) meta.push("User aborted the command")
  if (meta.length > 0) {
    output = [output, "\n\n<bash_metadata>\n", meta.join("\n"), "\n</bash_metadata>"].join("")
  }

  return {
    title: input.description,
    metadata: {
      output: preview(output),
      exit: code,
      description: input.description,
      backgrounded,
      backgroundId,
      outputPath: backgroundOutputPath,
    },
    output,
  }
}

function hasOutputLimiter(command: string): boolean {
  return (
    /\|\s*(?:head|tail|rg|awk|sed|jq|wc)\b/.test(command) ||
    /(?:^|\s)>(?:>|)\s*\S+/.test(command) ||
    /--(?:stat|shortstat|name-only|name-status|numstat|count|files-with-matches)\b/.test(command) ||
    /\s-[A-Za-z]*[lnc][A-Za-z]*\b/.test(command) ||
    hasBoundedFind(command)
  )
}

function hasBoundedFind(command: string): boolean {
  if (!/^\s*find\b/.test(command)) return false

  const maxDepth = command.match(/(?:^|\s)-maxdepth\s+(\d+)\b/)
  if (maxDepth) {
    const value = Number.parseInt(maxDepth[1]!, 10)
    if (Number.isFinite(value) && value >= 0 && value <= 3) return true
  }

  return /(?:^|\s)-(?:quit|empty)\b/.test(command)
}

const DISALLOWED_SEARCH_COMMANDS = new Set(["ag", "ack"])

function isShellAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)
}

function shellInvocationTokens(commandPart: string): string[] {
  let current = stripSafeWrappers(commandPart.trim())
  try {
    current = stripLeadingEnvVars(current)
  } catch {
    // Security checks report binary-hijack env vars elsewhere; keep this helper best-effort.
  }

  let args = tokens(current)
  if (args[0]?.toLowerCase() === "env") {
    args = args.slice(1)
    while (args.length > 0) {
      const arg = args[0]!
      if (arg === "--") {
        args = args.slice(1)
        break
      }
      if (arg.startsWith("-") || isShellAssignment(arg)) {
        args = args.slice(1)
        continue
      }
      break
    }
  }

  while (["command", "builtin"].includes(args[0]?.toLowerCase() ?? "")) args = args.slice(1)
  return args
}

function disallowedSearchMessage(name: string): string {
  if (name === "git grep") return "git grep is disallowed for search/discovery; prefer rg or fdfind"
  return `${name} is disallowed for search/discovery; prefer rg or fdfind`
}

function hasDisallowedSearchToolIssue(command: string): string | null {
  const stripped = stripSafeWrappers(stripLeadingComments(command))
  if (!stripped) return null

  const logical = splitLogicalSegments(stripped)
  for (const segment of logical) {
    for (const pipeSegment of splitPipeSegments(segment)) {
      const part = stripSafeWrappers(pipeSegment.trim())
      if (!part) continue
      const args = shellInvocationTokens(part)
      const base = args[0]?.toLowerCase()
      if (!base) continue

      if (DISALLOWED_SEARCH_COMMANDS.has(base)) return disallowedSearchMessage(base)
      if (base === "git" && args[1]?.toLowerCase() === "grep") return disallowedSearchMessage("git grep")
      if (base === "xargs") {
        const disallowed = args.find((arg) => DISALLOWED_SEARCH_COMMANDS.has(arg.toLowerCase()))
        if (disallowed) return disallowedSearchMessage(disallowed.toLowerCase())
      }
      if (base === "find") {
        for (let i = 1; i < args.length - 1; i++) {
          if (args[i] !== "-exec") continue
          const execBase = args[i + 1]?.toLowerCase()
          if (execBase && DISALLOWED_SEARCH_COMMANDS.has(execBase)) return disallowedSearchMessage(execBase)
        }
      }
    }
  }
  return null
}

function hasApplyPatchViaBashIssue(command: string): string | null {
  const stripped = stripSafeWrappers(stripLeadingComments(command))
  if (!stripped) return null

  const logical = splitLogicalSegments(stripped)
  for (const segment of logical) {
    for (const pipeSegment of splitPipeSegments(segment)) {
      const part = stripSafeWrappers(pipeSegment.trim())
      if (!part) continue
      const args = shellInvocationTokens(part)
      const base = args[0]?.toLowerCase()
      if (base === "apply_patch") {
        return "apply_patch must not be invoked through bash; use the native apply_patch tool when available, otherwise use targeted sed/Python edits"
      }
      if (base === "xargs" && args.some((arg) => arg.toLowerCase() === "apply_patch")) {
        return "apply_patch must not be invoked through bash; use the native apply_patch tool when available, otherwise use targeted sed/Python edits"
      }
      if (base === "find") {
        for (let i = 1; i < args.length - 1; i++) {
          if (args[i] === "-exec" && args[i + 1]?.toLowerCase() === "apply_patch") {
            return "apply_patch must not be invoked through bash; use the native apply_patch tool when available, otherwise use targeted sed/Python edits"
          }
        }
      }
    }
  }
  return null
}

function tokens(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean)
}

function shortFlagIncludes(text: string, char: string): boolean {
  return new RegExp(`(?:^|\\s)-[A-Za-z]*${char}[A-Za-z]*\\b`).test(text)
}

function isRepoRootLikePath(token: string): boolean {
  return token === "." || token === "./" || token === "$PWD" || token === "${PWD}"
}

function hasGitignoreBypassIssue(command: string): string | null {
  const stripped = stripSafeWrappers(stripLeadingComments(command))
  if (!stripped) return null
  const logical = splitLogicalSegments(stripped)
  for (const segment of logical) {
    for (const pipeSegment of splitPipeSegments(segment)) {
      const part = stripSafeWrappers(pipeSegment.trim())
      if (!part) continue
      const base = part.split(/\s+/)[0]?.toLowerCase()
      if (!base) continue

      if (base === "rg") {
        if (/(?:^|\s)--no-ignore(?:-vcs|-dot|-parent)?\b/.test(part) || shortFlagIncludes(part, "u")) {
          return "rg disables .gitignore with --no-ignore/-u; use default rg/fd behavior for repo discovery"
        }
        continue
      }

      if (base === "fd" || base === "fdfind") {
        if (
          /(?:^|\s)--(?:unrestricted|no-ignore|no-ignore-vcs)\b/.test(part) ||
          shortFlagIncludes(part, "u") ||
          shortFlagIncludes(part, "I")
        ) {
          return "fd/fdfind disables .gitignore with --unrestricted/--no-ignore/-u/-I; keep ignore rules enabled"
        }
        continue
      }

      if (base === "find") {
        const args = tokens(part)
        const first = args[1]
        if (!first || first.startsWith("-") || isRepoRootLikePath(first)) {
          return "find over repo root can ignore .gitignore; prefer fd/rg or narrow to explicit paths"
        }
        continue
      }

      if (base === "tree") {
        if (!/(?:^|\s)--gitignore\b/.test(part)) {
          return "tree without --gitignore may include ignored files; add --gitignore or use fd"
        }
        continue
      }

      if (base === "ls") {
        if (shortFlagIncludes(part, "R")) {
          const args = tokens(part)
            .slice(1)
            .filter((arg) => !arg.startsWith("-"))
          if (args.length === 0 || args.some(isRepoRootLikePath)) {
            return "ls -R over repo root can include ignored files; prefer fd/rg or git ls-files"
          }
        }
      }
    }
  }
  return null
}

function noisyCommandAdvice(command: string, issue: string): string {
  const c = command.trim()
  if (issue.includes("grep is disallowed")) {
    return `${issue}. Use \`rg -n <pattern> <path>\` for content search/filtering or \`fdfind <name> <path>\` for file discovery.`
  }
  if (issue.includes(".gitignore")) {
    return `${issue}. Prefer gitignore-aware discovery: \`rg -n <pattern> <path>\`, \`fd/fdfind <pattern> <path>\`, or \`git ls-files | rg <pattern>\`.`
  }
  if (/\bgit\s+diff\b/.test(c)) {
    return `${issue}. Use \`git diff -- <file> | sed -n '100,260p'\` for targeted context or \`git diff --stat\` for summary.`
  }
  if (/^\s*find\b/.test(c)) {
    return `${issue}. Safe find patterns: add -maxdepth 3, pipe to head/sed/wc, or run a small Python/Bun summarizer that prints counts and <=20 curated paths.`
  }
  if (/^\s*(?:cat|tail)\b/.test(c)) {
    return `${issue}. Use targeted reads: nl -ba <file> | sed -n '80,140p', or a small Python/Bun summarizer that emits only needed ranges/hits; avoid raw full-file dumps.`
  }
  if (/^\s*(?:rg|fd|fdfind)\b/.test(c)) {
    return `${issue}. Use -l/--count, pipe to head, or write a small summarizer script for broad discovery.`
  }
  return `${issue}. Add rg/head/jq/sed/wc, redirect to a file, use a summarizer program, or use mode=background.`
}

function largeDiscoveryPreviewIssue(command: string): string | null {
  if (!/\b(?:rg|fd|fdfind|find)\b/.test(command)) return null
  if (!/[;\n]/.test(command)) return null

  const headLimits = [...command.matchAll(/\|\s*head(?:\s+(?:-n\s*)?(\d+)|\s+-(\d+))?/g)].map((match) => {
    const raw = match[1] ?? match[2]
    return raw ? Number.parseInt(raw, 10) : 10
  })

  if (headLimits.length < 2) return null
  const previewLines = headLimits.reduce((sum, limit) => sum + (Number.isFinite(limit) ? limit : 10), 0)
  if (previewLines <= 40) return null

  return `multi-part discovery preview would dump ${previewLines} lines; return counts + <=20 curated lines + next narrower query`
}

const TEST_OR_BUILD_COMMAND = /\b(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+(?:test|build|typecheck|lint|check))\b/
const PYTHON_PATHLIB_IMPORT_ERROR = /ImportError:\s+No module named pathlib/

function hasFailureFocusedOutput(command: string): boolean {
  return (
    /\|\s*rg\b[^|;]*(?:error|fail|exception|panic|traceback|fatal)/i.test(command) ||
    /(?:^|\s)>(?:>|)\s*\S+/.test(command) ||
    /mode=background/.test(command)
  )
}

export function rewritePythonForPathlibFallback(command: string): string | null {
  const newline = command.indexOf("\n")
  const firstLine = newline === -1 ? command : command.slice(0, newline)
  if (!/\bpython\b/.test(firstLine) || /\bpython3\b/.test(firstLine)) return null
  const rewritten = firstLine.replace(/\bpython\b/, "python3")
  if (rewritten === firstLine) return null
  return newline === -1 ? rewritten : rewritten + command.slice(newline)
}

export function shouldRetryWithPython3ForPathlib(input: {
  command: string
  output: string
  exit: number | null | undefined
}): boolean {
  if (!input.command.trim()) return false
  if (input.exit === 0 || input.exit === null || input.exit === undefined) return false
  if (!PYTHON_PATHLIB_IMPORT_ERROR.test(input.output)) return false
  return rewritePythonForPathlibFallback(input.command) !== null
}

type HeredocRepair = {
  command: string
  message: string
}

type PendingHeredoc = {
  delimiter: string
  openerLine: number
}

function heredocTerminatorParts(line: string, delimiter: string): { indent: string; suffix: string } | null {
  const match = line.match(/^(\s*)(\S+)(.*)$/)
  if (!match || match[2] !== delimiter) return null
  return { indent: match[1]!, suffix: match[3]!.trimStart() }
}

function isRepairableHeredocSuffix(suffix: string): boolean {
  return /^(?:\||>{1,2}|[12]?>|&>)/.test(suffix.trimStart())
}

export function repairMalformedHeredocCommand(command: string): HeredocRepair | null {
  const pending: PendingHeredoc[] = []
  const lines = command.split(/\r?\n/)
  const repairs: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    for (const match of line.matchAll(/<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/g)) {
      const delimiter = match[1] ?? match[2] ?? match[3]
      if (delimiter) pending.push({ delimiter, openerLine: i + 1 })
    }

    for (let j = pending.length - 1; j >= 0; j--) {
      const { delimiter, openerLine } = pending[j]!
      const trimmed = line.trim()
      if (trimmed === delimiter) {
        pending.splice(j, 1)
        continue
      }

      const parts = heredocTerminatorParts(line, delimiter)
      if (!parts?.suffix) continue
      if (!isRepairableHeredocSuffix(parts.suffix)) continue

      const openerIndex = openerLine - 1
      const opener = lines[openerIndex] ?? ""
      lines[openerIndex] = `${opener}${/\s$/.test(opener) ? "" : " "}${parts.suffix}`
      lines[i] = `${parts.indent}${delimiter}`
      pending.splice(j, 1)
      repairs.push(`moved '${parts.suffix}' from heredoc terminator line ${i + 1} to opener line ${openerLine}`)
    }
  }

  if (!repairs.length) return null
  return { command: lines.join("\n"), message: repairs.join("; ") }
}

export function getMalformedHeredocIssue(command: string): string | null {
  const pending: PendingHeredoc[] = []
  const lines = command.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    for (const match of line.matchAll(/<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/g)) {
      const delimiter = match[1] ?? match[2] ?? match[3]
      if (delimiter) pending.push({ delimiter, openerLine: i + 1 })
    }
    for (let j = pending.length - 1; j >= 0; j--) {
      const { delimiter, openerLine } = pending[j]!
      const trimmed = line.trim()
      if (trimmed === delimiter) {
        pending.splice(j, 1)
        continue
      }

      const parts = heredocTerminatorParts(line, delimiter)
      if (!parts?.suffix) continue
      const rewrite = isRepairableHeredocSuffix(parts.suffix)
        ? ` Rewrite as: put '${parts.suffix}' on line ${openerLine} and leave line ${i + 1} as '${delimiter}'.`
        : ""
      return `heredoc terminator "${delimiter}" from line ${openerLine} must be alone on its line; pipe/filter after the command, not after the terminator.${rewrite}`
    }
  }
  return null
}

export function getNoisyCommandIssue(command: string): string | null {
  const c = command.trim()
  if (!c) return null
  const applyPatchIssue = hasApplyPatchViaBashIssue(c)
  if (applyPatchIssue) return applyPatchIssue
  const searchToolIssue = hasDisallowedSearchToolIssue(c)
  if (searchToolIssue) return searchToolIssue
  if (TEST_OR_BUILD_COMMAND.test(c) && !hasFailureFocusedOutput(c)) {
    return "test/build command needs rg-filtered errors/failures, log redirect, or background mode"
  }
  const discoveryPreviewIssue = largeDiscoveryPreviewIssue(c)
  if (discoveryPreviewIssue) return discoveryPreviewIssue
  const gitignoreIssue = hasGitignoreBypassIssue(c)
  if (gitignoreIssue) return gitignoreIssue
  if (hasOutputLimiter(c)) return null
  if (/\bgit\s+diff\b/.test(c)) return "git diff needs --stat/--name-only or a pipe"
  if (/\bgit\s+log\b/.test(c) && !/\b(?:--oneline|--max-count|-n)\b/.test(c))
    return "git log needs --oneline/-n or a pipe"
  if (/^\s*(?:cat|tail|find)\b/.test(c)) return "raw file/list command needs a pipe, -maxdepth, or line limit"
  if (/^\s*(?:rg|fd|fdfind)\b/.test(c)) return "search command needs -l/count/head or another limiter"
  return null
}

const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const { default: psWasm } = await import("tree-sitter-powershell/tree-sitter-powershell.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const psPath = resolveWasm(psWasm)
  const [bashLanguage, psLanguage] = await Promise.all([Language.load(bashPath), Language.load(psPath)])
  const bash = new Parser()
  bash.setLanguage(bashLanguage)
  const ps = new Parser()
  ps.setLanguage(psLanguage)
  return { bash, ps }
})

/**
 * Classifies a bash command for UI display purposes.
 * Returns whether the command is for search, read, or list operations.
 * Uses the BASH_SEARCH_COMMANDS, BASH_READ_COMMANDS, BASH_LIST_COMMANDS,
 * BASH_SEMANTIC_NEUTRAL_COMMANDS, and BASH_SILENT_COMMANDS sets defined below.
 */
export function classifyBashCommand(command: string): {
  isSearch: boolean
  isRead: boolean
  isList: boolean
  isSilent: boolean
} {
  // Simple command splitting by operators
  const parts = command.split(/(\|\||\&\&|\||;)/)
  let hasSearch = false
  let hasRead = false
  let hasList = false
  let hasNonNeutralCommand = false
  let isSilent = false

  for (const part of parts) {
    const trimmed = part.trim()
    if (!trimmed || trimmed === "||" || trimmed === "&&" || trimmed === "|" || trimmed === ";") {
      continue
    }

    const baseCommand = trimmed.split(/\s+/)[0]
    if (!baseCommand) continue

    // Skip semantic-neutral commands
    if (BASH_SEMANTIC_NEUTRAL_COMMANDS.has(baseCommand)) continue

    hasNonNeutralCommand = true
    if (BASH_SEARCH_COMMANDS.has(baseCommand)) hasSearch = true
    if (BASH_READ_COMMANDS.has(baseCommand)) hasRead = true
    if (BASH_LIST_COMMANDS.has(baseCommand)) hasList = true
    if (BASH_SILENT_COMMANDS.has(baseCommand)) isSilent = true
  }

  // For compound commands, require ALL parts to be search/read/list
  // for the whole to be classified as such
  const operators = command.split(/[^\|\&\;]+/).filter((o) => o.trim())
  const isCompound = operators.length > 1

  if (isCompound && hasNonNeutralCommand) {
    // In compound commands, if any part is non-neutral, don't classify as search/read
    return { isSearch: false, isRead: false, isList: false, isSilent }
  }

  return { isSearch: hasSearch, isRead: hasRead, isList: hasList, isSilent }
}

// Plan-mode readonly guard: returns the first mutating token found, or null if safe.
// Covers: output redirects, pipes-to-write, destructive commands, git mutations,
// package manager installs, and common file-modification utilities.
export function isMutatingCommand(cmd: string): string | null {
  // Output redirects: > file, >> file, &> file (but NOT stderr-only like 2>/dev/null, 2>&1)
  // Allow: 2>/dev/null, 2>&1, 2>&-, etc. (stderr-only to special files)
  // Block: stdout or combined redirects to regular files
  const hasDangerousRedirect = /(?:^|[;&|])\s*[^|]*(?:>>?|&>)\s*\S/.test(cmd)
  const hasStderrOnlyToSafe =
    /2>(?:\/dev\/null|&1|&-|\/dev\/stderr)/.test(cmd) || /2>&1/.test(cmd) || /2>\/dev\/null/.test(cmd)
  if (hasDangerousRedirect && !hasStderrOnlyToSafe) return "output redirect (> or >>)"

  // Pipe to write utilities
  if (/\|\s*(?:tee|dd|sponge)\b/.test(cmd)) return "pipe to write utility (tee/dd/sponge)"

  const trimmed = cmd.trim()
  const isInterpreter = /^(?:poetry\s+run\s+|xvfb-run\s+)?\b(?:python[0-9.]*|node|bun|tsx|ts-node|vitest|eslint|tsgo)\b/.test(trimmed) || /^\/usr\/bin\/python/.test(trimmed)
  if (isInterpreter) {
    if (/\b(?:npm|yarn|pnpm|bun)\s+(?:install|add|remove|uninstall|update|upgrade|link|publish)\b/.test(cmd))
      return "package manager mutation"
    if (/\bpip\s+(?:install|uninstall|download)\b/.test(cmd)) return "pip mutation"
    return null
  }

  // Destructive filesystem commands
  const destructive = [
    /\brm\s+(?!.*--help)/,
    /\bmv\b/,
    /\bcp\b/,
    /\bmkdir\b/,
    /\btouch\b/,
    /\bchmod\b/,
    /\bchown\b/,
    /\bln\b/,
    /\btruncate\b/,
    /\binstall\b/,
    /\brsync\b.*--delete/,
    /\bfind\b.*-delete/,
    /\bfind\b.*-exec\s+rm/,
  ]
  for (const re of destructive) {
    const m = cmd.match(re)
    if (m) return m[0].trim()
  }

  // sed with in-place flag
  if (/\bsed\s+[^|]*-i/.test(cmd)) return "sed -i (in-place edit)"

  // awk with output
  if (/\bawk\b.*>\s*\S/.test(cmd)) return "awk with output redirect"

  // Git mutation commands
  const gitMutations = [
    "add",
    "commit",
    "push",
    "pull",
    "fetch",
    "merge",
    "rebase",
    "reset",
    "checkout",
    "switch",
    "restore",
    "stash",
    "tag",
    "branch -d",
    "branch -D",
    "branch -m",
    "clean",
    "apply",
    "cherry-pick",
    "revert",
    "am",
    "format-patch",
  ]
  for (const sub of gitMutations) {
    if (new RegExp(`\\bgit\\s+${sub.replace(" ", "\\s+")}\\b`).test(cmd)) return `git ${sub}`
  }

  // Package managers (install/remove/update)
  if (/\b(?:npm|yarn|pnpm|bun)\s+(?:install|add|remove|uninstall|update|upgrade|link|publish)\b/.test(cmd))
    return "package manager mutation"

  // Python/pip mutations
  if (/\bpip\s+(?:install|uninstall|download)\b/.test(cmd)) return "pip mutation"

  // Make / cmake / build systems that write artifacts
  if (/\b(?:make|cmake|ninja|gradle|mvn)\b(?!\s+(?:help|--help|-h|test|check|verify|lint))/.test(cmd))
    return "build system command"

  return null
}

// Dangerous-command detection: catches catastrophic commands in ALL modes.
// Returns a description of the dangerous pattern, or null if safe.
export function isDangerousCommand(cmd: string): string | null {
  // Root filesystem deletion
  if (/\brm\s+.*--no-preserve-root/.test(cmd)) return "rm --no-preserve-root"
  if (/\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\s+(\/\*?|~\/?\*?)\s*$/.test(cmd)) return "rm -rf on root or home"
  // Disk overwrite
  if (/\bdd\s+.*\bif=\/dev\/(zero|random|urandom)\b.*\bof=/.test(cmd)) return "dd disk overwrite"
  if (/\bdd\s+.*\bof=\/dev\/[a-z]+\b/.test(cmd)) return "dd write to device"
  // Filesystem format
  if (/\bmkfs\b/.test(cmd)) return "mkfs (filesystem format)"
  // Fork bomb
  if (/:\(\)\s*\{/.test(cmd)) return "fork bomb"
  // Raw disk write via redirect
  if (/>\s*\/dev\/[sh]d[a-z]/.test(cmd)) return "raw disk write"
  // chmod -R on root
  if (/\bchmod\s+-R\s+\d+\s+\/\s*$/.test(cmd)) return "chmod -R on root"
  return null
}

// ─── Phase 3: Permission normalization and compound-command handling ───

// 18. Heredoc prefix extraction for always-patterns
export function extractHeredocPrefix(cmd: string): string | null {
  if (!cmd.includes("<<")) return null
  const idx = cmd.indexOf("<<")
  if (idx <= 0) return null
  const before = cmd.substring(0, idx).trim()
  if (!before) return null
  const tokens = before.split(/\s+/).filter(Boolean)
  if (tokens.length >= 2) {
    if (/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(tokens[1]!)) {
      return tokens.slice(0, 2).join(" ")
    }
  }
  if (tokens.length >= 1) return tokens[0]!
  return null
}

// 18b. Safe heredoc substitution detection and stripping
// Strips $(cat <<'DELIM' ... DELIM) patterns so they don't trigger hasProcessSubstitution false positives
export function hasSafeHeredocSubstitution(command: string): boolean {
  return /\$\(\s*cat\s*<<\s*'[^']+'\s*\n[\s\S]*?\n\s*[^']+\s*\)/.test(command)
}

export function stripSafeHeredocSubstitutions(command: string): string {
  // Remove $(cat <<'DELIM' ... DELIM) spans
  return command.replace(/\$\(\s*cat\s*<<\s*'([^']+)'\s*\n[\s\S]*?\n\s*\1\s*\)/g, "''")
}

// 19. Improved safe wrapper stripping (comprehensive patterns from openclaude)
const SAFE_WRAPPER_PATTERNS = [
  // sudo: all forms
  /^sudo[ \t]+(?:--[ \t]+)?/,
  // timeout: GNU long flags, short flags with allowlisted values
  /^timeout[ \t]+(?:(?:--(?:foreground|preserve-status|verbose)|--(?:kill-after|signal)=[A-Za-z0-9_.+-]+|--(?:kill-after|signal)[ \t]+[A-Za-z0-9_.+-]+|-v|-[ks][ \t]+[A-Za-z0-9_.+-]+|-[ks][A-Za-z0-9_.+-]+)[ \t]+)*(?:--[ \t]+)?\d+(?:\.\d+)?[smhd]?[ \t]+/,
  // time
  /^time[ \t]+(?:--[ \t]+)?/,
  // nice: all forms (bare, -n N, -N)
  /^nice(?:[ \t]+-n[ \t]+-?\d+|[ \t]+-\d+)?[ \t]+(?:--[ \t]+)?/,
  // stdbuf: fused short flags
  /^stdbuf(?:[ \t]+-[ioe][LN0-9]+)+[ \t]+(?:--[ \t]+)?/,
  // nohup
  /^nohup[ \t]+(?:--[ \t]+)?/,
] as const

export function stripSafeWrappers(cmd: string): string {
  let stripped = cmd.trim()
  let previousStripped = ""
  while (stripped !== previousStripped) {
    previousStripped = stripped
    for (const pattern of SAFE_WRAPPER_PATTERNS) {
      stripped = stripped.replace(pattern, "").trim()
    }
  }
  return stripped
}

// 20. Pipe-segment splitting (quote-aware)
export function splitPipeSegments(cmd: string): string[] {
  const segments: string[] = []
  let current = ""
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false
  for (let i = 0; i < cmd.length; i++) {
    const char = cmd[i]
    if (escaped) {
      escaped = false
      current += char
      continue
    }
    if (char === "\\" && !inSingleQuote) {
      escaped = true
      current += char
      continue
    }
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      current += char
      continue
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      current += char
      continue
    }
    if (char === "|" && !inSingleQuote && !inDoubleQuote) {
      const next = cmd[i + 1]
      if (next === "|" || next === "&") {
        // Consume both characters of || or |&
        current += char + next
        i++
        continue
      }
      segments.push(current.trim())
      current = ""
      continue
    }
    current += char
  }
  if (current.trim()) segments.push(current.trim())
  return segments
}

// 21. Pipe-segment analysis for unsafe compound detection
export function analyzePipeSegments(cmd: string): {
  hasUnsafeCompound: boolean
  pipeSegments: string[]
} {
  const segments = splitPipeSegments(cmd)
  // Strip single-quoted and double-quoted strings to avoid false positives
  // from parentheses/braces inside quoted arguments (e.g. bun -e 'Array.from({...})')
  const stripped = cmd.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""')
  const hasUnsafeCompound = /\([^)]*\)/.test(stripped) || /\{[^}]*\}/.test(stripped)
  return { hasUnsafeCompound, pipeSegments: segments }
}

// 21b. Logical segment splitting (&&, ||, ; — top-level only, quote-aware)
export function splitLogicalSegments(command: string): string[] {
  const segments: string[] = []
  let current = ""
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false
  let depth = 0
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!
    if (escaped) {
      escaped = false
      current += char
      continue
    }
    if (char === "\\" && !inSingleQuote) {
      escaped = true
      current += char
      continue
    }
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      current += char
      continue
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      current += char
      continue
    }
    if (!inSingleQuote && !inDoubleQuote) {
      if (char === "(" || char === "{") {
        depth++
        current += char
        continue
      }
      if (char === ")" || char === "}") {
        depth--
        current += char
        continue
      }
      if (depth === 0) {
        if ((char === "&" || char === "|") && command[i + 1] === char) {
          if (current.trim()) segments.push(current.trim())
          current = ""
          i++
          continue
        }
        if (char === ";") {
          if (current.trim()) segments.push(current.trim())
          current = ""
          continue
        }
      }
    }
    current += char
  }
  if (current.trim()) segments.push(current.trim())
  return segments.length > 0 ? segments : [command]
}

export function hasCdPlusGitAcrossSegments(segments: string[]): boolean {
  if (segments.length < 2) return false
  let hasCd = false
  for (const seg of segments) {
    const base = seg.trim().split(/\s+/)[0]
    if (base === "cd") hasCd = true
    if (hasCd && base === "git") return true
  }
  return false
}

// 22. Comment label extraction for UI display
export function extractBashCommentLabel(cmd: string): string | undefined {
  const nl = cmd.indexOf("\n")
  const firstLine = nl === -1 ? cmd : cmd.slice(0, nl)
  const trimmed = firstLine.trim()
  if (!trimmed.startsWith("#") || trimmed.startsWith("#!")) return undefined
  const label = trimmed.replace(/^#+\s*/, "")
  return label || undefined
}

// This bash-oriented tool also runs on other accepted shells; keep shell-specific
// behavior isolated below. Throws immediately if the var name is a binary-hijack variable.
const BINARY_HIJACK_VARS = new Set([
  "PATH",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
])
const ENV_VAR_PREFIX = /^([A-Z_][A-Z0-9_]*)=\S*\s+/

export function stripLeadingEnvVars(cmd: string): string {
  let current = cmd.trim()
  let match: RegExpMatchArray | null
  while ((match = current.match(ENV_VAR_PREFIX))) {
    const varName = match[1]
    if (BINARY_HIJACK_VARS.has(varName)) {
      throw new Error(`Dangerous env var assignment blocked: "${varName}=" can hijack binary resolution.`)
    }
    current = current.slice(match[0].length).trim()
  }
  return current
}

// Strip leading comment lines (lines starting with #) but preserve shebangs (#!).
export function stripLeadingComments(cmd: string): string {
  return cmd
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim()
      return !trimmed.startsWith("#") || trimmed.startsWith("#!")
    })
    .join("\n")
    .trim()
}

// Classify command risk level based on patterns.
export function classifyCommandRisk(cmd: string): "safe" | "low" | "medium" | "high" | "critical" {
  // Strip safe heredoc substitutions before security checks to avoid false positives
  const strippedCmd = stripSafeHeredocSubstitutions(cmd)
  // Critical: dangerous commands (already blocked, but classify for metadata)
  if (isDangerousCommand(strippedCmd)) return "critical"
  // High: output redirect to system paths, pipe to dd/sponge
  if (/(?:>>?|&>|2>)\s*\/(?:etc|usr|bin|sbin|lib|boot|sys|proc)/.test(strippedCmd)) return "high"
  if (/\|\s*(?:dd|sponge)\b/.test(strippedCmd)) return "high"
  // Medium: output redirect, pipe to tee, sed -i, awk with output
  if (/(?:>>?|&>|2>)\s*\S/.test(strippedCmd)) return "medium"
  if (/\|\s*tee\b/.test(strippedCmd)) return "medium"
  if (/\bsed\s+[^|]*-i/.test(strippedCmd)) return "medium"
  if (/\bawk\b.*>\s*\S/.test(strippedCmd)) return "medium"
  // Low: filesystem mutation, package manager mutations, git mutations
  if (/\b(?:rm|mv|cp|mkdir|touch|chmod|chown|ln|truncate)\b/.test(strippedCmd)) return "low"
  if (/\b(?:npm|yarn|pnpm|bun)\s+(?:install|add|remove|uninstall|update|upgrade)\b/.test(strippedCmd)) return "low"
  if (/\bgit\s+(?:add|commit|push|pull|merge|rebase|reset|checkout|stash)\b/.test(strippedCmd)) return "low"
  // Compound: cd+git cross-segment bypass
  const logicalSegs = splitLogicalSegments(strippedCmd)
  if (hasCdPlusGitAcrossSegments(logicalSegs)) return "medium"
  // Safe: read-only commands
  return "safe"
}

// ─── Parser-differential security checks (ported from openclaude) ───

// 1. Control character detection

const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/

export function hasControlCharacters(cmd: string): boolean {
  return CONTROL_CHAR_RE.test(cmd)
}

// 2. Unicode whitespace detection

const UNICODE_WS_RE = /[\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]/

export function hasUnicodeWhitespace(cmd: string): boolean {
  return UNICODE_WS_RE.test(cmd)
}

// 3. Backslash-escaped whitespace detection
export function hasBackslashEscapedWhitespace(cmd: string): boolean {
  let inSingleQuote = false
  let inDoubleQuote = false
  for (let i = 0; i < cmd.length; i++) {
    const char = cmd[i]
    if (char === "\\" && !inSingleQuote) {
      if (!inDoubleQuote) {
        const next = cmd[i + 1]
        if (next === " " || next === "\t") return true
      }
      i++ // skip escaped char
      continue
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }
  }
  return false
}

// 4. Backslash-escaped operator detection
const SHELL_OPERATORS = new Set([";", "|", "&", "<", ">"])

export function hasBackslashEscapedOperator(cmd: string): boolean {
  let inSingleQuote = false
  let inDoubleQuote = false
  for (let i = 0; i < cmd.length; i++) {
    const char = cmd[i]
    if (char === "\\" && !inSingleQuote) {
      if (!inDoubleQuote) {
        const next = cmd[i + 1]
        if (next && SHELL_OPERATORS.has(next)) return true
      }
      i++ // skip escaped char
      continue
    }
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }
  }
  return false
}

// 5. Brace expansion detection
export function hasBraceExpansion(cmd: string): boolean {
  if (!cmd.includes("{")) return false
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false
  for (let i = 0; i < cmd.length; i++) {
    const char = cmd[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === "\\" && !inSingleQuote) {
      escaped = true
      continue
    }
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }
    if (!inSingleQuote && !inDoubleQuote && char === "{") {
      let depth = 1
      for (let j = i + 1; j < cmd.length; j++) {
        const ch = cmd[j]
        if (ch === "{") depth++
        else if (ch === "}") {
          depth--
          if (depth === 0) break
        } else if (depth === 1 && (ch === "," || (ch === "@/tool/bash" && cmd[j + 1] === "@/tool/bash"))) return true
      }
    }
  }
  return false
}

// 6. Incomplete command detection
export function isIncompleteCommand(cmd: string): string | null {
  const trimmed = cmd.trim()
  if (!trimmed) return null
  if (/^\s*\t/.test(cmd)) return "incomplete fragment (starts with tab)"
  if (trimmed.startsWith("-")) return "incomplete fragment (starts with flags)"
  if (/^\s*(&&|\|\||;|>>?|<)/.test(cmd)) return "continuation line (starts with operator)"
  return null
}

// 7. Process substitution detection
export function hasProcessSubstitution(cmd: string): string | null {
  if (/<\(/.test(cmd)) return "process substitution <()"
  if (/>\(/.test(cmd)) return "process substitution >()"
  if (/(?:^|[\s;&|])=[a-zA-Z_]/.test(cmd)) return "Zsh equals expansion (=cmd)"
  if (/\$\(/.test(cmd)) return "$() command substitution"
  if (/\$\{/.test(cmd)) return "${} parameter substitution"
  if (/\$\[/.test(cmd)) return "$[] legacy arithmetic expansion"
  if (/~\[/.test(cmd)) return "Zsh-style parameter expansion"
  return null
}

// 8. IFS injection detection
export function hasIFSInjection(cmd: string): boolean {
  if (/^IFS\s*=\S/.test(cmd.trim())) return true
  if (/\bIFS\b.*[=+\s]/.test(cmd) && /\b(rm|mv|cp|chmod|chown|cat|find|grep)\b/.test(cmd)) return true
  return false
}

// 9. Proc/environ access detection
export function hasProcEnvironAccess(cmd: string): boolean {
  return /\/proc\/\d+\/environ/.test(cmd) || /\/proc\/self\/environ/.test(cmd)
}

// 10. Comment-quote desync detection
export function hasCommentQuoteDesync(cmd: string): boolean {
  if (!cmd.includes("#") || (!cmd.includes("'") && !cmd.includes('"'))) return false
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false
  for (let i = 0; i < cmd.length; i++) {
    const char = cmd[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (inSingleQuote) {
      if (char === "'") inSingleQuote = false
      continue
    }
    if (char === "\\") {
      escaped = true
      continue
    }
    if (inDoubleQuote) {
      if (char === '"') inDoubleQuote = false
      continue
    }
    if (char === "'") {
      inSingleQuote = true
      continue
    }
    if (char === '"') {
      inDoubleQuote = true
      continue
    }
    if (char === "#") {
      const lineEnd = cmd.indexOf("\n", i)
      const commentText = cmd.slice(i + 1, lineEnd === -1 ? cmd.length : lineEnd)
      if (/['"]/.test(commentText)) return true
      if (lineEnd === -1) break
      i = lineEnd
    }
  }
  return false
}

// 11. Quoted-newline-hash detection
export function hasQuotedNewlineHash(cmd: string): boolean {
  if (!cmd.includes("\n") || !cmd.includes("#")) return false
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false
  for (let i = 0; i < cmd.length; i++) {
    const char = cmd[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === "\\" && !inSingleQuote) {
      escaped = true
      continue
    }
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }
    if (char === "\n" && (inSingleQuote || inDoubleQuote)) {
      const lineStart = i + 1
      const nextNewline = cmd.indexOf("\n", lineStart)
      const lineEnd = nextNewline === -1 ? cmd.length : nextNewline
      const nextLine = cmd.slice(lineStart, lineEnd)
      if (nextLine.trim().startsWith("#")) return true
    }
  }
  return false
}

// 12. Mid-word hash detection
export function hasMidWordHash(cmd: string): boolean {
  return /\S(?<!\$\{)#/.test(cmd)
}

// ─── Command-structure security checks (Phase 2) ───

// 13. Dangerous removal path detection
// Detects rm/rmdir targeting critical system paths.
const DANGEROUS_REMOVAL_PATHS = new Set([
  "/",
  "/bin",
  "/sbin",
  "/usr",
  "/usr/bin",
  "/usr/sbin",
  "/usr/local",
  "/usr/local/bin",
  "/etc",
  "/lib",
  "/lib64",
  "/boot",
  "/sys",
  "/proc",
  "/dev",
  "/var",
  "/tmp",
])

export function hasDangerousRemovalPath(cmd: string): string | null {
  const rmMatch = cmd.match(
    /^\s*(?:sudo\s+)?(?:nice\s+-n\s+-?\d+\s+)?(?:nohup\s+)?(?:timeout\s+\S+\s+)?(rm|rmdir)\s+(.+)$/,
  )
  if (!rmMatch) return null
  const args = rmMatch[2]!.split(/\s+/).filter((a) => a && !a.startsWith("-"))
  for (const arg of args) {
    const clean = arg.replace(/^['"]|['"]$/g, "").replace(/^~/, process.env.HOME || "")
    const resolved = clean.startsWith("/") ? clean : "/" + clean
    for (const dangerous of DANGEROUS_REMOVAL_PATHS) {
      if (resolved === dangerous || resolved.startsWith(dangerous + "/")) {
        return `${rmMatch[1]} targeting ${dangerous}`
      }
    }
  }
  return null
}

// 15. Multiple-cd guard
// Detects multiple directory changes in one compound command.
export function hasMultipleCdCommands(cmd: string): boolean {
  const segments = cmd.split(/\s*(?:&&|\|\||;)\s*/).filter(Boolean)
  let cdCount = 0
  for (const segment of segments) {
    if (/^\s*(?:cd|pushd|popd)\b/.test(segment.trim())) cdCount++
  }
  return cdCount > 1
}

// 16. Zsh dangerous commands detection
const ZSH_DANGEROUS_COMMANDS = new Set([
  "zmodload",
  "emulate",
  "sysopen",
  "sysread",
  "syswrite",
  "sysseek",
  "zpty",
  "ztcp",
  "zsocket",
  "mapfile",
  "zf_rm",
  "zf_mv",
  "zf_ln",
  "zf_chmod",
  "zf_chown",
  "zf_mkdir",
  "zf_rmdir",
  "zf_chgrp",
])

export function hasZshDangerousCommands(cmd: string): string | null {
  const baseCmd = cmd.trim().split(/\s+/)[0]
  if (baseCmd && ZSH_DANGEROUS_COMMANDS.has(baseCmd)) {
    return `Zsh dangerous command: ${baseCmd}`
  }
  if (/^fc\s+-\S*e/.test(cmd.trim())) return "fc -e (arbitrary command execution via editor)"
  return null
}

// 17. Dangerous env var detection (beyond binary-hijack vars)
const DANGEROUS_ENV_VARS = new Set([
  "PATH",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "PYTHONPATH",
  "NODE_PATH",
  "CLASSPATH",
  "RUBYLIB",
  "GOFLAGS",
  "RUSTFLAGS",
  "NODE_OPTIONS",
  "MALLOC_PERTURB_",
  "MALLOC_CHECK_",
  "LUA_CPATH",
  "LUA_PATH",
  "PERL5LIB",
  "PERL5OPT",
  "JAVA_TOOL_OPTIONS",
  "_JAVA_OPTIONS",
])

export function hasDangerousEnvAssignment(cmd: string): string | null {
  const envVarPattern = /^([A-Za-z_][A-Za-z0-9_]*)=\S*\s+/
  let current = cmd.trim()
  let match: RegExpMatchArray | null
  while ((match = current.match(envVarPattern))) {
    const varName = match[1]
    if (DANGEROUS_ENV_VARS.has(varName)) {
      return `Dangerous env var: ${varName}=`
    }
    current = current.slice(match[0].length).trim()
  }
  return null
}

// ─── Phase 4: Sed validation and path constraint integration ───

// 23. Sed dangerous operation validation (simplified port from openclaude)
// Blocks w/W (write), e/E (execute), block syntax, and negation operator.
export function hasDangerousSedOperation(cmd: string): string | null {
  if (!/\bsed\b/.test(cmd)) return null

  // Detect sed -f scriptfile (loads commands from file — bypasses inline expression checks)
  if (/\bsed\b[^|;&\n]*\s-[a-zA-Z]*f\s/.test(cmd)) return "sed with -f scriptfile (external script)"

  // Extract sed expression from quotes
  const sedMatch = cmd.match(/\bsed\s+.*?['"](.+?)['"]/)
  if (!sedMatch) {
    // If no quoted expression, check for dangerous flags: standalone w/W/e/E or digit+w/e
    if (/\bsed\s+.*\b[wWeE]\b/.test(cmd) || /\bsed\s+.*\d[wWeE]\b/.test(cmd))
      return "sed with potential write/execute flag"
    return null
  }

  const expression = sedMatch[1]!

  // Check for write commands: [address]w filename, /pattern/w filename
  if (/^[wW]\s*\S+/.test(expression.trim())) return "sed write command (w/W)"
  if (/^\d+\s*[wW]\s*\S+/.test(expression.trim())) return "sed write command (w/W)"
  if (/^\$\s*[wW]\s*\S+/.test(expression.trim())) return "sed write command (w/W)"
  if (/^\/[^/]*\/[IMim]*\s*[wW]\s*\S+/.test(expression.trim())) return "sed write command (w/W)"

  // Check for execute commands: [address]e [command], /pattern/e [command]
  if (/^e/.test(expression.trim())) return "sed execute command (e)"
  if (/^\d+\s*e/.test(expression.trim())) return "sed execute command (e)"
  if (/^\$\s*e/.test(expression.trim())) return "sed execute command (e)"
  if (/^\/[^/]*\/[IMim]*\s*e/.test(expression.trim())) return "sed execute command (e)"

  // Check for substitution with write/execute flags: s/old/new/w filename, s/old/new/e
  const substMatch = expression.match(/s([^\\\n]).*?\1.*?\1(.*?)$/)
  if (substMatch) {
    const flags = substMatch[2] || ""
    if (flags.includes("w") || flags.includes("W")) return "sed substitution with write flag (w/W)"
    if (flags.includes("e") || flags.includes("E")) return "sed substitution with execute flag (e/E)"
  }

  // Check for curly braces (blocks) - too complex to parse safely
  if (expression.includes("{") || expression.includes("}")) return "sed with block syntax (too complex)"

  // Check for negation operator
  if (/^!/.test(expression.trim()) || /[/\d$]!/.test(expression.trim())) return "sed with negation operator"

  return null
}

// 24. Unsafe output redirection detection
// Blocks output redirections to system paths (/etc/, /usr/, /bin/, etc.)
export function hasUnsafeOutputRedirection(cmd: string): string | null {
  const redirectMatch = cmd.match(/(?:>>?|&>)\s*(\S+)/g)
  if (!redirectMatch) return null

  const dangerousPrefixes = ["/etc/", "/usr/", "/bin/", "/sbin/", "/lib/", "/boot/", "/sys/", "/proc/"]
  for (const match of redirectMatch) {
    const pathPart = match.replace(/^(?:>>?|&>)\s*/, "")
    // Skip /dev/null and /dev/stderr etc
    if (pathPart.startsWith("/dev/")) continue
    // Check if path is absolute and targets system directories
    if (pathPart.startsWith("/")) {
      for (const prefix of dangerousPrefixes) {
        if (pathPart.startsWith(prefix)) return `Output redirection to system path: ${pathPart}`
      }
    }
  }
  return null
}

// 25. Enhanced dangerous removal path check (extends Phase 2 function)
// Adds --no-preserve-root and rm -rf ~ detection.
export function hasDangerousRemovalPathEnhanced(cmd: string): string | null {
  // Check for rm --no-preserve-root (always dangerous)
  if (/\brm\s+.*--no-preserve-root/.test(cmd)) return "rm with --no-preserve-root"

  // Check for rm -rf ~ or rm -rf ~/
  if (/\brm\s+.*-rf\s+~\/?/.test(cmd)) return "rm -rf targeting home directory"

  // Check for rm targeting critical system paths
  const rmMatch = cmd.match(
    /^\s*(?:sudo\s+)?(?:nice\s+-n\s+-?\d+\s+)?(?:nohup\s+)?(?:timeout\s+\S+\s+)?(rm|rmdir)\s+(.+)$/,
  )
  if (rmMatch) {
    const args = rmMatch[2]!.split(/\s+/).filter((a) => a && !a.startsWith("-"))
    for (const arg of args) {
      const clean = arg.replace(/^['"]|['"]$/g, "").replace(/^~/, process.env.HOME || "")
      const resolved = clean.startsWith("/") ? clean : "/" + clean
      for (const dangerous of DANGEROUS_REMOVAL_PATHS) {
        // For /tmp, only block exact match (not subdirectories like /tmp/opencode-test-xxx)
        if (dangerous === "/tmp") {
          if (resolved === dangerous) return `${rmMatch[1]} targeting ${dangerous}`
        } else if (resolved === dangerous || resolved.startsWith(dangerous + "/")) {
          return `${rmMatch[1]} targeting ${dangerous}`
        }
      }
    }
  }
  return null
}

// ─── Phase 5: Execution shaping and semantic metadata ───

// 26. Shell semantic classification sets (ported from openclaude)
const BASH_SEARCH_COMMANDS = new Set(["find", "rg", "fd", "fdfind", "ag", "ack", "locate", "which", "whereis"])

const BASH_READ_COMMANDS = new Set([
  "cat",
  "head",
  "tail",
  "nl",
  "sed",
  "less",
  "more",
  "wc",
  "stat",
  "file",
  "strings",
  "jq",
  "awk",
  "cut",
  "sort",
  "uniq",
  "tr",
])

const BASH_LIST_COMMANDS = new Set(["ls", "tree", "du"])

const BASH_SEMANTIC_NEUTRAL_COMMANDS = new Set(["echo", "printf", "true", "false", ":"])

const BASH_SILENT_COMMANDS = new Set([
  "mv",
  "cp",
  "rm",
  "mkdir",
  "rmdir",
  "chmod",
  "chown",
  "touch",
  "ln",
  "cd",
  "export",
  "unset",
  "wait",
])

function isReadDataScriptCommand(cmd: string): boolean {
  if (/^\s*python3?\b/.test(cmd)) {
    return /\b(?:open\(|Path\(|read_text|read_bytes|enumerate\(|for\s+line\s+in)\b/.test(cmd)
  }
  if (/^\s*(?:bun|node)\b/.test(cmd)) {
    return /\b(?:Bun\.file\(|readFileSync|createReadStream)\b/.test(cmd)
  }
  return false
}

function shouldUseReadDataBudget(command: string): boolean {
  const stripped = stripSafeWrappers(stripLeadingComments(command))
  if (!stripped) return false
  if (isMutatingCommand(stripQuotedShellText(stripped))) return false
  if (hasGitignoreBypassIssue(stripped)) return false

  const logical = splitLogicalSegments(stripped)
  if (logical.length === 0) return false

  for (const segment of logical) {
    for (const pipeSegment of splitPipeSegments(segment)) {
      const part = stripSafeWrappers(pipeSegment.trim())
      if (!part) continue
      if (isReadDataScriptCommand(part)) continue
      const base = part.split(/\s+/)[0]
      if (!base || BASH_SEMANTIC_NEUTRAL_COMMANDS.has(base)) continue
      const isReadClass = BASH_READ_COMMANDS.has(base) || BASH_SEARCH_COMMANDS.has(base) || BASH_LIST_COMMANDS.has(base)
      if (!isReadClass) return false
    }
  }
  return true
}

function stripQuotedShellText(command: string) {
  return command
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""')
    .replace(/`[^`]*`/g, "``")
}

function shouldCompactWriteOutput(command: string, result: { metadata: any; output: string }) {
  if (result.metadata.exit !== 0) return false
  if (result.output.trim() !== "") return false
  const shellSyntax = stripQuotedShellText(stripSafeWrappers(stripLeadingComments(command)))
  return isMutatingCommand(shellSyntax) !== null
}

function normalizeRequestedOutputChars(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`max_output_chars must be a positive finite number when provided.`)
  }
  return Math.floor(value)
}

async function applyBashOutputBudget(
  command: string,
  result: { title: string; metadata: any; output: string },
  requestedMaxOutputChars?: number,
  requestedMaxOutputLines?: number,
) {
  if (shouldCompactWriteOutput(command, result)) {
    const output = "Write command completed successfully; output suppressed."
    return {
      ...result,
      output,
      metadata: {
        ...result.metadata,
        output,
        truncated: false,
        compact_write: true,
        output_budget_chars: Truncate.MAX_CHARS,
        output_budget_mode: "write_compact",
      },
    }
  }

  let output = result.output
  let truncatedByLines = false
  if (requestedMaxOutputLines !== undefined && requestedMaxOutputLines > 0) {
    const lines = output.split(/\r?\n/)
    if (lines.length > requestedMaxOutputLines) {
      output = lines.slice(0, requestedMaxOutputLines).join("\n") + `\n... [output truncated by lines, total lines: ${lines.length}]`
      truncatedByLines = true
    }
  }

  const readData = shouldUseReadDataBudget(command)
  const requestedMaxChars = normalizeRequestedOutputChars(requestedMaxOutputChars)
  const defaultMaxChars = readData ? READ_DATA_MAX_CHARS : Truncate.MAX_CHARS
  const maxChars = requestedMaxChars ?? defaultMaxChars
  const truncated = await Truncate.output(output, { maxChars })
  return {
    ...result,
    output: truncated.content,
    metadata: {
      ...result.metadata,
      output: preview(truncated.content),
      truncated: truncated.truncated || truncatedByLines,
      output_budget_chars: maxChars,
      output_budget_mode: requestedMaxChars !== undefined ? "custom" : readData ? "read_data" : "default",
      ...(requestedMaxChars !== undefined ? { output_budget_requested: true } : {}),
      ...(truncated.truncated ? { outputPath: truncated.outputPath } : {}),
    },
  }
}

// 27. Semantic classification of a command for metadata and UI display
export function classifyCommandSemantics(cmd: string): {
  isSearch: boolean
  isRead: boolean
  isList: boolean
  isMutate: boolean
  isSilent: boolean
} {
  const baseCmd = cmd.trim().split(/\s+/)[0]
  if (!baseCmd) return { isSearch: false, isRead: false, isList: false, isMutate: false, isSilent: false }

  if (BASH_SEMANTIC_NEUTRAL_COMMANDS.has(baseCmd)) {
    return { isSearch: false, isRead: false, isList: false, isMutate: false, isSilent: false }
  }

  const isSearch = BASH_SEARCH_COMMANDS.has(baseCmd)
  const isRead = BASH_READ_COMMANDS.has(baseCmd)
  const isList = BASH_LIST_COMMANDS.has(baseCmd)
  const isMutate = isMutatingCommand(cmd) !== null && !isCommandSafeViaFlagParsing(cmd)
  const isSilent = BASH_SILENT_COMMANDS.has(baseCmd)

  return { isSearch, isRead, isList, isMutate, isSilent }
}

// 28. Command type detection for metadata categorization
export function getCommandType(cmd: string): string {
  const baseCmd = cmd.trim().split(/\s+/)[0]
  if (!baseCmd) return "other"

  if (["npm", "yarn", "pnpm", "bun"].includes(baseCmd)) return "package-manager"
  if (baseCmd === "git") return "git"
  if (baseCmd === "docker") return "docker"
  if (baseCmd === "make") return "build"
  if (baseCmd === "node" || baseCmd === "python" || baseCmd === "python3") return "runtime"
  if (BASH_SEARCH_COMMANDS.has(baseCmd)) return "search"
  if (BASH_READ_COMMANDS.has(baseCmd)) return "read"
  if (BASH_LIST_COMMANDS.has(baseCmd)) return "list"
  if (isMutatingCommand(cmd) && !isCommandSafeViaFlagParsing(cmd)) return "mutate"
  return "other"
}

// The public tool name remains `bash` for compatibility, even when the accepted
// runtime shell is PowerShell or another supported shell.
export const BashTool = Tool.define("bash", async () => {
  const shell = Shell.acceptable()
  const name = Shell.name(shell)
  await parser()
  const chain =
    name === "powershell"
      ? "If the commands depend on each other and must run sequentially, avoid '&&' in this shell because Windows PowerShell 5.1 does not support it. Use PowerShell conditionals such as `cmd1; if ($?) { cmd2 }` when later commands must depend on earlier success."
      : "If the commands depend on each other and must run sequentially, use a single Bash call with '&&' to chain them together (e.g., `git add . && git commit -m \"message\" && git push`). For instance, if one operation must complete before another starts (like mkdir before cp, Write before Bash for git operations, or git add before git commit), run these operations sequentially instead."
  log.info("bash tool using shell", { shell })

  // Probe common tooling binaries and scan PATH-extension dirs so the model
  // knows at turn 1 what is installed and which custom scripts exist.
  const scriptDirs = await secondaryToolDirs(Instance.directory)
  let notesRootForScan: string | undefined = process.env.OPENCODE_NOTES_ROOT
  if (!notesRootForScan) {
    try {
      const { Config } = await import("@/config/config")
      notesRootForScan = (await Config.get()).notes?.root
    } catch {
      /* ignore */
    }
  }
  const [probed, customScripts] = await Promise.all([probeBinaries(), scanScriptDirs(scriptDirs, notesRootForScan)])
  const availability = `Available: ${formatAvailability(probed)}`
  const customBlock = formatCustomScriptsBlock(scriptDirs, customScripts)

  return {
    description: (ToolCard.get("bash")?.description ?? ToolCard.DEFAULT_TOOL_CARD_BINDINGS["bash"])
      .replaceAll("${directory}", Instance.directory)
      .replaceAll("${os}", process.platform)
      .replaceAll("${shell}", name)
      .replaceAll("${chaining}", chain)
      .replaceAll("${maxBytes}", String(Truncate.MAX_CHARS))
      .replaceAll("${customScripts}", customBlock ? `\n\n${availability}${customBlock}` : `\n\n${availability}`),
    concurrencySafe: (args: { command?: string }) => classifyBashConcurrency(args.command),
    parameters: z.object({
      mode: z
        .enum(["run", "background", "list", "status", "kill", "cleanup", "remove"])
        .describe("run|background|list|status|kill|cleanup|remove. Default run.")
        .optional(),
      command: z.string().describe("Command for run/background.").optional(),
      timeout: z
        .number()
        .describe(
          "Timeout ms (default 120000). Leave undefined unless you specifically need to restrict execution time.",
        )
        .optional(),
      auto_background: z.boolean().describe("Auto-background on timeout (default true). Leave undefined.").optional(),
      workdir: z.string().describe(`Working directory. Defaults to ${Instance.directory}.`).optional(),
      run_in_background: z.boolean().describe("Deprecated alias for mode=background.").optional(),
      id: z.string().describe("Background task id.").optional(),
      max_age_ms: z.number().describe("cleanup max age ms.").optional(),
      max_output_chars: z
        .number()
        .int()
        .positive()
        .describe(
          `Optional inline output character budget for run results. Default ${Truncate.MAX_CHARS} chars, or ${READ_DATA_MAX_CHARS} for simple read/search/list commands. Increase only when necessary; large values can bloat context.`,
        )
        .optional(),
      max_output_lines: z
        .number()
        .int()
        .positive()
        .describe("Optional inline output line budget for run results. Truncates output to this number of lines if provided.")
        .optional(),
      description: z.string().describe("5-10 word purpose; do not echo command.").optional(),
    }),
    async execute(params, ctx) {
      // Resolve effective mode: explicit mode > run_in_background legacy alias > default "run"
      const mode = params.mode ?? (params.run_in_background ? "background" : "run")

      // ── Job-management modes (no shell execution) ──
      if (mode === "list") {
        const tasks = listBackgroundTaskDetails()
        if (tasks.length === 0) {
          return { title: "bash list", output: "No background tasks.", metadata: { count: 0, tasks: [] } }
        }
        const lines = tasks.map((t) => {
          const runtimeSec = Math.max(0, Math.round(((t.endTime ?? Date.now()) - t.startTime) / 1000))
          return `- ${t.id}: ${t.status} pid=${t.pid ?? "?"} runtime=${runtimeSec}s cmd="${t.command}"`
        })
        return {
          title: `bash list (${tasks.length})`,
          output: lines.join("\n"),
          metadata: { count: tasks.length, tasks },
        }
      }

      if (mode === "cleanup") {
        const maxAgeMs = params.max_age_ms ?? 6 * 60 * 60 * 1000
        const result = cleanupBackgroundTasks(maxAgeMs)
        return {
          title: "bash cleanup",
          output: `Cleanup complete. Removed ${result.removed} task(s), kept ${result.kept}.`,
          metadata: { ...result, maxAgeMs },
        }
      }

      if (mode === "status" || mode === "kill" || mode === "remove") {
        if (!params.id) throw new Error(`mode=${mode} requires id`)
        if (mode === "status") {
          const task = getBackgroundTask(params.id)
          if (!task) {
            return {
              title: `bash status ${params.id}`,
              output: `Task ${params.id} not found.`,
              metadata: { found: false, id: params.id },
            }
          }
          const runtimeSec = Math.max(0, Math.round(((task.endTime ?? Date.now()) - task.startTime) / 1000))
          return {
            title: `bash status ${params.id}`,
            output:
              `Task ${task.id}\n` +
              `status: ${task.status}\n` +
              `pid: ${task.pid ?? "unknown"}\n` +
              `cwd: ${task.cwd}\n` +
              `runtime: ${runtimeSec}s\n` +
              `outputPath: ${task.outputPath ?? "unknown"}`,
            metadata: { found: true, task },
          }
        }
        if (mode === "kill") {
          const result = await killBackgroundTask(params.id)
          if (!result.ok) {
            return {
              title: `bash kill ${params.id}`,
              output: `Failed to kill task ${params.id}: ${result.error}`,
              metadata: { ok: false, id: params.id, error: result.error },
            }
          }
          return {
            title: `bash kill ${params.id}`,
            output: `Kill signal sent for task ${params.id}.`,
            metadata: { ok: true, id: params.id },
          }
        }
        // mode === "remove"
        const removed = removeBackgroundTask(params.id)
        return {
          title: `bash remove ${params.id}`,
          output: removed ? `Removed task record ${params.id}.` : `Task ${params.id} not found.`,
          metadata: { removed, id: params.id },
        }
      }

      // ── Shell execution modes: run | background ──
      if (!params.command) throw new Error(`mode=${mode} requires command`)
      if ((mode === "run" || mode === "background") && !params.description?.trim()) {
        throw new Error(`description is required for bash run/background (5-10 word purpose).`)
      }
      let command = params.command
      const heredocRepair = repairMalformedHeredocCommand(command)
      if (heredocRepair) {
        command = heredocRepair.command
        ctx.metadata({
          metadata: {
            command_rewritten: true,
            command_rewrite_kind: "heredoc_terminator_suffix",
            command_rewrite_message: heredocRepair.message,
          },
        })
      }
      const malformedIssue = getMalformedHeredocIssue(command)
      if (malformedIssue) {
        throw new Error(`Refused malformed command: ${malformedIssue}.`)
      }
      const applyPatchIssue = hasApplyPatchViaBashIssue(command)
      if (applyPatchIssue) {
        throw new Error(`Refused command: ${applyPatchIssue}.`)
      }
      const searchToolIssue = hasDisallowedSearchToolIssue(command)
      if (searchToolIssue) {
        throw new Error(`Refused command: ${searchToolIssue}.`)
      }
      const gitignoreIssue = hasGitignoreBypassIssue(command)
      if (gitignoreIssue) {
        throw new Error(`Refused command: ${gitignoreIssue}. Use rg/fd/fdfind or git ls-files-based discovery.`)
      }
      if (mode === "run") {
        const noisyIssue = getNoisyCommandIssue(command)
        if (noisyIssue) {
          ctx.metadata({
            metadata: {
              noisy_command_advice: noisyCommandAdvice(command, noisyIssue),
              output_handling: "output is truncated to chat and full text is persisted when it exceeds the tool budget",
            },
          })
        }
      }
      const cwd = params.workdir ? await resolvePath(params.workdir, Instance.directory, shell) : Instance.directory
      if (params.timeout !== undefined && params.timeout < 0) {
        throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
      }
      const timeout = params.timeout ?? DEFAULT_TIMEOUT
      const ps = PS.has(name)
      const root = await parse(command, ps)
      const scan = await collect(root, cwd, ps, shell)
      if (!Instance.containsPath(cwd)) scan.dirs.add(cwd)
      await ask(ctx, scan, command)

      // Background execution: start command without awaiting, return immediately
      if (mode === "background") {
        const taskId = `bg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        // vault-as-sole-filesystem (I0.2): bg-task output under vault tmp.
        const outputPath = path.join(vaultPath.tmpRoot(), `opencode-bg-${taskId}.txt`)
        const taskOutput = new TaskOutput({
          previewTailLines: 5,
          ringCapacity: 1000,
          accumulatorMaxBytes: 8 * 1024 * 1024,
          pollerIntervalMs: 1000,
          diskFactory: (p) =>
            createDiskOutput({
              outputPath: p,
              createParents: true,
              rotateAtBytes: 64 * 1024 * 1024,
            }),
        })
        await taskOutput.attachDisk(outputPath)

        const envInput = await shellEnv(ctx, cwd)
        const env: Record<string, string> = {}
        for (const [k, v] of Object.entries(envInput)) {
          if (typeof v === "string") env[k] = v
        }

        const shellCommand = new ShellCommandImpl({
          command,
          args: [],
          cwd,
          env,
          shell,
          timeoutMs: timeout,
          forceKillAfterMs: 3000,
          output: taskOutput,
          mode: "disk",
          watchdogMaxBytes: 64 * 1024 * 1024,
          abortSignal: ctx.abort,
        })

        await Effect.runPromise(shellCommand.start())
        const handle = await Effect.runPromise(shellCommand.background())
        backgroundRegistry.register({
          id: taskId,
          pid: handle.pid,
          command,
          cwd,
          startedAt: handle.startedAt,
          outputPath,
          shellCommand,
          output: taskOutput,
        })

        shellCommand.onExit((info) => {
          backgroundRegistry.markExited(taskId, info)
          void taskOutput.finalize({ persist: true }).pipe(Effect.runPromise)
        })

        ctx.metadata({
          metadata: {
            run_in_background: true,
            backgroundTaskId: taskId,
            description: params.description ?? "",
          },
        })
        return {
          title: `Background: ${command.slice(0, 60)}`,
          output: `Started background command (task ID: ${taskId}). Use bash with mode=status to check status.`,
          metadata: {
            run_in_background: true,
            backgroundTaskId: taskId,
          },
        }
      }

      const env = await shellEnv(ctx, cwd)
      const primary = await run(
        {
          shell,
          name,
          command,
          cwd,
          env,
          timeout,
          auto_background: params.auto_background,
          description: params.description ?? "",
        },
        ctx,
      )
      const boundedPrimary = await applyBashOutputBudget(command, primary, params.max_output_chars, params.max_output_lines)

      if (
        shouldRetryWithPython3ForPathlib({
          command,
          output: boundedPrimary.output,
          exit: boundedPrimary.metadata.exit,
        })
      ) {
        const fallbackCommand = rewritePythonForPathlibFallback(command)
        if (fallbackCommand && fallbackCommand !== command) {
          ctx.metadata({
            metadata: {
              python_fallback: "python3",
              python_fallback_reason: "pathlib import failure with python",
              python_original_command: command,
              python_fallback_command: fallbackCommand,
            },
          })
          const fallback = await run(
            {
              shell,
              name,
              command: fallbackCommand,
              cwd,
              env,
              timeout,
              auto_background: params.auto_background,
              description: params.description ?? "",
            },
            ctx,
          )
          return applyBashOutputBudget(fallbackCommand, fallback, params.max_output_chars, params.max_output_lines)
        }
      }

      return boundedPrimary
    },
  }
})
