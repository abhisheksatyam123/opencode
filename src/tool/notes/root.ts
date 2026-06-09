import * as fs from "fs/promises"
import * as path from "path"
import { docRoot, hydrateRootBase, rootBase, scratchpadRoot, sharedRoot } from "@/tool/notes/paths"

// Per-project software folders, per ~/notes/README.md "Five questions every
// software project answers" + the lifecycle/artifact categories alongside.
const PROJECT_FOLDERS = [
  "architecture",
  "concept",
  "module",
  "data",
  "decision",
  "skill",
  "derived",
  "diagram",
  "flow",
  "task",
  "moc",
] as const

// Top-level atomic subfolders, per ~/notes/atomic/ structure.
const ATOMIC_FOLDERS = ["concept", "domain", "literature", "pattern", "principle", "reference", "skill"] as const

const SCRATCHPAD_STATES = ["active", "deferred", "done", "failed"] as const

export async function ensureRoot() {
  await hydrateRootBase()
  const base = rootBase()
  if (!base) return

  const project = docRoot()
  for (const folder of PROJECT_FOLDERS) await fs.mkdir(path.join(project, folder), { recursive: true })

  const shared = sharedRoot()
  for (const folder of ATOMIC_FOLDERS) await fs.mkdir(path.join(shared, folder), { recursive: true })

  const scratchpad = scratchpadRoot()
  for (const state of SCRATCHPAD_STATES) await fs.mkdir(path.join(scratchpad, state), { recursive: true })
}
