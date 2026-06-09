import { NamedError } from "@opencode-ai/util/error"
import matter from "gray-matter"
import z from "zod"
// gap-error-followup-1: errorMessage centralizes the
// `err instanceof Error ? err.message : String(err)` boilerplate.
import { errorMessage } from "@/foundation/util/error"
import { Filesystem } from "@/foundation/util/filesystem"

export namespace ConfigMarkdown {
  export const FILE_REGEX = /(?<![\w`])@(\.?[^\s`,.]*(?:\.[^\s`,.]+)*)/g
  export const SHELL_REGEX = /!`([^`]+)`/g

  export function files(template: string) {
    return Array.from(template.matchAll(FILE_REGEX))
  }

  export function shell(template: string) {
    return Array.from(template.matchAll(SHELL_REGEX))
  }

  // other coding agents like claude code allow invalid yaml in their
  // frontmatter, we need to fallback to a more permissive parser for those cases
  export function fallbackSanitization(content: string): string {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (!match) return content

    const frontmatter = match[1]
    const lines = frontmatter.split(/\r?\n/)
    const result: string[] = []

    for (const line of lines) {
      // skip comments and empty lines
      if (line.trim().startsWith("#") || line.trim() === "") {
        result.push(line)
        continue
      }

      // skip lines that are continuations (indented)
      if (line.match(/^\s+/)) {
        result.push(line)
        continue
      }

      // match key: value pattern
      const kvMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/)
      if (!kvMatch) {
        result.push(line)
        continue
      }

      const key = kvMatch[1]
      const value = kvMatch[2].trim()

      // skip if value is empty, already quoted, or uses block scalar
      if (value === "" || value === ">" || value === "|" || value.startsWith('"') || value.startsWith("'")) {
        result.push(line)
        continue
      }

      // if value contains a colon, convert to block scalar
      if (value.includes(":")) {
        result.push(`${key}: |-`)
        result.push(`  ${value}`)
        continue
      }

      result.push(line)
    }

    const processed = result.join("\n")
    return content.replace(frontmatter, () => processed)
  }

  export async function parse(filePath: string) {
    const raw = await Filesystem.readText(filePath)
    // gap-bom-1-followup-2: PowerShell 5.x writes UTF-8 with leading
    // U+FEFF byte by default. gray-matter's frontmatter detection
    // requires `---` at position 0 — a leading BOM silently breaks
    // parsing, leaving every Windows-PS-edited agent / task-note /
    // skill markdown file with `data: {}` and the entire body in
    // `content` (BOM included). Strip-on-read so PS-written files
    // get their `description`, `mode`, `tools`, etc. parsed correctly.
    // readText is intentionally left BOM-preserving (gap-bom-1
    // design decision) — only callers with frontmatter semantics
    // need the strip.
    const template = raw.startsWith("\uFEFF") ? raw.slice(1) : raw

    try {
      const md = matter(template)
      return md
    } catch {
      try {
        return matter(fallbackSanitization(template))
      } catch (err) {
        throw new FrontmatterError(
          {
            path: filePath,
            message: `${filePath}: Failed to parse YAML frontmatter: ${errorMessage(err)}`,
          },
          { cause: err },
        )
      }
    }
  }

  export const FrontmatterError = NamedError.create(
    "ConfigFrontmatterError",
    z.object({
      path: z.string(),
      message: z.string(),
    }),
  )
}
