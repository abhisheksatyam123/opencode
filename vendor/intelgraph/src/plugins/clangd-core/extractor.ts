/**
 * clangd-core/extractor.ts — the C/C++ extraction plugin.
 *
 * Slim orchestrator that runs 5 extraction phases in sequence. Each phase
 * is a separate reusable module under ./phases/ that any C/C++ project
 * can share. Project-specific knowledge (registration APIs, dispatch chain
 * templates, log macros, HW entity definitions) comes from the pack
 * system under ./packs/<project>/.
 *
 * Architecture:
 *
 *   extractor.ts (this file)  ← orchestrator, ~80 LOC
 *   phases/symbols.ts         ← Phase 1: symbols + types via clangd LSP
 *   phases/calls.ts           ← Phase 2: direct call edges via clangd
 *   phases/logs.ts            ← Phase 3: log-event edges via tree-sitter
 *   phases/field-access.ts    ← Phase 4: reads_field / writes_field via tree-sitter
 *   phases/callbacks.ts       ← Phase 5: registration + runtime_calls + HW entities
 *   packs/<project>/          ← project-specific data (Linux, WLAN, etc.)
 *
 * Each phase is an async generator that yields facts via ctx.symbol(),
 * ctx.type(), ctx.edge(). The orchestrator yields from each in sequence.
 */

import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { defineExtractor } from "../../intelligence/extraction/contract.js"
import type { Capability, WorkspaceProbe } from "../../intelligence/extraction/contract.js"
import type { SymbolRow } from "../../intelligence/contracts/common.js"
import { initParser } from "../../tools/pattern-detector/c-parser.js"
import {
  collectAllLogMacros,
  collectAllDispatchChains,
  collectAllCallPatterns,
  collectAllHWEntities,
} from "./packs/index.js"

// Phase modules
import { extractSymbols } from "./phases/symbols.js"
import { extractCalls } from "./phases/calls.js"
import { extractCallsAst } from "./phases/calls-ast.js"
import { extractLogs } from "./phases/logs.js"
import { extractFieldAccess } from "./phases/field-access.js"
import { extractCallbacks } from "./phases/callbacks.js"
import { extractContainment } from "./phases/containment.js"
import { extractTypeRefs } from "./phases/type-refs.js"
import { extractSyscallMacros } from "./phases/syscall-macros.js"
import type { FileSymbolMap } from "./phases/types.js"

const CAPABILITIES: Capability[] = ["symbols", "types", "direct-calls", "log-events"]

const C_FAMILY_EXTENSIONS = [".c", ".h", ".cpp", ".cc", ".cxx", ".hpp"] as const

