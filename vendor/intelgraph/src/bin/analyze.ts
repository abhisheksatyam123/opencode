#!/usr/bin/env node
/**
 * analyze.ts — Fast multi-layer analysis against an existing persisted snapshot.
 *
 * Unlike snapshot-stats (which re-extracts from source every run), this tool
 * opens the already-persisted .intelgraph/intelligence.db and runs the Phase 5
 * analysis intents directly against the latest ready snapshot.  Startup time
 * is a few milliseconds rather than the seconds needed for a full extraction.
 *
 * Usage:
 *   bun run src/bin/analyze.ts [workspace]          # text output (default)
 *   bun run src/bin/analyze.ts [workspace] --json
 *   bun run src/bin/analyze.ts [workspace] --markdown
 *   bun run src/bin/analyze.ts [workspace] --action-plan
 *   bun run src/bin/analyze.ts [workspace] --compare=<snapshotId>
 *   bun run src/bin/analyze.ts [workspace] --watch   # re-run on DB change
 *   bun run src/bin/analyze.ts [workspace] --focus=dead_code
 *   bun run src/bin/analyze.ts [workspace] --focus=god_classes
 *   bun run src/bin/analyze.ts [workspace] --focus=refactors
 *   bun run src/bin/analyze.ts [workspace] --focus=modules
 *   bun run src/bin/analyze.ts [workspace] --focus=health
 *   bun run src/bin/analyze.ts [workspace] --limit=20
 *
 * Exit codes:
 *   0  — success
 *   1  — no persisted snapshot found (run `bun run extract <workspace>` first)
 *   2  — bad arguments
 */

import { existsSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { createSqliteStore } from "../intelligence/db/sqlite/factory.js"

// ── CLI argument parsing ────────────────────────────────────────────────────

type Format = "text" | "json" | "markdown"
type Focus = "all" | "dead_code" | "god_classes" | "refactors" | "modules" | "health"

function parseArgs(argv: string[]): {
  workspace: string
  format: Format
  focus: Focus
  limit: number
  actionPlan: boolean
  compareWith: number | null
  watch: boolean
} {
  const args = argv.slice(2)
  let workspace = process.cwd()
  let format: Format = "text"
  let focus: Focus = "all"
  let limit = 20
  let actionPlan = false
  let compareWith: number | null = null
  let watch = false

  for (const arg of args) {
    if (arg === "--json") {
      format = "json"
    } else if (arg === "--markdown" || arg === "--md") {
      format = "markdown"
    } else if (arg === "--action-plan" || arg === "--plan") {
      actionPlan = true
    } else if (arg === "--watch" || arg === "-w") {
      watch = true
    } else if (arg.startsWith("--compare=")) {
      const n = Number(arg.replace("--compare=", ""))
      if (Number.isFinite(n) && n >= 1) compareWith = Math.floor(n)
      else {
        console.error("--compare= requires a positive integer snapshot ID")
        process.exit(2)
      }
    } else if (arg.startsWith("--focus=")) {
      const v = arg.replace("--focus=", "")
      if (["all", "dead_code", "god_classes", "refactors", "modules", "health"].includes(v)) {
        focus = v as Focus
      } else {
        console.error(`Unknown --focus value: ${v}`)
        console.error("Valid values: all, dead_code, god_classes, refactors, modules, health")
        process.exit(2)
      }
    } else if (arg.startsWith("--limit=")) {
      const n = Number(arg.replace("--limit=", ""))
      if (Number.isFinite(n) && n >= 1) limit = Math.floor(n)
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Usage: bun run src/bin/analyze.ts [workspace] [options]",
          "",
          "Options:",
          "  --json                output as JSON",
          "  --markdown            output as Markdown",
          "  --action-plan         show prioritised fix list (all layers combined)",
          "  --compare=<id>        diff current snapshot against snapshot <id>",
          "  --watch               re-run analysis when the DB changes (Ctrl-C to stop)",
          "  --focus=<section>     show only one analysis section:",
          "                        all (default), dead_code, god_classes,",
          "                        refactors, modules, health",
          "  --limit=<n>           max rows per section (default 20)",
          "",
          "Requires an existing .intelgraph/intelligence.db in the workspace.",
          "Run `bun run extract <workspace>` first if none exists.",
        ].join("\n"),
      )
      process.exit(0)
    } else if (!arg.startsWith("--")) {
      workspace = resolve(arg)
    }
  }

  return { workspace, format, focus, limit, actionPlan, compareWith, watch }
}

// ── DB helpers ──────────────────────────────────────────────────────────────

