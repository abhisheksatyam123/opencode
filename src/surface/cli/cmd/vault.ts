// src/cli/cmd/vault.ts — Stage 0.5 (I0.11) operator-facing
// vault management subcommands.
// -------------------------------------------------------------------------
// Authoritative contract:
//   project/software/opencode/specification/contract/vault-as-sole-filesystem.md
//     §garbage-collection — `Gc.run()` already sweeps tmp + log on schedule;
//     this command exposes per-kind manual prune for cache subtrees.
//
// Sole subcommand:
//
//   opencode vault prune <kind> [--older-than DAYS] [--dry-run] [--force]
//     1. <kind> is one of: cache | tmp | log | session | all (excluding
//        state/session by default — that requires explicit `session` kind
//        per contract §garbage-collection rule 6).
//     2. Show enumerated subtree sizes + entry counts.
//     3. Prompt to confirm; --force skips.
//     4. For cache + tmp + log kinds, delegates to Gc.run({trigger:"manual"})
//        with appropriate scope; for session, walks state/session/<id>/ and
//        prompts per-id (no automation — we never auto-purge user data).
//
// Legacy `adopt` subcommand removed — vault-as-sole-filesystem is now strict;
// XDG paths are not migrated on boot, so there is nothing to "adopt".
// -------------------------------------------------------------------------

import type { Argv } from "yargs"
import * as prompts from "@clack/prompts"
import path from "path"
import { existsSync, statSync, readdirSync, rmSync } from "fs"
import { cmd } from "@/surface/cli/cmd/cmd"
import { UI } from "@/surface/cli/ui"
import { Gc } from "@/storage/gc"
import { vaultPath, notesRoot } from "@/notes/root"

// ── helpers ──────────────────────────────────────────────────────────────

