import { Process } from "@/foundation/util/process"
import { notesRoot as defaultNotesRoot } from "@/notes/root"
import { resolveScriptDirs, scanScriptDirs, type CustomScript } from "@/tool/bash/extras"

export interface SecondaryToolCatalog {
  notesRoot: string
  dirs: string[]
  tools: CustomScript[]
}

async function loadRuntimeConfig() {
  let configured: string[] | undefined
  let notesRoot: string | undefined = process.env.OPENCODE_NOTES_ROOT
  try {
    const { Config } = await import("@/config/config")
    const cfg = (await Config.get()) as any
    configured = cfg?.tools?.script_dirs
    if (!notesRoot) notesRoot = cfg?.notes?.root
  } catch {
    /* config unavailable during early boot/tests; fall back to env/default */
  }
  return { configured, notesRoot: notesRoot || defaultNotesRoot() }
}

export async function secondaryToolCatalog(cwd: string): Promise<SecondaryToolCatalog> {
  const runtime = await loadRuntimeConfig()
  const dirs = await resolveScriptDirs({
    configured: runtime.configured,
    cwd,
    notesRoot: runtime.notesRoot,
  })
  const tools = await scanScriptDirs(dirs, runtime.notesRoot)
  return {
    notesRoot: runtime.notesRoot,
    dirs,
    tools,
  }
}

export async function secondaryToolDirs(cwd: string): Promise<string[]> {
  const runtime = await loadRuntimeConfig()
  return resolveScriptDirs({
    configured: runtime.configured,
    cwd,
    notesRoot: runtime.notesRoot,
  })
}

export interface RunSecondaryToolInput {
  name: string
  args?: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  stdio?: "inherit" | "capture"
}

export interface RunSecondaryToolOutput {
  code: number
  stdout: string
  stderr: string
  command: string[]
  tool: CustomScript
}

function availableToolsList(tools: CustomScript[]) {
  if (tools.length === 0) return "(none)"
  return tools
    .map((item) => item.name)
    .sort()
    .join(", ")
}

export async function runSecondaryTool(input: RunSecondaryToolInput): Promise<RunSecondaryToolOutput> {
  const catalog = await secondaryToolCatalog(input.cwd)
  const tool = catalog.tools.find((item) => item.name === input.name)
  if (!tool) {
    throw new Error(
      `secondary tool "${input.name}" not found under ${catalog.dirs.join(", ") || "(no tool dirs)"}; available: ${availableToolsList(catalog.tools)}`,
    )
  }

  const command =
    tool.runner === "bun" ? ["bun", "run", tool.path, ...(input.args ?? [])] : [tool.path, ...(input.args ?? [])]

  if (input.stdio === "inherit") {
    const child = Process.spawn(command, {
      cwd: input.cwd,
      env: input.env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    })
    const code = await child.exited
    return {
      code,
      stdout: "",
      stderr: "",
      command,
      tool,
    }
  }

  const result = await Process.run(command, {
    cwd: input.cwd,
    env: input.env,
    nothrow: true,
  })

  return {
    code: result.code,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    command,
    tool,
  }
}
