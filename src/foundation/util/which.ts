import path from "path"
import { vaultPath } from "@/foundation/notes-root"

export function which(cmd: string, env?: NodeJS.ProcessEnv) {
  const base = env?.PATH ?? env?.Path ?? process.env.PATH ?? process.env.Path ?? ""
  const full = base ? base + path.delimiter + vaultPath.cache("bin") : vaultPath.cache("bin")
  try {
    return Bun.which(cmd, { PATH: full }) ?? null
  } catch {
    return null
  }
}
