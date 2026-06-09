import path from "path"
import fs from "fs"
import { fileURLToPath } from "url"

export namespace AgentPromptSource {
  export const DIR_REL = path.join("src", "agent", "prompts")

  const moduleDir = path.dirname(fileURLToPath(import.meta.url))

  function isDir(dir: string): boolean {
    try {
      return fs.statSync(dir).isDirectory()
    } catch {
      return false
    }
  }

  /**
   * Bun --compile may flatten module URLs to /$bunfs/root/src, which breaks
   * plain moduleDir/prompts resolution. Probe known layouts and return the
   * first existing prompt directory.
   */
  function resolveRoot(): string {
    const candidates = [
      path.join(moduleDir, "prompts"), // dev: src/agent/prompts
      path.join(moduleDir, "agent", "prompts"), // compiled: /$bunfs/root/src/agent/prompts
      path.join(process.cwd(), DIR_REL), // fallback when running from repo root
    ]
    for (const candidate of candidates) {
      if (isDir(candidate)) return candidate
    }
    return candidates[0]
  }

  export function root() {
    return resolveRoot()
  }

  export function shared(name: string) {
    return path.join(root(), "_shared", `${name}.md`)
  }
}