function findDbPath(workspace: string): string | null {
  const paths = [join(workspace, ".intelgraph", "intelligence.db"), join(workspace, ".intelgraph", "intelligence.db")]
  for (const p of paths) {
    if (existsSync(p)) return p
  }
  return null
}

// ── Formatter helpers ───────────────────────────────────────────────────────

function str(v: unknown): string {
  return v == null ? "" : String(v)
}
function num(v: unknown): number {
  return v == null ? 0 : Number(v)
}

function textSection(title: string, rows: Array<Record<string, unknown>>, cols: string[]): string {
  if (rows.length === 0) return `\n${title}:\n  (none)\n`
  const lines: string[] = [`\n${title} (${rows.length}):`]
  for (const row of rows) {
    const parts = cols
      .map((c) => {
        const v = row[c]
        if (v == null || v === "") return null
        return `${c}=${JSON.stringify(v)}`
      })
      .filter(Boolean)
    lines.push(`  ${parts.join("  ")}`)
  }
  return lines.join("\n")
}

function mdTable(headers: string[], rows: Array<Array<string | number>>): string {
  const lines: string[] = []
  lines.push("| " + headers.join(" | ") + " |")
  lines.push("| " + headers.map(() => "---").join(" | ") + " |")
  for (const row of rows) {
    lines.push("| " + row.join(" | ") + " |")
  }
  return lines.join("\n")
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { workspace, format, focus, limit, actionPlan, compareWith, watch } = parseArgs(process.argv)

  if (!existsSync(workspace)) {
    console.error(`Workspace not found: ${workspace}`)
    process.exit(1)
  }

  const dbPath = findDbPath(workspace)
  if (!dbPath) {
    console.error(
      `No persisted snapshot found in ${workspace}.\n` +
        `Run: bun run extract ${workspace}    (or bun run snapshot:stats ${workspace})\n` +
        `to create one first.`,
    )
    process.exit(1)
  }

  const { client, foundation, lookup } = createSqliteStore({ path: dbPath })
  try {
    // Try the resolved absolute path first, then fall back to whatever workspace
    // root strings are actually stored in the DB (the DB may have been built on a
    // different machine or with a relative path).
    let snapshotRef = await foundation.getLatestReadySnapshot(workspace)
    if (!snapshotRef) {
      // Fall back to the most-recent ready snapshot in the DB regardless of path.
      const fallbackRow = client.raw
        .prepare(
          `SELECT snapshot_id AS snapshotId, created_at AS createdAt, status
           FROM graph_snapshots WHERE status = 'ready'
           ORDER BY snapshot_id DESC LIMIT 1`,
        )
        .get() as { snapshotId: number; createdAt: string; status: string } | undefined
      if (fallbackRow) {
        snapshotRef = {
          snapshotId: fallbackRow.snapshotId,
          createdAt: fallbackRow.createdAt,
          status: "ready" as const,
        }
      }
    }
    if (!snapshotRef) {
      console.error(`No ready snapshot found for ${workspace} in ${dbPath}.`)
      process.exit(1)
    }

    const { snapshotId } = snapshotRef

    // ── Action plan mode ───────────────────────────────────────────────────
    if (actionPlan) {
      const planResult = await lookup.lookup({
        intent: "generate_action_plan",
        snapshotId,
        limit,
      })
      if (format === "json") {
        console.log(JSON.stringify({ workspace, snapshot_id: snapshotId, action_plan: planResult.rows }, null, 2))
      } else if (format === "markdown") {
        const lines = [
          `# Action Plan — ${workspace}`,
          ``,
          `_Snapshot #${snapshotId} · ${planResult.rows.length} items_`,
          ``,
          "| # | P | category | action | target | detail |",
          "|---:|:---:|---|---|---|---|",
        ]
        for (const r of planResult.rows) {
          const row = r as Record<string, unknown>
          lines.push(
            `| ${row.rank} | ${row.priority} | ${row.category} | ${row.action} | \`${String(row.target).split("#").pop()}\` | ${row.detail} |`,
          )
        }
        console.log(lines.join("\n"))
      } else {
        const sep = "─".repeat(60)
        console.log(`${sep}\nAction Plan: ${workspace}  (snapshot #${snapshotId})\n${sep}`)
        for (const r of planResult.rows) {
          const row = r as Record<string, unknown>
          const pIcon = ["", "🔴", "🟠", "🟡", "🔵"][Number(row.priority)] ?? "•"
          console.log(`\n${pIcon}  [${row.rank}] ${row.category} — ${row.action}`)
          console.log(`    ${row.target}`)
          console.log(`    ${row.detail}`)
        }
        console.log(`\n${sep}`)
      }
      return
    }

    // ── Compare mode ───────────────────────────────────────────────────────
    if (compareWith !== null) {
      const [diffResult, moduleDiff] = await Promise.all([
        lookup.lookup({ intent: "compare_snapshots", snapshotId, depth: compareWith }),
        lookup.lookup({ intent: "compare_snapshots_modules", snapshotId, depth: compareWith, limit }),
      ])
      if (format === "json") {
        console.log(
          JSON.stringify(
            {
              workspace,
              current: snapshotId,
              previous: compareWith,
              diff: diffResult.rows,
              module_changes: moduleDiff.rows,
            },
            null,
            2,
          ),
        )
      } else if (format === "markdown") {
        const lines = [
          `# Snapshot Diff — ${workspace}`,
          ``,
          `_#${compareWith} → #${snapshotId}_`,
          ``,
          "## Health Metrics",
          ``,
          "| metric | prev | current | delta | trend |",
          "|---|---:|---:|---:|:---:|",
        ]
        for (const r of diffResult.rows) {
          const row = r as Record<string, unknown>
          const trendIcon: Record<string, string> = { improved: "✅", regressed: "❌", unchanged: "➖", new: "🆕" }
          lines.push(
            `| ${row.metric} | ${row.previous ?? "—"} | ${row.current} | ${row.delta != null ? (Number(row.delta) > 0 ? `+${row.delta}` : String(row.delta)) : "—"} | ${trendIcon[String(row.trend)] ?? "?"} |`,
          )
        }
        if (moduleDiff.rows.length > 0) {
          lines.push("", "## Module Changes", "")
          lines.push("| change | delta | curr symbols | prev symbols | module |")
          lines.push("|:---:|---:|---:|---:|---|")
          for (const r of moduleDiff.rows) {
            const row = r as Record<string, unknown>
            const changeIcon: Record<string, string> = { added: "🟢", removed: "🔴", grown: "📈", shrunk: "📉" }
            const delta =
              row.delta_symbols != null
                ? Number(row.delta_symbols) > 0
                  ? `+${row.delta_symbols}`
                  : String(row.delta_symbols)
                : "—"
            lines.push(
              `| ${changeIcon[String(row.change)] ?? ""} ${row.change} | ${delta} | ${row.current_symbols ?? "—"} | ${row.prev_symbols ?? "—"} | \`${row.canonical_name}\` |`,
            )
          }
        }
        console.log(lines.join("\n"))
      } else {
        const sep = "─".repeat(60)
        console.log(`${sep}\nSnapshot Diff: #${compareWith} → #${snapshotId}  (${workspace})\n${sep}`)
        for (const r of diffResult.rows) {
          const row = r as Record<string, unknown>
          const trendIcon: Record<string, string> = { improved: "✅", regressed: "❌", unchanged: "➖", new: "🆕" }
          const delta = row.delta != null ? ` (${Number(row.delta) > 0 ? "+" : ""}${row.delta})` : ""
          console.log(
            `  ${String(row.metric).padEnd(20)} ${String(row.previous ?? "—").padStart(8)} → ${String(row.current).padStart(8)}${delta}  ${trendIcon[String(row.trend)] ?? ""}`,
          )
        }
        if (moduleDiff.rows.length > 0) {
          console.log(`\nModule changes (${moduleDiff.rows.length}):`)
          for (const r of moduleDiff.rows) {
            const row = r as Record<string, unknown>
            const changeIcon: Record<string, string> = { added: "+", removed: "-", grown: "↑", shrunk: "↓" }
            const delta =
              row.delta_symbols != null ? ` Δ${Number(row.delta_symbols) > 0 ? "+" : ""}${row.delta_symbols}` : ""
            console.log(
              `  ${(changeIcon[String(row.change)] ?? " ").padEnd(2)} [${String(row.change).padEnd(9)}]${delta.padEnd(8)}  ${row.canonical_name}`,
            )
          }
        }
        console.log(sep)
      }
      return
    }

    // ── Collect results by section ─────────────────────────────────────────

    const wantAll = focus === "all"
    const wantDead = wantAll || focus === "dead_code"
    const wantGod = wantAll || focus === "god_classes"
    const wantRef = wantAll || focus === "refactors"
    const wantMods = wantAll || focus === "modules"
    const wantHealth = wantAll || focus === "health"

    const [health, problematic, godClasses, typeHealth, deadCode, refactors, healthReport] = await Promise.all([
      wantHealth
        ? lookup.lookup({ intent: "find_workspace_health", snapshotId })
        : Promise.resolve({ rows: [] as Array<Record<string, unknown>> }),
      wantMods
        ? lookup.lookup({ intent: "analyze_problematic_modules", snapshotId, limit })
        : Promise.resolve({ rows: [] as Array<Record<string, unknown>> }),
      wantGod
        ? lookup.lookup({ intent: "analyze_god_classes", snapshotId, limit })
        : Promise.resolve({ rows: [] as Array<Record<string, unknown>> }),
      wantGod
        ? lookup.lookup({ intent: "analyze_type_health", snapshotId, limit })
        : Promise.resolve({ rows: [] as Array<Record<string, unknown>> }),
      wantDead
        ? lookup.lookup({ intent: "analyze_dead_code", snapshotId, limit })
        : Promise.resolve({ rows: [] as Array<Record<string, unknown>> }),
      wantRef
        ? lookup.lookup({ intent: "suggest_refactors", snapshotId, limit })
        : Promise.resolve({ rows: [] as Array<Record<string, unknown>> }),
      wantHealth
        ? lookup.lookup({ intent: "generate_health_report", snapshotId, limit: 15 })
        : Promise.resolve({ rows: [] as Array<Record<string, unknown>> }),
    ])

    // ── Output ─────────────────────────────────────────────────────────────

    if (format === "json") {
      console.log(
        JSON.stringify(
          {
            workspace,
            snapshot_id: snapshotId,
            workspace_health: health.rows[0] ?? null,
            problematic_modules: problematic.rows,
            god_classes: godClasses.rows,
            type_health: typeHealth.rows,
            dead_code: deadCode.rows,
            refactor_suggestions: refactors.rows,
            module_health_report: healthReport.rows,
          },
          null,
          2,
        ),
      )
      return
    }

    if (format === "markdown") {
      const lines: string[] = [`# Analysis Report — ${workspace}`, ``, `_Snapshot #${snapshotId}_`, ``]

      if (health.rows[0]) {
        const h = health.rows[0] as Record<string, unknown>
        lines.push("## Workspace Health")
        lines.push("")
        lines.push(`| Metric | Value |`)
        lines.push(`|---|---:|`)
        lines.push(`| Health Score | **${h.health_score}** |`)
        lines.push(`| Modules | ${h.modules_count} |`)
        lines.push(`| Classes/Interfaces | ${h.classes_count} |`)
        lines.push(`| Types | ${h.types_count} |`)
        lines.push(`| APIs | ${h.apis_count} |`)
        lines.push(`| Dead Exports | ${h.dead_exports} |`)
        lines.push(`| Unused Fields | ${h.unused_fields} |`)
        lines.push("")
      }

      if (problematic.rows.length > 0) {
        lines.push("## Problematic Modules")
        lines.push("")
        lines.push(
          mdTable(
            ["score", "dead", "imports", "module"],
            problematic.rows.map((r) => [
              str(r.problem_score),
              num(r.dead_exports),
              num(r.outgoing_imports),
              `\`${str(r.canonical_name)}\``,
            ]),
          ),
        )
        lines.push("")
      }

      if (godClasses.rows.length > 0) {
        lines.push("## God Class Candidates")
        lines.push("")
        lines.push(
          mdTable(
            ["score", "methods", "fields", "recommendation", "class"],
            godClasses.rows.map((r) => [
              str(r.complexity_score),
              num(r.method_count),
              num(r.field_count),
              str(r.recommendation),
              `\`${str(r.canonical_name)}\``,
            ]),
          ),
        )
        lines.push("")
      }

      if (deadCode.rows.length > 0) {
        lines.push(`## Dead Code (${deadCode.rows.length} items)`)
        lines.push("")
        lines.push(
          mdTable(
            ["kind", "reason", "action", "symbol"],
            deadCode.rows.map((r) => [str(r.kind), str(r.dead_reason), str(r.action), `\`${str(r.canonical_name)}\``]),
          ),
        )
        lines.push("")
      }

      if (refactors.rows.length > 0) {
        lines.push("## Refactor Suggestions")
        lines.push("")
        lines.push(
          mdTable(
            ["edges", "source", "→", "target"],
            refactors.rows.map((r) => [num(r.coupling_count), `\`${str(r.source)}\``, "→", `\`${str(r.target)}\``]),
          ),
        )
        lines.push("")
      }

      if (healthReport.rows.length > 0) {
        lines.push("## Module Health Report (worst first)")
        lines.push("")
        lines.push(
          mdTable(
            ["score", "apis", "dead", "ratio", "module"],
            healthReport.rows.map((r) => [
              str(r.module_health_score),
              num(r.api_count),
              num(r.dead_api_count),
              str(r.dead_api_ratio),
              `\`${str(r.canonical_name)}\``,
            ]),
          ),
        )
        lines.push("")
      }

      console.log(lines.join("\n"))
      return
    }

    // ── Text output ─────────────────────────────────────────────────────────
    const sep = "─".repeat(60)
    console.log(sep)
    console.log(`Analysis: ${workspace}  (snapshot #${snapshotId})`)
    console.log(sep)

    if (health.rows[0]) {
      const h = health.rows[0] as Record<string, unknown>
      console.log(`\nWorkspace Health Score: ${h.health_score}/100`)
      console.log(
        `  Modules: ${h.modules_count}  Classes: ${h.classes_count}  Types: ${h.types_count}  APIs: ${h.apis_count}`,
      )
      console.log(`  Call edges: ${h.call_edges}  Import edges: ${h.import_edges}`)
      console.log(`  Dead exports: ${h.dead_exports}  Unused fields: ${h.unused_fields}`)
    }

    if (problematic.rows.length > 0) {
      console.log(
        textSection("Problematic modules", problematic.rows, [
          "canonical_name",
          "problem_score",
          "dead_exports",
          "outgoing_imports",
        ]),
      )
    }

    if (godClasses.rows.length > 0) {
      console.log(
        textSection("God class candidates", godClasses.rows, [
          "canonical_name",
          "complexity_score",
          "method_count",
          "field_count",
          "recommendation",
        ]),
      )
    }

    if (typeHealth.rows.length > 0) {
      const badTypes = typeHealth.rows.filter((r) => (r as { health_status?: string }).health_status !== "healthy")
      if (badTypes.length > 0) {
        console.log(
          textSection("Type health issues (unused / hotspot)", badTypes, [
            "canonical_name",
            "health_status",
            "consumers",
            "field_touches",
          ]),
        )
      }
    }

    if (deadCode.rows.length > 0) {
      console.log(textSection("Dead code", deadCode.rows, ["canonical_name", "kind", "dead_reason", "action"]))
    }

    if (refactors.rows.length > 0) {
      console.log(textSection("Refactor suggestions", refactors.rows, ["source", "target", "coupling_count"]))
    }

    if (healthReport.rows.length > 0) {
      console.log(
        textSection("Module health report (worst first)", healthReport.rows, [
          "canonical_name",
          "module_health_score",
          "api_count",
          "dead_api_count",
          "outgoing_imports",
        ]),
      )
    }

    console.log(`\n${sep}`)
  } finally {
    client.close()
  }
}

