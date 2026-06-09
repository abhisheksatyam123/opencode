import { promises as fs, constants as fsConstants } from "node:fs"
import path from "node:path"
import os from "node:os"

// ── Binary probe ─────────────────────────────────────────────────────────────

const PROBED_BINS = ["rg", "fd", "jq", "bat", "fzf", "tree", "git", "curl", "patch"] as const

async function findOnPath(bin: string): Promise<boolean> {
  const rawPath = process.env.PATH ?? ""
  if (!rawPath) return false
  const dirs = rawPath.split(path.delimiter).filter(Boolean)
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""]
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, bin + ext)
      try {
        await fs.access(candidate, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK)
        return true
      } catch {
        /* continue */
      }
    }
  }
  return false
}

export async function probeBinaries(): Promise<Record<string, boolean>> {
  const entries = await Promise.all(
    PROBED_BINS.map(async (b) => {
      let found = await findOnPath(b)
      if (!found && b === "fd") found = await findOnPath("fdfind")
      return [b, found] as const
    }),
  )
  return Object.fromEntries(entries)
}

export function formatAvailability(probed: Record<string, boolean>): string {
  return PROBED_BINS.map((b) => `${b}${probed[b] ? "✓" : "✗"}`).join(" ")
}

// ── Script directories ───────────────────────────────────────────────────────

function expandHome(p: string): string {
  if (p === "~") return os.homedir()
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2))
  return p
}

export async function resolveScriptDirs(options: {
  configured?: string[]
  cwd: string
  notesRoot?: string
}): Promise<string[]> {
  const seen = new Set<string>()
  const out: string[] = []

  const envRaw = process.env.OPENCODE_SCRIPT_DIRS ?? ""
  const envDirs = envRaw.split(path.delimiter).filter(Boolean)

  const defaults = [options.notesRoot ? path.join(options.notesRoot, "tools") : null].filter((d): d is string =>
    Boolean(d),
  )

  const candidates = [...(options.configured ?? []), ...envDirs, ...defaults]

  for (const raw of candidates) {
    const dir = path.resolve(expandHome(raw))
    if (seen.has(dir)) continue
    try {
      const stat = await fs.stat(dir)
      if (!stat.isDirectory()) continue
    } catch {
      continue
    }
    seen.add(dir)
    out.push(dir)
  }

  return out
}

// ── Script scanning ──────────────────────────────────────────────────────────

export interface CustomScript {
  name: string
  path: string
  dir: string
  summary?: string
  runner?: "direct" | "bun"
}

async function isExecutable(fp: string): Promise<boolean> {
  if (process.platform === "win32") {
    const ext = path.extname(fp).toLowerCase()
    return ext === ".exe" || ext === ".cmd" || ext === ".bat" || ext === ".ps1" || ext === ""
  }
  try {
    await fs.access(fp, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

async function readSummary(cardPath: string): Promise<string | undefined> {
  try {
    const content = await fs.readFile(cardPath, "utf8")
    const body = content.replace(/^---[\s\S]*?---\n/, "")
    const line = body.split("\n").find((l) => l.trim() && !l.startsWith("#"))
    return line?.trim()
  } catch {
    return undefined
  }
}

async function summaryFor(toolRoot: string, notesRoot: string | undefined, name: string): Promise<string | undefined> {
  return (
    (await readSummary(path.join(toolRoot, "TOOL.md"))) ??
    (notesRoot ? await readSummary(path.join(notesRoot, "atomic", "tools", `${name}.md`)) : undefined)
  )
}

async function scanPackageBins(dir: string, notesRoot: string | undefined, byName: Map<string, CustomScript>) {
  const packagePath = path.join(dir, "package.json")
  let raw: string
  try {
    raw = await fs.readFile(packagePath, "utf8")
  } catch {
    return
  }
  let pkg: any
  try {
    pkg = JSON.parse(raw)
  } catch {
    return
  }
  const bin = typeof pkg.bin === "string" ? { [pkg.name ?? path.basename(dir)]: pkg.bin } : pkg.bin
  if (!bin || typeof bin !== "object") return
  for (const [name, target] of Object.entries(bin)) {
    if (byName.has(name) || typeof target !== "string") continue
    const full = path.resolve(dir, target)
    try {
      const stat = await fs.stat(full)
      if (!stat.isFile()) continue
    } catch {
      continue
    }
    const toolRoot = path.dirname(path.dirname(full))
    const summary = await summaryFor(toolRoot, notesRoot, name)
    byName.set(name, { name, path: full, dir, summary, runner: "bun" })
  }
}

export async function scanScriptDirs(dirs: string[], notesRoot?: string): Promise<CustomScript[]> {
  const byName = new Map<string, CustomScript>()
  for (const dir of dirs) {
    await scanPackageBins(dir, notesRoot, byName)
    let entries: string[] = []
    try {
      entries = await fs.readdir(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(dir, entry)
      let stat
      try {
        stat = await fs.stat(full)
      } catch {
        continue
      }
      if (!stat.isFile()) continue
      if (!(await isExecutable(full))) continue
      const name = path.basename(entry, path.extname(entry))
      if (byName.has(name)) continue
      const summary = await summaryFor(path.dirname(full), notesRoot, name)
      byName.set(name, { name, path: full, dir, summary, runner: "direct" })
    }
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name))
}

// ── Description block formatting ─────────────────────────────────────────────

export function formatCustomScriptsBlock(dirs: string[], scripts: CustomScript[]): string {
  if (dirs.length === 0 && scripts.length === 0) return ""
  const parts: string[] = []
  if (dirs.length > 0) parts.push(`PATH has ${dirs.length} custom script dir${dirs.length === 1 ? "" : "s"}.`)
  if (scripts.length > 0) {
    const shown = scripts.slice(0, 20).map((s) => `${s.name}${s.summary ? ` — ${s.summary}` : ""}`)
    const hidden = scripts.length - shown.length
    parts.push(`Custom scripts: ${shown.join("; ")}${hidden > 0 ? `; +${hidden} more` : ""}`)
  }
  return parts.length ? `\n\n${parts.join("\n")}` : ""
}

// ── Concurrency classifier ───────────────────────────────────────────────────

const READONLY_BINS = new Set([
  "rg",
  "fd",
  "fdfind",
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "du",
  "find",
  "locate",
  "mdfind",
  "jq",
  "tree",
  "bat",
  "which",
  "file",
  "stat",
  "basename",
  "dirname",
  "readlink",
  "realpath",
  "env",
  "printenv",
  "date",
  "echo",
  "pwd",
])

const SAFE_GIT_SUBCOMMANDS =
  /^git\s+(status|diff|log|show|blame|rev-parse|ls-files|ls-tree|branch\s+-l|branch\s*$|describe|config\s+--get|config\s+-l)\b/

export function classifyBashConcurrency(command: string | undefined): boolean {
  if (!command) return false
  const trimmed = command.trim()
  if (!trimmed) return false
  // Any redirect-to-file or mutating pipe target → unsafe.
  if (/(^|[^<&2])>{1,2}[^&]/.test(trimmed)) return false
  if (/\|\s*(tee|xargs|sh|bash|zsh|fish)\b/.test(trimmed)) return false
  // Multiple statements → classify the whole as unsafe (simpler than parsing).
  if (/[;&]{1,2}/.test(trimmed)) return false
  // Sub-shells / command-substitution may hide mutations.
  if (/`|\$\(/.test(trimmed)) return false

  const first = trimmed.split(/\s+/)[0]
  if (READONLY_BINS.has(first)) return true
  if (SAFE_GIT_SUBCOMMANDS.test(trimmed)) return true
  return false
}
