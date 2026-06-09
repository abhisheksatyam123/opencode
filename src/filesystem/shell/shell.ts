import { Flag } from "@/foundation/flag/flag"
import { lazy } from "@/foundation/util/lazy"
import { Filesystem } from "@/foundation/util/filesystem"
import { which } from "@/foundation/util/which"
import { Binary } from "@/foundation/util/binary"
import path from "path"
import fs from "fs"
import { spawn, type ChildProcess } from "child_process"
import { setTimeout as sleep } from "node:timers/promises"
export * from "./contract/port"

const SIGKILL_TIMEOUT_MS = 200

export namespace Shell {
  const BLACKLIST = new Set(["fish", "nu"])
  const LOGIN = new Set(["bash", "dash", "fish", "ksh", "sh", "zsh"])
  const POSIX = new Set(["bash", "dash", "ksh", "sh", "zsh"])
  const KNOWN = ["bash", "zsh", "sh", "dash", "ksh", "fish", "nu", "pwsh", "powershell", "cmd.exe"]

  export type Info = {
    path: string
    name: string
    acceptable: boolean
  }

  export async function killTree(proc: ChildProcess, opts?: { exited?: () => boolean }): Promise<void> {
    const pid = proc.pid
    if (!pid || opts?.exited?.()) return

    if (process.platform === "win32") {
      await new Promise<void>((resolve) => {
        const killer = spawn("taskkill", ["/pid", String(pid), "/f", "/t"], {
          stdio: "ignore",
          windowsHide: true,
        })
        killer.once("exit", () => resolve())
        killer.once("error", () => resolve())
      })
      return
    }

    try {
      process.kill(-pid, "SIGTERM")
      await sleep(SIGKILL_TIMEOUT_MS)
      if (!opts?.exited?.()) {
        process.kill(-pid, "SIGKILL")
      }
    } catch (_e) {
      proc.kill("SIGTERM")
      await sleep(SIGKILL_TIMEOUT_MS)
      if (!opts?.exited?.()) {
        proc.kill("SIGKILL")
      }
    }
  }

  function full(file: string) {
    if (process.platform !== "win32") return file
    const shell = Filesystem.windowsPath(file)
    if (path.win32.dirname(shell) !== ".") {
      if (shell.startsWith("/") && name(shell) === "bash") return gitbash() || shell
      return shell
    }
    // gap-21-followup-1: cached PATH lookup via Binary.path
    return Binary.path(shell) || shell
  }

  function pick() {
    // gap-21-followup-1: cached PATH lookups via Binary.path
    const pwsh = Binary.path("pwsh")
    if (pwsh) return pwsh
    const powershell = Binary.path("powershell")
    if (powershell) return powershell
  }

  function select(file: string | undefined, opts?: { acceptable?: boolean }) {
    // Linux bash-primary: BashTool must run under bash regardless of user's login shell.
    // Only applies when acceptable=true (BashTool path). preferred() is unaffected.
    if (opts?.acceptable && process.platform === "linux") {
      const bash = which("bash")
      if (bash) return bash
    }
    if (file && (!opts?.acceptable || !BLACKLIST.has(name(file)))) return full(file)
    if (process.platform === "win32") {
      const shell = pick()
      if (shell) return shell
    }
    return fallback()
  }

  export function gitbash() {
    if (process.platform !== "win32") return
    if (Flag.OPENCODE_GIT_BASH_PATH) return Flag.OPENCODE_GIT_BASH_PATH
    const git = which("git")
    if (!git) return
    const file = path.join(git, "..", "..", "bin", "bash.exe")
    if (Filesystem.stat(file)?.size) return file
  }

  function fallback() {
    if (process.platform === "win32") {
      const file = gitbash()
      if (file) return file
      return process.env.COMSPEC || "cmd.exe"
    }
    if (process.platform === "darwin") return "/bin/zsh"
    const bash = which("bash")
    if (bash) return bash
    return "/bin/sh"
  }

  export function name(file: string) {
    if (process.platform === "win32") return path.win32.parse(Filesystem.windowsPath(file)).name.toLowerCase()
    return path.basename(file).toLowerCase()
  }

  export function login(file: string) {
    return LOGIN.has(name(file))
  }

  export function posix(file: string) {
    return POSIX.has(name(file))
  }

  function resolve(file: string) {
    const trimmed = file.trim()
    if (!trimmed) return
    if (process.platform === "win32") {
      const normalized = Filesystem.windowsPath(trimmed)
      if (path.win32.dirname(normalized) === ".") return Binary.path(normalized) ?? undefined
      return full(normalized)
    }
    if (path.dirname(trimmed) === ".") return which(trimmed) ?? undefined
    return trimmed
  }

  function etcShells() {
    if (process.platform === "win32") return []
    try {
      return fs
        .readFileSync("/etc/shells", "utf8")
        .split(/\r?\n/g)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
    } catch {
      return []
    }
  }

  export function list(): Info[] {
    const selected = new Set([name(acceptable())])
    const items = [process.env.SHELL, preferred(), acceptable(), ...etcShells(), ...KNOWN]
    const seen = new Set<string>()
    const result: Info[] = []

    for (const item of items) {
      if (!item) continue
      const resolved = resolve(item)
      if (!resolved) continue
      const shellName = name(resolved)
      const key = process.platform === "win32" ? resolved.toLowerCase() : resolved
      if (seen.has(key)) continue
      seen.add(key)
      result.push({
        path: resolved,
        name: shellName,
        acceptable: POSIX.has(shellName) || selected.has(shellName),
      })
    }

    return result
  }

  export const preferred = lazy(() => select(process.env.SHELL))

  export const acceptable = lazy(() => select(process.env.SHELL, { acceptable: true }))
}
