#!/usr/bin/env node

import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"

function parseBool(value, fallback = false) {
  if (value == null) return fallback
  const v = String(value).trim().toLowerCase()
  if (["1", "true", "yes", "y", "on"].includes(v)) return true
  if (["0", "false", "no", "n", "off"].includes(v)) return false
  return fallback
}

function parseArgs(argv) {
  const opts = {
    fixturesRoot: "test/fixtures/wlan/api",
    reportJson: "test/fixtures/wlan/wlan-gap-audit-report.json",
    write: false,
    map: null,
  }

  for (const arg of argv) {
    if (arg.startsWith("--fixtures-root=")) {
      opts.fixturesRoot = arg.slice("--fixtures-root=".length)
    } else if (arg.startsWith("--report-json=")) {
      opts.reportJson = arg.slice("--report-json=".length)
    } else if (arg.startsWith("--map=")) {
      opts.map = arg.slice("--map=".length)
    } else if (arg.startsWith("--write=")) {
      opts.write = parseBool(arg.slice("--write=".length), false)
    }
  }

  if (!opts.map) throw new Error("Missing required --map=<json> argument")

  let parsedMap
  try {
    parsedMap = JSON.parse(opts.map)
  } catch (error) {
    throw new Error(`Invalid --map JSON: ${error.message}`)
  }
  if (!parsedMap || typeof parsedMap !== "object" || Array.isArray(parsedMap)) {
    throw new Error("--map must be a JSON object")
  }

  opts.mapObject = parsedMap
  return opts
}

function listJsonFiles(fixturesRoot) {
  const entries = fs.readdirSync(fixturesRoot, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(fixturesRoot, entry.name))
    .sort()
}

function applyMapToFixture(fixture, mapObject) {
  const fields = [
    ["calls_in_direct", "caller"],
    ["calls_in_runtime", "caller"],
    ["calls_out", "callee"],
    ["registrations_in", "registrar"],
    ["registrations_in", "callback"],
    ["registrations_out", "registrar"],
    ["registrations_out", "callback"],
  ]

  const changes = []
  const relations = fixture?.relations
  if (!relations || typeof relations !== "object") return changes

  for (const [arrayField, key] of fields) {
    const rows = Array.isArray(relations[arrayField]) ? relations[arrayField] : []
    for (const row of rows) {
      if (!row || typeof row !== "object") continue
      const from = row[key]
      if (typeof from !== "string") continue
      if (!Object.prototype.hasOwnProperty.call(mapObject, from)) continue

      const to = mapObject[from]
      if (typeof to !== "string" || to === from) continue
      row[key] = to
      changes.push({ arrayField, key, from, to })
    }
  }

  return changes
}

function normalizeMissingList(values, mapObject) {
  if (!Array.isArray(values)) return []
  return values.filter((v) => !(typeof v === "string" && Object.prototype.hasOwnProperty.call(mapObject, v)))
}

