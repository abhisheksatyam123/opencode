// vault-as-sole-filesystem path resolver
// -------------------------------------------------------------------------
// Authoritative contract: project/software/opencode/specification/contract/
//   vault-as-sole-filesystem.md
//
// Single choke point for every storage destination opencode persists to.
// Every persistent path is computed from <notesRoot()>, not from
// `os.homedir()`, `os.tmpdir()`, `XDG_*`, or project-local hidden directories.
// Adding a new storage class = adding a new `vaultPath.<class>(...)` helper
// here; consumer code MUST NOT assemble paths via `path.join(notesRoot(),
// "<class>", ...)` — go through the helper so all paths stay enumerable
// for GC, permission, and migration.
//
// IMPORT GRAPH
// ============
// This module MUST stay leaf-level (no transitive Config / Log / Global
// imports). It is consumed by `Global.Path` which Log uses, so any
// upward reference would cycle. Config-derived overrides arrive lazily via
// `setNotesRootOverride()` invoked from `tool/notes/paths.hydrateRootBase()`
// after Config is available. Until that hook fires, env + default win.
// -------------------------------------------------------------------------

import * as path from "path"

const HARDCODED_DEFAULT = path.join(process.env.HOME || process.env.USERPROFILE || "/tmp", "notes")

function defaultNotesRoot(): string {
  return process.env.OPENCODE_DEFAULT_NOTES_ROOT?.trim() || HARDCODED_DEFAULT
}

let configOverride: string | null = null

// ---- Root resolver --------------------------------------------------------

/**
 * Resolve the notes vault root. Precedence:
 *   1. OPENCODE_NOTES_ROOT env (test/CI override)
 *   2. config-derived override set via setNotesRootOverride() (from
 *      `tool/notes/paths.hydrateRootBase()` after Config is available)
 *   3. OPENCODE_DEFAULT_NOTES_ROOT env (test/CI default relocation)
 *   4. hardcoded default (`/local/mnt/workspace/notes`)
 *
 * Synchronous + cycle-safe: this module never imports Config / Log /
 * Global. The config layer hydrates lazily through setNotesRootOverride().
 */
export function notesRoot(): string {
  const env = process.env.OPENCODE_NOTES_ROOT?.trim()
  if (env) return env
  if (configOverride) return configOverride
  return defaultNotesRoot()
}

/**
 * Install the config-derived vault root override. Called by
 * `tool/notes/paths.hydrateRootBase()` once Config has resolved
 * `notes.root` from opencode.json. Pass `null` to clear.
 */
export function setNotesRootOverride(value: string | null | undefined): void {
  configOverride = value && value.length > 0 ? value : null
}

/** Test helper — clear the config override. */
export function clearNotesRootCache(): void {
  configOverride = null
}

// ---- Storage class helpers ------------------------------------------------
//
// Seven storage classes per vault-as-sole-filesystem §Storage taxonomy:
//   knowledge   atomic/ + project/        — universal + per-project durable
//   task-state  scratchpad/               — per-task ephemeral + archive
//   config      etc/                      — opencode.json, federation trust, …
//   cache       cache/                    — regenerable downloads
//   state       state/                    — runtime-derived (session DB, …)
//   log         log/                      — append-only, rotated
//   tmp         tmp/                      — engine scratch, auto-clean