// ── Entry point: run once, or watch for DB changes ─────────────────────────

async function entryPoint() {
  const { workspace, watch } = parseArgs(process.argv)

  if (!watch) {
    await main()
    return
  }

  // Locate the DB before starting the watch loop
  const watchDbPath = (() => {
    const paths = [join(workspace, ".intelgraph", "intelligence.db"), join(workspace, ".intelgraph", "intelligence.db")]
    return paths.find(existsSync) ?? null
  })()

  if (!watchDbPath) {
    console.error(`No persisted snapshot found in ${workspace}. Run extraction first.`)
    process.exit(1)
  }

  // Run immediately
  await main().catch((err) => {
    console.error("analyze: error:", err instanceof Error ? err.message : String(err))
  })

  console.error(`\n[watch] Watching ${watchDbPath} for changes. Ctrl-C to stop.\n`)

  let lastMtime = 0
  try {
    lastMtime = statSync(watchDbPath).mtimeMs
  } catch {
    /* ignore */
  }

  let running = false
  const interval = setInterval(async () => {
    try {
      const mtime = statSync(watchDbPath).mtimeMs
      if (mtime === lastMtime || running) return
      lastMtime = mtime
      running = true
      const ts = new Date().toISOString().slice(11, 19)
      console.error(`\n[watch ${ts}] DB changed — re-running…\n`)
      try {
        await main()
      } catch (err) {
        console.error("analyze error:", err instanceof Error ? err.message : String(err))
      } finally {
        running = false
      }
    } catch {
      /* DB locked mid-write — retry next tick */
    }
  }, 750)

  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => {
      clearInterval(interval)
      console.error("\n[watch] Stopped.")
      resolve()
    })
  })
}

entryPoint().catch((err) => {
  console.error("analyze: error:", err instanceof Error ? err.message : String(err))
  process.exit(1)
})