const clangdCoreExtractor = defineExtractor({
  metadata: {
    name: "clangd-core",
    version: "0.2.0",
    description:
      "C/C++ extraction via clangd LSP + tree-sitter AST walk. " +
      "Produces symbols, direct calls, log events, struct field access, " +
      "callback registrations, runtime dispatch chains, and HW entity nodes. " +
      "Project-specific knowledge comes from packs/<project>/.",
    capabilities: CAPABILITIES,
    appliesTo: (probe: WorkspaceProbe) => {
      if (probe.hasCompileCommands) return true
      const root = probe.workspaceRoot
      if (hasCFamilyShallow(root) || hasCFamilyShallow(join(root, "src"))) return true
      // WLAN/embedded workspaces: C files are nested deep under wlan_proc/ etc.
      const wlanDirs = ["wlan_proc", "wlan", "wmi", "cmnos"]
      return wlanDirs.some((d) => existsSync(join(root, d)))
    },
  },

  async *extract(ctx) {
    // ── File discovery ─────────────────────────────────────────────────
    const envLimit = Number.parseInt(process.env.INTELGRAPH_C_FILE_LIMIT ?? "", 10)
    const fileLimit = Number.isFinite(envLimit) && envLimit > 0 ? envLimit : 5000

    // Optional comma-separated priority subdirs (e.g. "wlan_proc/wlan/syssw_platform,wlan_proc/wlan/protocol").
    // Each subdir is front-loaded before backfilling from workspace root.
    const prioritySubdirEnv = process.env.INTELGRAPH_C_PRIORITY_DIR
    const prioritySubdirs = prioritySubdirEnv
      ? prioritySubdirEnv
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : []
    // Optional comma-separated dir names to skip (e.g. "bsp,build,rom" to skip ROM binary dirs).
    const skipDirsEnv = process.env.INTELGRAPH_C_SKIP_DIRS
    const skipDirSet = skipDirsEnv ? new Set(skipDirsEnv.split(",").map((s) => s.trim())) : null
    const skipDirFn = skipDirSet ? (name: string) => name.startsWith(".") || skipDirSet.has(name) : undefined

    let files: string[]
    if (prioritySubdirs.length > 0) {
      const wsRoot = ctx.workspace.root
      const seen = new Set<string>()
      files = []
      // Front-load each priority subdir in order
      for (const subdir of prioritySubdirs) {
        if (files.length >= fileLimit) break
        const priorityDir = join(wsRoot, subdir)
        const priorityFiles = await ctx.workspace.walkFiles({
          extensions: C_FAMILY_EXTENSIONS,
          limit: fileLimit,
          startDir: priorityDir,
          ...(skipDirFn ? { skipDir: skipDirFn } : {}),
        })
        for (const f of priorityFiles) {
          if (!seen.has(f)) {
            seen.add(f)
            files.push(f)
            if (files.length >= fileLimit) break
          }
        }
      }
      // Backfill remaining budget from workspace root (dedup by Set)
      if (files.length < fileLimit) {
        const rest = await ctx.workspace.walkFiles({
          extensions: C_FAMILY_EXTENSIONS,
          limit: fileLimit,
          ...(skipDirFn ? { skipDir: skipDirFn } : {}),
        })
        for (const f of rest) {
          if (!seen.has(f)) {
            seen.add(f)
            files.push(f)
            if (files.length >= fileLimit) break
          }
        }
      }
    } else {
      files = await ctx.workspace.walkFiles({
        extensions: C_FAMILY_EXTENSIONS,
        limit: fileLimit,
        ...(skipDirFn ? { skipDir: skipDirFn } : {}),
      })
    }
    ctx.metrics.count("files-discovered", files.length)

    // ── Initialize tree-sitter for Phases 3-5 ──────────────────────────
    await initParser()

    // ── Collect pack data ──────────────────────────────────────────────
    const logMacroMap = collectAllLogMacros()
    const dispatchTemplateMap = collectAllDispatchChains()
    const callPatterns = collectAllCallPatterns()
    const hwEntities = collectAllHWEntities()

    // ── Shared state: per-file symbol cache ────────────────────────────
    const fileSymbols: FileSymbolMap = new Map()

    // ── Phase 1: symbols + types (clangd LSP) ─────────────────────────
    yield* extractSymbols(ctx, files, fileSymbols)

    // ── Phase 2: direct call edges (clangd outgoingCalls) ─────────────
    yield* extractCalls(ctx, fileSymbols)

    // ── Phase 2b: AST-based direct call fallback (tree-sitter) ────────
    // Runs always — fills gaps when clangd is unavailable and provides
    // call edges for functions not covered by LSP outgoingCalls.
    yield* extractCallsAst(ctx, fileSymbols)

    // ── Phase 3: log-event edges (tree-sitter AST walk) ───────────────
    yield* extractLogs(ctx, fileSymbols, logMacroMap)

    // ── Phase 4: struct field read/write edges (tree-sitter) ──────────
    yield* extractFieldAccess(ctx, fileSymbols)

    // ── Phase 5: callback registration + runtime_calls + HW entities ──
    yield* extractCallbacks(ctx, fileSymbols, {
      callPatterns,
      dispatchTemplateMap,
      hwEntities,
    })

    // ── Phase 6: containment + import edges (tree-sitter) ─────────────
    yield* extractContainment(ctx, files, fileSymbols)

    // ── Phase 7: type references + field_of_type + aggregates ─────────
    yield* extractTypeRefs(ctx, fileSymbols)

    // ── Phase 8: SYSCALL_DEFINE macro detection ───────────────────────
    yield* extractSyscallMacros(ctx, files, dispatchTemplateMap)
  },
})

export default clangdCoreExtractor

// ---------------------------------------------------------------------------
// appliesTo helper
// ---------------------------------------------------------------------------

const C_FAMILY_FILE_EXTS = [".c", ".h", ".cpp", ".cc", ".cxx", ".hpp"]

function hasCFamilyShallow(dir: string): boolean {
  if (!existsSync(dir)) return false
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return false
  }
  for (const entry of entries) {
    const name = entry.name
    if (entry.isFile()) {
      if (C_FAMILY_FILE_EXTS.some((ext) => name.endsWith(ext))) return true
    } else if (entry.isDirectory() && !name.startsWith(".") && name !== "node_modules") {
      try {
        const subEntries = readdirSync(join(dir, name), { withFileTypes: true })
        for (const sub of subEntries) {
          if (sub.isFile() && C_FAMILY_FILE_EXTS.some((ext) => sub.name.endsWith(ext))) return true
        }
      } catch {
        /* unreadable */
      }
    }
  }
  return false
}
