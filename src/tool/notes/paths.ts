import * as path from "path"
import { existsSync } from "fs"
import { InstanceContextStorage as Instance } from "@/foundation/effect/instance-context"
import { Config } from "@/config/config"
// vault-as-sole-filesystem (Stage 0.5, I0.2): forward Config-derived
// overrides into the leaf-level resolver so `notes/root.notesRoot()` (used
// by Global.Path and Log) sees the same value without taking a cyclic
// dependency on Config itself.
import { notesRoot, setNotesRootOverride } from "@/notes/root"
import { TaskNotePath } from "@/foundation/task-note-path"

// ---------------------------------------------------------------------------
// Helpers — paths
// ---------------------------------------------------------------------------

// Normalize a logical path to the canonical vault-relative form.
// Canonical vault layout:
//   scratchpad/task/<projectKey>/{active,deferred,done}/todo-<slug>
//   project/software/<projectKey>/<kind>/<name>
//   atomic/{principle,pattern,reference,literature,domain,skill}/<name>
// Callers may pass either a canonical logical path (kept as-is) or a
// vault-absolute form including the project mount prefix. The only legal
// stripping here is removing `project/software/<projectKey>/` when callers
// pass a vault-absolute reference, since `projectRoot()` already anchors
// there. Trailing `.md` is dropped.
export function cleanPath(rel: string) {
  return rel.replace(/^project\/software\/[^/]+\//, "").replace(/\.md$/, "")
}

export const toLogicalPath = cleanPath

export function slug(text: string) {
  const clean = text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
  return clean || "project"
}

// Canonical project key normalization rules.
// Some project families share a single vault key regardless of the exact
// directory name (e.g. all WLAN* projects share the "wlan" key).
const PROJECT_KEY_OVERRIDES: Array<[RegExp, string]> = [[/^wlan/i, "wlan"]]

export function keyFor(base: string, name = "", dir = "project") {
  const raw = (base && base !== "/" ? base : "") || name || dir
  const s = slug(raw)
  for (const [re, key] of PROJECT_KEY_OVERRIDES) {
    if (re.test(raw) || re.test(name) || re.test(dir)) return key
  }
  return s
}

export function projectKey() {
  const base = path.basename(Instance.project.worktree || "")
  const name = Instance.project.name || ""
  const dir = path.basename(Instance.directory)
  return keyFor(base, name, dir)
}

// Per-instance-directory cache of the resolved notes-root from opencode.json.
// Hydrated by hydrateRootBase() and read synchronously by rootBase().
const cachedConfigRoot = new Map<string, string | null>()

function instanceKey() {
  try {
    return Instance.directory
  } catch {
    return ""
  }
}

/**
 * Clear the per-instance notes-root cache. Used in tests to reset state
 * between test runs that use the same instance directory.
 */
export function clearRootBaseCache(key?: string): void {
  if (key) {
    cachedConfigRoot.delete(key)
  } else {
    cachedConfigRoot.clear()
  }
  setNotesRootOverride(null)
}

/**
 * Hydrate the per-instance notes-root cache from opencode.json `notes.root`.
 * Call this from any async entry point before sync helpers run; it is a
 * no-op after the first successful call for a given instance directory.
 */
export async function hydrateRootBase(): Promise<void> {
  const key = instanceKey()
  if (!key) return
  if (cachedConfigRoot.has(key)) return
  try {
    const cfg = await Config.get()
    const value = cfg.notes?.root?.trim()
    const resolved = value && value.length > 0 ? value : null
    cachedConfigRoot.set(key, resolved)
    // Mirror the resolved value into the leaf resolver so Global.Path
    // (which feeds Log + Database) sees the same vault root.
    setNotesRootOverride(resolved)
  } catch {
    cachedConfigRoot.set(key, null)
    setNotesRootOverride(null)
  }
}

/**
 * Resolve the notes vault root through the canonical leaf resolver. Call
 * hydrateRootBase() first when config-derived `notes.root` must be visible;
 * OPENCODE_NOTES_ROOT still wins immediately for tests/CI overrides.
 */
export function rootBase() {
  return notesRoot()
}

// Vault layout:
//
//   ~/notes/atomic/                              ← shared universal atoms
//   ~/notes/scratchpad/task/<project>/active/todo-<slug>/todo.md    ← inflight task notes
//   ~/notes/scratchpad/task/<project>/deferred/todo-<slug>/todo.md  ← paused task notes
//   ~/notes/scratchpad/task/<project>/done/todo-<slug>/todo.md      ← archived task notes
//   ~/notes/project/software/<slug>/             ← project-specific structured knowledge
//
// `projectRoot()` is the per-project structured mount; `sharedRoot()` is the
// universal substrate; `scratchpadRoot()` is the project-specific task root
// (i.e. ~/notes/scratchpad/task/<slug>/).

const PROJECT_CATEGORY = "software"

export function projectRoot() {
  const base = rootBase()
  const name = projectKey()
  return path.join(base, "project", PROJECT_CATEGORY, name)
}

export function sharedRoot() {
  return path.join(rootBase(), "atomic")
}

export function scratchpadRoot() {
  const base = rootBase()
  const name = projectKey()
  return path.join(base, "scratchpad", "task", name)
}

// Universal kinds that always live in ~/notes/atomic/, regardless of which
// project the agent is operating in. Per ~/notes/atomic/README.md.
// Note: concept/ is intentionally excluded — project-specific concept notes
// live in the project vault (concept/ folder), not the shared atomic vault.
const ATOM_KIND_PREFIXES = ["atomic/", "principle/", "pattern/", "reference/", "literature/", "domain/"] as const

export function isSharedPath(rel: string) {
  if (rel.startsWith("shared::")) return true
  if (rel === "atomic") return true
  for (const p of ATOM_KIND_PREFIXES) if (rel.startsWith(p)) return true
  // `skill/` is ambiguous: per-project skills live in project/, universal
  // skills live in atomic/skill/. Disambiguate by leading `atomic/skill/`.
  return false
}

// Return the cleaned path stripped of an `atomic/` prefix when the rel
// already starts with one of the atom kind subfolders. Used by resolvePath
// to compute a vault-relative file path.
function atomicCleanPath(rel: string) {
  const c = cleanPath(rel)
  if (c.startsWith("atomic/")) return c.slice("atomic/".length)
  return c
}

// The canonical set of roots the vault contains. Used by noteRel + inRoots
// to classify an absolute filesystem path back into its logical layer.
// Order matches routing priority in resolvePath: scratchpad → project →
// shared (atomic). rootBase is the universal ancestor used only as a
// reverse-lookup fallback.
export function allRoots() {
  return [...new Set([scratchpadRoot(), projectRoot(), sharedRoot(), rootBase()])]
}

// docRoot() is the writable per-project root used when writing module/skill/
// task/etc notes. Atomic/concept/principle/pattern writes are routed to the
// shared vault via resolvePath().
export function docRoot() {
  return projectRoot()
}

function taskNoteCandidateFiles(rel: string): string[] | null {
  const canonical = TaskNotePath.canonicalize(rel)
  const parsed = TaskNotePath.parse(canonical)
  if (!parsed) return null
  return TaskNotePath.noteFileCandidates(canonical).map((candidate) => {
    const parts = candidate.split("/").filter(Boolean)
    const tail = parts.slice(3).join("/") // drop scratchpad/task/<project>
    return path.join(rootBase(), "scratchpad", "task", parsed.project, tail)
  })
}

export function resolvePath(rel: string, root = docRoot()) {
  const taskCandidates = taskNoteCandidateFiles(rel)
  if (taskCandidates?.length) return taskCandidates[0]
  if (rel.startsWith("scratchpad/")) {
    const clean = cleanPath(rel).replace(/^scratchpad\//, "")
    // scratchpadRoot() already includes task/<project>/, so strip that prefix
    // if the caller passed a fully-qualified scratchpad/task/<project>/... path.
    const projectName = projectKey()
    const stripped = clean.replace(new RegExp(`^task/${projectName}/`), "").replace(/^task\/[a-z0-9-]+\//, "")
    return path.join(scratchpadRoot(), stripped + ".md")
  }
  if (isSharedPath(rel)) return path.join(sharedRoot(), atomicCleanPath(rel) + ".md")
  return path.join(root, cleanPath(rel) + ".md")
}

// Reads prefer folder-backed task notes and then fall back to legacy flat .md.
export function resolveReadPath(rel: string) {
  const taskCandidates = taskNoteCandidateFiles(rel)
  if (taskCandidates?.length) {
    for (const candidate of taskCandidates) if (existsSync(candidate)) return candidate
    return taskCandidates[0]
  }
  return resolvePath(rel)
}

function isPathInsideRoot(rel: string) {
  return !rel.startsWith("@/tool") && !rel.startsWith("..") && !path.isAbsolute(rel)
}

export function noteRel(fp: string) {
  const scratchRoot = scratchpadRoot()
  const sbr = path.relative(scratchRoot, fp)
  if (isPathInsideRoot(sbr)) {
    // Reconstruct full scratchpad/task/<project>/<state>/todo-* path.
    // Folder-backed task entry files report the logical task folder, not
    // the physical todo.md file.
    const projectName = projectKey()
    const rel = (`scratchpad/task/${projectName}/` + sbr).replace(/\.md$/, "")
    return rel.replace(/\/todo$/, "")
  }
  // shared atomic vault — prefix with `atomic/` for consistency with vault layout
  const sroot = sharedRoot()
  const srel = path.relative(sroot, fp)
  if (isPathInsideRoot(srel)) return ("atomic/" + srel).replace(/\.md$/, "")
  for (const root of allRoots()) {
    const rel = path.relative(root, fp)
    if (isPathInsideRoot(rel)) return rel.replace(/\.md$/, "")
  }
  return path.basename(fp, ".md")
}

export function inRoots(fp: string) {
  for (const root of allRoots()) {
    const rel = path.relative(root, fp)
    if (isPathInsideRoot(rel)) return true
  }
  return false
}