export const vaultPath = {
  // --- knowledge ----------------------------------------------------------

  /** `<root>/atomic/[...]` — universal knowledge. */
  atomic(...rest: string[]): string {
    return path.join(notesRoot(), "atomic", ...rest)
  },

  /** `<root>/project/software/<proj>/[...]` — per-project durable. */
  project(proj: string, ...rest: string[]): string {
    return path.join(notesRoot(), "project", "software", proj, ...rest)
  },

  // --- task-state ---------------------------------------------------------

  /** `<root>/scratchpad/[...]` — agent-facing ephemeral + archive. */
  scratchpad(...rest: string[]): string {
    return path.join(notesRoot(), "scratchpad", ...rest)
  },

  // --- config -------------------------------------------------------------

  /**
   * `<root>/etc/[...]` — engine config. Replaces `~/.config/opencode/`.
   * Defaults: opencode.json, federation/trust.json, permission/overrides.json.
   */
  etc(...rest: string[]): string {
    return path.join(notesRoot(), "etc", ...rest)
  },

  // --- cache --------------------------------------------------------------

  /**
   * `<root>/cache/<kind>/[...]` — regenerable. Replaces `~/.cache/opencode/`.
   * Wipe-safe: deleting `<root>/cache/` MUST never break correctness.
   * Every new `<kind>` MUST register a GC predicate (provider obligation P2).
   */
  cache(kind: string, ...rest: string[]): string {
    return path.join(notesRoot(), "cache", kind, ...rest)
  },

  /** `<root>/cache/` — root of regenerable cache subtree. Used by GC sweep + CLI. */
  cacheRoot(): string {
    return path.join(notesRoot(), "cache")
  },

  // --- state --------------------------------------------------------------

  /**
   * `<root>/state/<kind>/[...]` — runtime-derived. Replaces
   * `~/.local/share/opencode/`.
   * Backup-worthy. Includes session SQLite (`session/<id>/session.db`),
   * dispatch graph snapshots, scribe ledger, per-instance ALS state.
   */
  state(kind: string, ...rest: string[]): string {
    return path.join(notesRoot(), "state", kind, ...rest)
  },

  // --- log ----------------------------------------------------------------

  /**
   * `<root>/log/<kind>/<day>.log` — append-only, daily-rotated.
   * `kind` ∈ engine | tool | permission | <new kinds>. `day` is ISO date.
   * Default retention: 30 days (cfg.log.retain_days).
   */
  log(kind: string, day: string): string {
    return path.join(notesRoot(), "log", kind, `${day}.log`)
  },

  /** `<root>/log/<kind>/` — directory holding rotated files for `kind`. */
  logDir(kind: string): string {
    return path.join(notesRoot(), "log", kind)
  },

  /** `<root>/log/` — root of all log subtrees. Used by GC sweep + CLI. */
  logRoot(): string {
    return path.join(notesRoot(), "log")
  },

  // --- tmp ----------------------------------------------------------------

  /**
   * `<root>/tmp/<sessionId>/[...]` — engine-internal scratch.
   * Auto-cleaned on engine boot when sessionId no longer in state/session/.
   * Distinct from agent-facing `scratchpad/tmp/` (which is human-curated).
   */
  tmp(sessionId: string, ...rest: string[]): string {
    return path.join(notesRoot(), "tmp", sessionId, ...rest)
  },

  /** `<root>/tmp/` — root of engine scratch. Used by GC sweep. */
  tmpRoot(): string {
    return path.join(notesRoot(), "tmp")
  },

  // --- generic root accessor ---------------------------------------------

  /**
   * Escape hatch — full vault root. Use a class helper instead unless you
   * are the path-resolver itself or a GC sweeper enumerating all classes.
   */
  root(): string {
    return notesRoot()
  },
} as const

export type VaultPathKind = "atomic" | "project" | "scratchpad" | "etc" | "cache" | "state" | "log" | "tmp"

/**
 * Enumerate every storage-class subtree directly under the vault root.
 * Used by boot bootstrap (mkdir -p) and GC sweep (per-class predicates).
 */
export function enumerateStorageSubtrees(): Array<{ kind: VaultPathKind; absolute: string }> {
  const root = notesRoot()
  return [
    { kind: "atomic", absolute: path.join(root, "atomic") },
    { kind: "project", absolute: path.join(root, "project") },
    { kind: "scratchpad", absolute: path.join(root, "scratchpad") },
    { kind: "etc", absolute: path.join(root, "etc") },
    { kind: "cache", absolute: path.join(root, "cache") },
    { kind: "state", absolute: path.join(root, "state") },
    { kind: "log", absolute: path.join(root, "log") },
    { kind: "tmp", absolute: path.join(root, "tmp") },
  ]
}
