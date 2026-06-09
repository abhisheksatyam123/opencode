#!/usr/bin/env node

import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { spawnSync } from "node:child_process"

function parseArgs(argv) {
  const options = {
    sourceRoot:
      process.env.WLAN_SOURCE_ROOT ||
      "/local/mnt/workspace/code1/WLAN.CNG.1.0-01880.3-QCACNGSWPL_V1_V2_SILICON-1/wlan_proc",
    fixturesRoot: "test/fixtures/wlan",
    indexPath: "test/fixtures/wlan/index.json",
    reportJson: "test/fixtures/wlan/wlan-gap-audit-report.json",
    reportMd: "test/fixtures/wlan/wlan-gap-audit-report.md",
  }

  for (const arg of argv) {
    if (arg.startsWith("--source-root=")) {
      options.sourceRoot = arg.slice("--source-root=".length)
    } else if (arg.startsWith("--fixtures-root=")) {
      options.fixturesRoot = arg.slice("--fixtures-root=".length)
    } else if (arg.startsWith("--index=")) {
      options.indexPath = arg.slice("--index=".length)
    } else if (arg.startsWith("--report-json=")) {
      options.reportJson = arg.slice("--report-json=".length)
    } else if (arg.startsWith("--report-md=")) {
      options.reportMd = arg.slice("--report-md=".length)
    }
  }

  return options
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function isAllUpperOrUnderscore(value) {
  return /^[A-Z0-9_]+$/.test(value)
}

function toCaseVariants(symbol) {
  const variants = new Set([symbol])

  if (symbol.length > 0) {
    variants.add(symbol[0].toLowerCase() + symbol.slice(1))
    variants.add(symbol[0].toUpperCase() + symbol.slice(1))
  }

  const lower = symbol.toLowerCase()
  const upper = symbol.toUpperCase()
  if (symbol !== lower && !isAllUpperOrUnderscore(symbol)) variants.add(lower)
  if (symbol !== upper && !isAllUpperOrUnderscore(symbol)) variants.add(upper)

  return variants
}

function buildSymbolAliases(symbol) {
  const aliases = new Set()
  const trimmed = (symbol || "").trim()
  if (!trimmed) return []

  const addWithCase = (name) => {
    for (const variant of toCaseVariants(name)) {
      aliases.add(variant)
    }
  }

  addWithCase(trimmed)

  const noUnderscore = trimmed.startsWith("_") ? trimmed.slice(1) : trimmed
  const withUnderscore = trimmed.startsWith("_") ? trimmed : `_${trimmed}`

  addWithCase(noUnderscore)
  addWithCase(withUnderscore)

  const baseNames = new Set([trimmed, noUnderscore, withUnderscore])
  for (const base of baseNames) {
    if (!base) continue
    addWithCase(`${base}___RAM`)
    addWithCase(`___RAM${base}`)
  }

  return [...aliases].filter(Boolean)
}

function rgExists({ symbol, sourceRoot }) {
  const regex = `\\b${escapeRegex(symbol)}\\b`
  const result = spawnSync(
    "rg",
    [
      "-n",
      "-m",
      "1",
      "-e",
      regex,
      sourceRoot,
      "-g",
      "*.c",
      "-g",
      "*.h",
      "-g",
      "*.cpp",
      "-g",
      "*.hpp",
    ],
    { encoding: "utf-8" },
  )
  return result.status === 0
}

function gatherSymbols(relations, field, key) {
  const arr = Array.isArray(relations?.[field]) ? relations[field] : []
  return arr
    .map((entry) => (entry && typeof entry === "object" ? entry[key] : undefined))
    .filter((v) => typeof v === "string" && v.length > 0)
}

function normalizePath(filePath) {
  return filePath.split("\\").join("/")
}

function buildBasenameIndex(sourceRoot) {
  const result = spawnSync(
    "rg",
    ["--files", sourceRoot, "-g", "*.c", "-g", "*.h", "-g", "*.cpp", "-g", "*.hpp"],
    { encoding: "utf-8", maxBuffer: 1024 * 1024 * 128 },
  )

  if (result.status !== 0) {
    throw new Error(`Failed to list source files with rg: ${result.stderr || "unknown error"}`)
  }

  const index = new Map()
  for (const line of result.stdout.split("\n")) {
    const file = line.trim()
    if (!file) continue
    const base = path.basename(file)
    const list = index.get(base) || []
    list.push(normalizePath(file))
    index.set(base, list)
  }
  return index
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))

  const indexRaw = await fsp.readFile(opts.indexPath, "utf-8")
  const manifest = JSON.parse(indexRaw)
  const apis = Array.isArray(manifest?.families?.api) ? manifest.families.api : []

  const basenameIndex = buildBasenameIndex(opts.sourceRoot)
  const symbolCache = new Map()

  const symbolExists = (symbol) => {
    if (symbolCache.has(symbol)) return symbolCache.get(symbol)

    const aliases = buildSymbolAliases(symbol)
    for (const alias of aliases) {
      const cacheKey = `alias:${alias}`
      let found
      if (symbolCache.has(cacheKey)) {
        found = symbolCache.get(cacheKey)
      } else {
        found = rgExists({ symbol: alias, sourceRoot: opts.sourceRoot })
        symbolCache.set(cacheKey, found)
      }

      if (found) {
        const result = { found: true, matched_symbol: alias }
        symbolCache.set(symbol, result)
        return result
      }
    }

    const result = { found: false, matched_symbol: null }
    symbolCache.set(symbol, result)
    return result
  }

  const getFnPtrRegistrationAliasSet = (relations) => {
    const aliases = new Set()
    const registrationFields = ["registrations_in", "registrations_out"]

    for (const field of registrationFields) {
      const entries = Array.isArray(relations?.[field]) ? relations[field] : []
      for (const entry of entries) {
        if (!entry || typeof entry !== "object") continue
        const evidenceKind = entry?.evidence?.kind
        if (typeof evidenceKind !== "string" || !evidenceKind.includes("fn_ptr")) continue

        for (const key of ["registrar", "callback"]) {
          const name = entry[key]
          if (typeof name !== "string" || !name.trim()) continue
          for (const alias of buildSymbolAliases(name)) aliases.add(alias)
        }
      }
    }

    return aliases
  }

  const collectMissingSymbols = ({ symbols, fnPtrRegistrationAliases }) => {
    const missing = []
    for (const symbol of symbols) {
      const result = symbolExists(symbol)
      if (result.found) continue

      const hasFnPtrAlias = buildSymbolAliases(symbol).some((alias) => fnPtrRegistrationAliases.has(alias))
      if (hasFnPtrAlias) continue

      missing.push(symbol)
    }
    return missing
  }

  const issueClassCounts = {}
  const fixtures = []
  let okFixtures = 0

  for (const api of apis) {
    const fixtureFile = `${api}.json`
    const fixturePath = path.join(opts.fixturesRoot, "api", fixtureFile)

    if (!fs.existsSync(fixturePath)) {
      issueClassCounts.fixture_file_missing = (issueClassCounts.fixture_file_missing || 0) + 1
      fixtures.push({
        fixture: fixtureFile,
        api,
        api_found: false,
        callers_missing: [],
        callees_missing: [],
        registrars_missing: [],
        source_path: null,
        source_path_exact: false,
        source_path_alternatives: [],
        issue_classes: ["fixture_file_missing"],
      })
      continue
    }

    const fixture = JSON.parse(await fsp.readFile(fixturePath, "utf-8"))
    const relations = fixture?.relations || {}
    const callers = [
      ...gatherSymbols(relations, "calls_in_direct", "caller"),
      ...gatherSymbols(relations, "calls_in_runtime", "caller"),
    ]
    const callees = gatherSymbols(relations, "calls_out", "callee")
    const registrars = [
      ...gatherSymbols(relations, "registrations_in", "registrar"),
      ...gatherSymbols(relations, "registrations_out", "registrar"),
    ]

    const uniqueCallers = [...new Set(callers)]
    const uniqueCallees = [...new Set(callees)]
    const uniqueRegistrars = [...new Set(registrars)]

    const fnPtrRegistrationAliases = getFnPtrRegistrationAliasSet(relations)

    const callersMissing = collectMissingSymbols({
      symbols: uniqueCallers,
      fnPtrRegistrationAliases,
    })
    const calleesMissing = collectMissingSymbols({
      symbols: uniqueCallees,
      fnPtrRegistrationAliases,
    })
    const registrarsMissing = uniqueRegistrars.filter((s) => !symbolExists(s).found)

    const apiName = typeof fixture?.canonical_name === "string" ? fixture.canonical_name : api
    const aliasSymbol =
      typeof fixture?.ground_truth_metadata?.resolved_alias_symbol === "string"
        ? fixture.ground_truth_metadata.resolved_alias_symbol
        : null
    const apiFound = aliasSymbol
      ? symbolExists(apiName).found || symbolExists(aliasSymbol).found
      : symbolExists(apiName).found

    const sourceFile = typeof fixture?.source?.file === "string" ? fixture.source.file : null
    const sourcePath = sourceFile ? normalizePath(sourceFile) : null
    const sourceAbs = sourcePath ? path.join(opts.sourceRoot, sourcePath) : null
    const sourceExact = sourceAbs ? fs.existsSync(sourceAbs) : false
    let sourceAlternatives = []
    if (!sourceExact && sourcePath) {
      const base = path.basename(sourcePath)
      sourceAlternatives = (basenameIndex.get(base) || []).slice(0, 5)
    }

    const issueClasses = []
    if (!apiFound) issueClasses.push("api_symbol_missing")
    if (callersMissing.length > 0) issueClasses.push("caller_symbol_missing")
    if (calleesMissing.length > 0) issueClasses.push("callee_symbol_missing")
    if (registrarsMissing.length > 0) issueClasses.push("registrar_symbol_missing")
    if (!sourcePath) {
      issueClasses.push("source_path_missing")
    } else if (!sourceExact && sourceAlternatives.length > 0) {
      issueClasses.push("source_path_mismatch")
    } else if (!sourceExact) {
      issueClasses.push("source_path_not_found")
    }

    for (const klass of issueClasses) {
      issueClassCounts[klass] = (issueClassCounts[klass] || 0) + 1
    }

    if (issueClasses.length === 0) okFixtures += 1

    fixtures.push({
      fixture: fixtureFile,
      api: apiName,
      api_found: apiFound,
      callers_missing: callersMissing,
      callees_missing: calleesMissing,
      registrars_missing: registrarsMissing,
      source_path: sourcePath,
      source_path_exact: sourceExact,
      source_path_alternatives: sourceAlternatives,
      issue_classes: issueClasses,
    })
  }

  const totalFixtures = fixtures.length
  const fixturesWithIssues = totalFixtures - okFixtures
  const topIssueClasses = Object.entries(issueClassCounts)
    .map(([issue_class, count]) => ({ issue_class, count }))
    .sort((a, b) => b.count - a.count)

  const rerunCommand = [
    "node scripts/wlan-fixture-gap-audit.mjs",
    `--source-root=${opts.sourceRoot}`,
    `--index=${opts.indexPath}`,
    `--fixtures-root=${opts.fixturesRoot}`,
    `--report-json=${opts.reportJson}`,
    `--report-md=${opts.reportMd}`,
  ].join(" ")

  let previousIssueClassCounts = null
  let issueClassDeltas = null
  if (fs.existsSync(opts.reportJson)) {
    try {
      const previousRaw = await fsp.readFile(opts.reportJson, "utf-8")
      const previous = JSON.parse(previousRaw)
      if (previous && typeof previous === "object" && previous.issue_class_counts) {
        previousIssueClassCounts = previous.issue_class_counts
        const classes = new Set([
          ...Object.keys(previousIssueClassCounts || {}),
          ...Object.keys(issueClassCounts || {}),
        ])
        issueClassDeltas = {}
        for (const klass of classes) {
          const before = previousIssueClassCounts?.[klass] || 0
          const after = issueClassCounts?.[klass] || 0
          issueClassDeltas[klass] = after - before
        }
      }
    } catch {
      // Ignore invalid previous report payloads.
    }
  }

  const report = {
    generated_at: new Date().toISOString(),
    source_root: opts.sourceRoot,
    fixtures_root: opts.fixturesRoot,
    total_fixtures: totalFixtures,
    ok_fixtures: okFixtures,
    fixtures_with_issues: fixturesWithIssues,
    issue_class_counts: issueClassCounts,
    top_issue_classes: topIssueClasses,
    previous_issue_class_counts: previousIssueClassCounts,
    issue_class_deltas: issueClassDeltas,
    rerun_command: rerunCommand,
    fixtures,
  }

  await fsp.writeFile(opts.reportJson, JSON.stringify(report, null, 2), "utf-8")

  const lines = [
    "# WLAN Fixture Gap Audit Report",
    "",
    `Generated: ${report.generated_at}`,
    `Source root: ${report.source_root}`,
    `Fixtures root: ${report.fixtures_root}`,
    "",
    `- Total fixtures: ${totalFixtures}`,
    `- OK fixtures: ${okFixtures}`,
    `- Fixtures with issues: ${fixturesWithIssues}`,
    "",
    "## Top issue classes",
    "",
    "| Issue class | Count |",
    "|---|---:|",
    ...topIssueClasses.map((row) => `| ${row.issue_class} | ${row.count} |`),
    "",
    ...(previousIssueClassCounts && issueClassDeltas
      ? [
          "## Issue class counts (before → after)",
          "",
          "| Issue class | Before | After | Delta |",
          "|---|---:|---:|---:|",
          ...Object.keys({ ...previousIssueClassCounts, ...issueClassCounts })
            .sort()
            .map((klass) => {
              const before = previousIssueClassCounts?.[klass] || 0
              const after = issueClassCounts?.[klass] || 0
              const delta = after - before
              const deltaLabel = delta > 0 ? `+${delta}` : `${delta}`
              return `| ${klass} | ${before} | ${after} | ${deltaLabel} |`
            }),
          "",
        ]
      : []),
    "## Rerun command",
    "",
    "```bash",
    rerunCommand,
    "```",
    "",
  ]

  await fsp.writeFile(opts.reportMd, lines.join("\n"), "utf-8")

  console.log(`✓ Gap audit JSON written: ${opts.reportJson}`)
  console.log(`✓ Gap audit markdown written: ${opts.reportMd}`)
  console.log(`Summary: ${okFixtures}/${totalFixtures} fixtures clean; ${fixturesWithIssues} with issues`)
  console.log("Top issue classes:")
  for (const row of topIssueClasses.slice(0, 10)) {
    console.log(`- ${row.issue_class}: ${row.count}`)
  }
}

main().catch((error) => {
  console.error("wlan-fixture-gap-audit failed:", error)
  process.exit(1)
})
