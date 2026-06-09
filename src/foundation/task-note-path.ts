import { vaultPath } from "@/foundation/notes-root"

/**
 * Handle path verification, structural parsing, and file mapping for folder-backed
 * canonical task notes under the notes vault:
 *
 *   scratchpad/task/<project>/<state>/todo-<slug>/todo.md
 *
 * All workflow writes and tool spawns must use this folder structure.
 */
export namespace TaskNotePath {
  export const STATES = ["active", "deferred", "done", "failed"] as const
  export type State = (typeof STATES)[number]

  const SLUG_PREFIX = "todo-"
  /** Segment character class: lowercase alphanumeric + hyphen. */
  const SEG = /^[a-z0-9-]+$/

  /** Canonical runtime contract for task notes. */
  export const CANONICAL_PATH_REGEX =
    /^(?:scratchpad\/task\/[a-z0-9-]+\/(?:active|deferred|done|failed)\/todo-[a-z0-9-]+)(?:\.md)?$/

  /** Authoritative regex for every accepted task-note path form. */
  export const PATH_REGEX = CANONICAL_PATH_REGEX

  /**
   * Canonical task-note substring matcher (no anchors, captures the path).
   * Used by the `Task note:` prompt-line extractor in `src/tool/task/index.ts`.
   */
  export const PATH_SUBSTRING_REGEX =
    /Task note:\s*((?:scratchpad\/task\/[a-z0-9-]+\/(?:active|deferred|done|failed)\/todo-[a-z0-9-]+)(?:\.md)?)/i

  /**
   * Strip absolute vault root prefix, folder-backed `todo.md` entry file,
   * and trailing `.md` suffix.
   */
  export function canonicalize(input: string): string {
    let s = input.trim()
    const root = vaultPath.root()
    if (s.startsWith(root)) {
      s = s.slice(root.length)
    }
    s = s.replace(/\\/g, "/")
    s = s.replace(/^\//, "")
    s = s.replace(/\/todo\.md$/i, "")
    s = s.replace(/\.md$/i, "")
    return s
  }

  /**
   * Extract structural parts from a canonical task-note path.
   * Returns `null` if the input is not a valid task-note path.
   */
  export function parse(input: string): { project: string; state: State; slug: string } | null {
    const canon = canonicalize(input)
    const parts = canon.slice("scratchpad/task/".length).split("/")
    if (!canon.startsWith("scratchpad/task/") || parts.length !== 3) return null
    const stateSet = new Set<string>(STATES)
    if (!SEG.test(parts[0]) || !stateSet.has(parts[1]) || !parts[2].startsWith(SLUG_PREFIX) || !SEG.test(parts[2])) {
      return null
    }
    return { project: parts[0], state: parts[1] as State, slug: parts[2] }
  }

  /** True iff `input` is the canonical vault-relative task-note path. */
  export function isValid(input: string): boolean {
    return parse(input) !== null
  }

  export function isCanonical(input: string): boolean {
    return CANONICAL_PATH_REGEX.test(canonicalize(input))
  }

  /**
   * Task-note entry file candidates, in write preference order.
   *
   * New task notes are folder-backed (`todo-<slug>/todo.md`). The flat
   * `todo-<slug>.md` form remains readable for existing vaults and tests.
   */
  export function noteFileCandidates(input: string): string[] {
    const canon = canonicalize(input)
    return [`${canon}/todo.md`, `${canon}.md`]
  }

  /** Named subdirectory for a task note folder. */
  export function artifactFolder(input: string): string {
    return canonicalize(input)
  }

  /** Supporting subdirectory path under the task-local folder. */
  export function artifactSubdir(input: string, sub: string): string {
    return `${canonicalize(input)}/${sub.trim()}`
  }

  /** Absolute or vault-relative file path to the folder-backed `todo.md` entry. */
  export function artifactTodo(input: string): string {
    return `${canonicalize(input)}/todo.md`
  }

  /** Normalize for comparison: strip vault root + `.md` + `scratchpad/` prefix. */
  export function normalize(input: string): string {
    return canonicalize(input).replace(/^scratchpad\//, "")
  }
}