function buildPredictedAudit(report, mapObject) {
  const beforeIssueCounts = report?.issue_class_counts || {}
  const fixtures = Array.isArray(report?.fixtures) ? report.fixtures : []

  const classes = ["caller_symbol_missing", "callee_symbol_missing", "registrar_symbol_missing"]
  const afterIssueCounts = { ...beforeIssueCounts }

  const beforeOccurrenceCounts = {
    caller_symbol_missing_occurrences: 0,
    callee_symbol_missing_occurrences: 0,
    registrar_symbol_missing_occurrences: 0,
  }

  const afterOccurrenceCounts = {
    caller_symbol_missing_occurrences: 0,
    callee_symbol_missing_occurrences: 0,
    registrar_symbol_missing_occurrences: 0,
  }

  for (const klass of classes) afterIssueCounts[klass] = 0

  for (const fixture of fixtures) {
    const callersBefore = Array.isArray(fixture.callers_missing) ? fixture.callers_missing : []
    const calleesBefore = Array.isArray(fixture.callees_missing) ? fixture.callees_missing : []
    const registrarsBefore = Array.isArray(fixture.registrars_missing) ? fixture.registrars_missing : []

    beforeOccurrenceCounts.caller_symbol_missing_occurrences += callersBefore.length
    beforeOccurrenceCounts.callee_symbol_missing_occurrences += calleesBefore.length
    beforeOccurrenceCounts.registrar_symbol_missing_occurrences += registrarsBefore.length

    const callersAfter = normalizeMissingList(callersBefore, mapObject)
    const calleesAfter = normalizeMissingList(calleesBefore, mapObject)
    const registrarsAfter = normalizeMissingList(registrarsBefore, mapObject)

    afterOccurrenceCounts.caller_symbol_missing_occurrences += callersAfter.length
    afterOccurrenceCounts.callee_symbol_missing_occurrences += calleesAfter.length
    afterOccurrenceCounts.registrar_symbol_missing_occurrences += registrarsAfter.length

    if (callersAfter.length > 0) afterIssueCounts.caller_symbol_missing += 1
    if (calleesAfter.length > 0) afterIssueCounts.callee_symbol_missing += 1
    if (registrarsAfter.length > 0) afterIssueCounts.registrar_symbol_missing += 1
  }

  const predictedDeltas = {}
  for (const klass of classes) {
    predictedDeltas[klass] = (afterIssueCounts[klass] || 0) - (beforeIssueCounts[klass] || 0)
  }

  predictedDeltas.caller_symbol_missing_occurrences =
    afterOccurrenceCounts.caller_symbol_missing_occurrences -
    beforeOccurrenceCounts.caller_symbol_missing_occurrences
  predictedDeltas.callee_symbol_missing_occurrences =
    afterOccurrenceCounts.callee_symbol_missing_occurrences -
    beforeOccurrenceCounts.callee_symbol_missing_occurrences
  predictedDeltas.registrar_symbol_missing_occurrences =
    afterOccurrenceCounts.registrar_symbol_missing_occurrences -
    beforeOccurrenceCounts.registrar_symbol_missing_occurrences

  return {
    before_issue_class_counts: beforeIssueCounts,
    after_issue_class_counts_predicted: afterIssueCounts,
    before_missing_occurrence_counts: beforeOccurrenceCounts,
    after_missing_occurrence_counts_predicted: afterOccurrenceCounts,
    issue_class_deltas_predicted: predictedDeltas,
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const fixtureFiles = listJsonFiles(opts.fixturesRoot)

  let touchedFixtures = 0
  let totalReplacements = 0
  const replacementsByField = {
    caller: 0,
    callee: 0,
    registrar: 0,
    callback: 0,
  }
  const replacementsByPair = new Map()

  for (const filePath of fixtureFiles) {
    const raw = await fsp.readFile(filePath, "utf-8")
    const fixture = JSON.parse(raw)
    const changes = applyMapToFixture(fixture, opts.mapObject)

    if (changes.length > 0) {
      touchedFixtures += 1
      totalReplacements += changes.length
      for (const change of changes) {
        replacementsByField[change.key] += 1
        const pairKey = `${change.from}=>${change.to}`
        replacementsByPair.set(pairKey, (replacementsByPair.get(pairKey) || 0) + 1)
      }

      if (opts.write) {
        await fsp.writeFile(filePath, `${JSON.stringify(fixture, null, 2)}\n`, "utf-8")
      }
    }
  }

  let predictedAudit = {
    before_issue_class_counts: {},
    after_issue_class_counts_predicted: {},
    before_missing_occurrence_counts: {},
    after_missing_occurrence_counts_predicted: {},
    issue_class_deltas_predicted: {},
  }

  if (fs.existsSync(opts.reportJson)) {
    const report = JSON.parse(await fsp.readFile(opts.reportJson, "utf-8"))
    predictedAudit = buildPredictedAudit(report, opts.mapObject)
  }

  const topReplacements = [...replacementsByPair.entries()]
    .map(([pair, count]) => ({ pair, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20)

  const summary = {
    mode: opts.write ? "write" : "dry-run",
    fixtures_root: opts.fixturesRoot,
    report_json: opts.reportJson,
    fixture_count: fixtureFiles.length,
    touched_fixtures: touchedFixtures,
    total_replacements: totalReplacements,
    replacements_by_field: replacementsByField,
    top_replacements: topReplacements,
    ...predictedAudit,
    files_written: opts.write ? touchedFixtures : 0,
  }

  console.log(JSON.stringify(summary, null, 2))
  if (!opts.write) {
    console.error("Dry-run only: no fixture files modified (pass --write=true to apply).")
  }
}

main().catch((error) => {
  console.error("wlan-fixture-normalize-relations failed:", error.message)
  process.exit(1)
})
