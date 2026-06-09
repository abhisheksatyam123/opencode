import { NEED } from "@/tool/notes/types"
import type { Frontmatter, Seed } from "@/tool/notes/types"
import { serializeFrontmatter } from "@/tool/notes/frontmatter"
import { noteKind } from "@/tool/notes/headings"
import { seedSection } from "@/tool/notes/schema"
import { bootData } from "@/tool/notes/boot-seeds"
import * as fs from "fs/promises"
import * as path from "path"
import { existsSync } from "fs"
import { parseFrontmatter } from "@/tool/notes/frontmatter"
import { readLines } from "@/tool/notes/io"

// ---------------------------------------------------------------------------
// Bootstrap helpers — seed assembly
// ---------------------------------------------------------------------------

// Scan the repo's doc/ directory for existing notes and convert them into
// seed rows. Repo notes take precedence over generic bootstrap seeds on
// path collision (repo-specific knowledge wins over generic templates).
// Each imported note gets a `source:` frontmatter field pointing back to
// the original repo doc path for traceability.
export async function repoRows(): Promise<Seed[]> {
  let repoDocDir: string
  try {
    const { InstanceContextStorage: Instance } = await import("@/foundation/effect/instance-context")
    repoDocDir = path.join(Instance.directory, "doc")
  } catch {
    return []
  }
  if (!existsSync(repoDocDir)) return []

  const rows: Seed[] = []
  const entries = await fs.readdir(repoDocDir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const kindDir = path.join(repoDocDir, entry.name)
    const files = await fs.readdir(kindDir).catch(() => [] as string[])
    for (const file of files) {
      if (!file.endsWith(".md")) continue
      const fp = path.join(kindDir, file)
      const rel = `${entry.name}/${path.basename(file, ".md")}`
      const lines = await readLines(fp).catch(() => [] as string[])
      if (!lines.length) continue
      const { fm } = parseFrontmatter(lines)
      const title = path.basename(file, ".md")
      // Add source traceability field and default owner
      const seedFm: Frontmatter = {
        ...fm,
        source: `doc/${rel}.md`,
        owner: (fm.owner as string) || "repo",
      }
      // Extract ALL section content from the note (not just NEED sections)
      const sec: Partial<Record<string, string>> = {}
      let currentSection = ""
      const sectionLines: string[] = []
      for (const line of lines) {
        const m = line.match(/^## (.+)$/)
        if (m) {
          if (currentSection) {
            sec[currentSection] = sectionLines.join("\n").trim()
          }
          currentSection = m[1].trim()
          sectionLines.length = 0
        } else if (currentSection) {
          sectionLines.push(line)
        }
      }
      if (currentSection) {
        sec[currentSection] = sectionLines.join("\n").trim()
      }
      rows.push({ path: rel, title, fm: seedFm, sec })
    }
  }
  return rows
}

export async function bootRows() {
  const rows = new Map<string, Seed>()
  const { rootBase } = await import("@/tool/notes/paths")
  const root = rootBase()
  for (const row of bootData) {
    if (row.path === "moc/project-home" && row.sec?.Notes) {
      row.sec.Notes = row.sec.Notes.replace("~/notes/atomic/", path.join(root, "atomic") + "/")
    }
    rows.set(row.path, row)
  }
  for (const row of await repoRows()) rows.set(row.path, row)
  return [...rows.values()]
}

export function bootLines(input: {
  path: string
  title: string
  fm: Frontmatter
  sec: Partial<Record<string, string>>
}) {
  const kind = noteKind(input.path)
  const need = kind ? NEED[kind] : []
  const out: string[] = []

  // First, include all sections from the seed data (preserves repo content)
  const seenSections = new Set<string>()
  for (const [sec, body] of Object.entries(input.sec)) {
    if (!body) continue
    out.push(`## ${sec}`, "", ...body.split("\n"), "")
    seenSections.add(sec.toLowerCase())
  }

  // Then, add any required sections that are missing from the seed data
  for (const sec of need) {
    if (seenSections.has(sec.toLowerCase())) continue
    const body = seedSection(kind, sec).join("\n")
    out.push(`## ${sec}`, "", ...body.split("\n"), "")
  }

  return [...serializeFrontmatter(input.fm), "", `# ${input.title}`, "", ...out]
}

// Re-export bootData for external consumers
export { bootData } from "@/tool/notes/boot-seeds"