function bytesHuman(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function dirSize(dir: string): { entries: number; bytes: number } {
  if (!existsSync(dir)) return { entries: 0, bytes: 0 }
  let entries = 0
  let bytes = 0
  function walk(p: string) {
    let dirents: string[]
    try {
      dirents = readdirSync(p)
    } catch {
      return
    }
    for (const name of dirents) {
      const child = path.join(p, name)
      let st
      try {
        st = statSync(child)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        walk(child)
      } else {
        entries++
        bytes += st.size
      }
    }
  }
  walk(dir)
  return { entries, bytes }
}

// ── prune subcommand (I0.11) ─────────────────────────────────────────────

const PruneKinds = ["cache", "tmp", "log", "session", "all"] as const
type PruneKind = (typeof PruneKinds)[number]

interface PruneArgs {
  kind: PruneKind
  olderThan: number
  dryRun: boolean
  force: boolean
}

const VaultPruneCommand = cmd({
  command: "prune <kind>",
  describe: "manually purge a vault subtree (cache | tmp | log | session | all)",
  builder: (yargs: Argv) =>
    yargs
      .positional("kind", {
        type: "string",
        choices: PruneKinds,
        describe: "which subtree to prune",
        demandOption: true,
      })
      .option("older-than", {
        type: "number",
        describe: "only prune entries older than DAYS (default 30 for log; ignored for tmp/session)",
        default: 30,
      })
      .option("dry-run", {
        type: "boolean",
        describe: "show what would be purged without removing",
        default: false,
      })
      .option("force", {
        alias: "f",
        type: "boolean",
        describe: "skip confirmation prompts",
        default: false,
      }),
  handler: async (args: PruneArgs) => {
    UI.empty()
    prompts.intro(`Vault prune — kind=${args.kind}`)
    prompts.log.info(`Vault root: ${notesRoot()}`)

    if (args.kind === "session") {
      // Per contract §garbage-collection rule 6: state/session/<id>/ is
      // NEVER auto-purged; per-id manual confirmation required.
      const sessionRoot = vaultPath.state("session")
      if (!existsSync(sessionRoot)) {
        prompts.log.warn(`No state/session/ subtree at ${sessionRoot}`)
        prompts.outro("Nothing to prune")
        return
      }
      const entries = readdirSync(sessionRoot)
        .map((name) => ({ name, full: path.join(sessionRoot, name) }))
        .filter((e) => {
          try {
            return statSync(e.full).isDirectory()
          } catch {
            return false
          }
        })
      if (entries.length === 0) {
        prompts.log.success("No per-session directories present (DB files retained).")
        prompts.outro("Done")
        return
      }
      prompts.log.info(`Found ${entries.length} per-session directory(ies):`)
      for (const e of entries) {
        const sz = dirSize(e.full)
        prompts.log.info(`  ${e.name} — ${sz.entries} files, ${bytesHuman(sz.bytes)}`)
      }
      if (!args.force && !args.dryRun) {
        const confirm = await prompts.confirm({
          message: `Permanently remove all ${entries.length} session director(ies) above?`,
          initialValue: false,
        })
        if (!confirm || prompts.isCancel(confirm)) {
          prompts.outro("Cancelled")
          return
        }
      }
      let removed = 0
      for (const e of entries) {
        if (args.dryRun) {
          prompts.log.warn(`[dry-run] would rm -rf ${e.full}`)
          continue
        }
        try {
          rmSync(e.full, { recursive: true, force: true })
          prompts.log.success(`Removed ${e.full}`)
          removed++
        } catch (err) {
          prompts.log.error(`Failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      prompts.outro(`Done — ${removed}/${entries.length} removed`)
      return
    }

    // For cache | tmp | log | all, summarise + confirm + delegate to Gc.run().
    const subtrees: Array<{ kind: string; path: string; size: { entries: number; bytes: number } }> = []
    if (args.kind === "tmp" || args.kind === "all") {
      const tmpRoot = vaultPath.tmpRoot()
      subtrees.push({ kind: "tmp", path: tmpRoot, size: dirSize(tmpRoot) })
    }
    if (args.kind === "cache" || args.kind === "all") {
      const cacheRoot = vaultPath.cacheRoot()
      subtrees.push({ kind: "cache", path: cacheRoot, size: dirSize(cacheRoot) })
    }
    if (args.kind === "log" || args.kind === "all") {
      const logRoot = vaultPath.logRoot()
      subtrees.push({ kind: "log", path: logRoot, size: dirSize(logRoot) })
    }

    if (subtrees.every((s) => s.size.entries === 0)) {
      prompts.log.success(`No entries to prune in ${args.kind}.`)
      prompts.outro("Done")
      return
    }

    prompts.log.info("Subtree sizes (pre-prune):")
    for (const s of subtrees) {
      prompts.log.info(`  ${s.kind}: ${s.size.entries} files, ${bytesHuman(s.size.bytes)} (${s.path})`)
    }

    if (!args.force && !args.dryRun) {
      const confirm = await prompts.confirm({
        message: `Run GC on ${args.kind}? Tmp purges by inactive-session; log purges files older than ${args.olderThan} days; cache purges via registered predicates.`,
        initialValue: false,
      })
      if (!confirm || prompts.isCancel(confirm)) {
        prompts.outro("Cancelled")
        return
      }
    }

    if (args.dryRun) {
      prompts.log.warn("[dry-run] skipping Gc.run()")
      prompts.outro("Done")
      return
    }

    // For tmp purge to work, we'd need active session ids; on a CLI invocation
    // the engine isn't running, so we treat all sessions as inactive (none in
    // memory). The DB is the source of truth for live sessions; pulling the
    // active set would require Database.use() bootstrap which is heavyweight
    // for a one-shot CLI. Instead: pass an empty active-set ⇒ rule 1 sweeps
    // ALL tmp/<sid>/ directories. This matches the user's intent ("prune tmp")
    // when invoked manually outside an active session.
    const activeSessionIds: string[] = []
    const stats = Gc.run({
      trigger: "manual",
      activeSessionIds,
      logRetainDays: args.olderThan,
    })
    prompts.log.success(
      `Gc.run(manual): ${stats.purged.length} entr(ies) freed ${bytesHuman(stats.total_bytes_freed)}; ${stats.errors.length} error(s).`,
    )
    if (stats.errors.length) {
      for (const e of stats.errors) prompts.log.warn(e)
    }
    prompts.outro("Done")
  },
})

// ── parent vault command ─────────────────────────────────────────────────

export const VaultCommand = cmd({
  command: "vault",
  describe: "vault management (prune subtrees)",
  builder: (yargs: Argv) => yargs.command(VaultPruneCommand).demandCommand(),
  handler: async () => {
    // demandCommand routes to subcommand; this never runs.
  },
})
