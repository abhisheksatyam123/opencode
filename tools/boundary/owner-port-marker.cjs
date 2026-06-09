/**
 * Owner-port marker validator + scanner.
 *
 * Implements the 5-check decision flow from
 * doc/project/specification/contract/owner-port-marker-spec.md
 * for dep-cruiser rule `no-shared-without-owner-port` (Test Strategy 3.3).
 *
 * Why a sibling helper, not inline in `.dependency-cruiser.cjs`?
 *   dep-cruiser's `forbidden` rules are declarative path-matchers and cannot
 *   express schema validation natively. We pre-scan candidate dirs at config
 *   load time, build the set of dirs with a *valid* marker, and feed it to
 *   the rule's `pathNot` exception list.
 *
 * Lives under `tools/boundary/` (NOT `src/`) per Test Strategy 3.3 close signal:
 *   "schema validation [...] add a pre-check JS hook [...] sibling helper module
 *    under tools/boundary/ (NOT under src/)".
 *
 * No external deps (pure node). Zod-equivalent validation done by hand.
 *
 * Module catalogue (14 names, source: doc/project/architecture/module-catalogue.md):
 */
"use strict"

const fs = require("node:fs")
const path = require("node:path")

const MODULE_CATALOGUE = Object.freeze([
  "foundation",
  "bus",
  "storage",
  "filesystem",
  "config",
  "provider",
  "permission",
  "notes",
  "process",
  "tool",
  "agent",
  "workflow",
  "surface",
  "init",
])

const BANNED_DIR_PATTERN = /^src\/(shared|utils|common)(\/|$)/
const MARKER_FILENAME = "owner-port.json"

/**
 * Validate a parsed JSON marker object against OwnerPortMarkerSchema.
 * Mirrors the Zod schema in owner-port-marker-spec §"Schema (machine-validatable)".
 *
 * @param {unknown} obj parsed JSON value
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateMarkerSchema(obj) {
  const errors = []
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return { valid: false, errors: ["marker is not a JSON object"] }
  }
  const o = /** @type {Record<string, unknown>} */ (obj)

  // owner_module: string, min 1
  if (typeof o.owner_module !== "string" || o.owner_module.length < 1) {
    errors.push("owner_module: must be non-empty string")
  }

  // port_path: string, must start with "src/"
  if (typeof o.port_path !== "string" || !/^src\//.test(o.port_path)) {
    errors.push("port_path: must be string matching /^src\\//")
  }

  // schema_path: string, must start with "src/"
  if (typeof o.schema_path !== "string" || !/^src\//.test(o.schema_path)) {
    errors.push("schema_path: must be string matching /^src\\//")
  }

  // rationale: string, min 20 chars
  if (typeof o.rationale !== "string" || o.rationale.length < 20) {
    errors.push("rationale: must be string ≥20 chars (forces real justification)")
  }

  // version: optional, must be literal "1" if present
  if ("version" in o && o.version !== "1") {
    errors.push('version: optional but if present must equal "1"')
  }

  // expires: optional ISO-8601 datetime
  if ("expires" in o) {
    if (typeof o.expires !== "string" || Number.isNaN(Date.parse(o.expires))) {
      errors.push("expires: optional but if present must be ISO-8601 datetime")
    }
  }

  // contract_tests: optional, array of strings, each /^(test|src)\//
  if ("contract_tests" in o) {
    if (!Array.isArray(o.contract_tests)) {
      errors.push("contract_tests: optional but if present must be array")
    } else {
      for (const p of o.contract_tests) {
        if (typeof p !== "string" || !/^(test|src)\//.test(p)) {
          errors.push("contract_tests: each entry must match /^(test|src)\\//")
          break
        }
      }
    }
  }

  return { valid: errors.length === 0, errors }
}

/**
 * Run the 5-check decision flow on a candidate directory.
 *
 * CHECK 1: marker file exists
 * CHECK 2: schema-valid JSON
 * CHECK 3: owner_module ∈ module-catalogue whitelist
 * CHECK 4: port_path & schema_path resolve to existing files (relative to repoRoot)
 * CHECK 5: at least one file in <D>/** string-matches a symbol declared in port_path
 *          (heuristic per spec; AST-anchor approximated by `port-symbol` substring scan)
 *
 * @param {string} candidateDirAbs absolute path to candidate dir (e.g. /repo/src/shared/foo)
 * @param {string} repoRootAbs absolute path to repo root (for resolving port_path)
 * @returns {{ valid: boolean, check: 1|2|3|4|5|null, error: string|null, marker: object|null }}
 */
function validateOwnerPortMarker(candidateDirAbs, repoRootAbs) {
  const markerPath = path.join(candidateDirAbs, MARKER_FILENAME)
  const relDir = path.relative(repoRootAbs, candidateDirAbs).replace(/\\/g, "/")

  // CHECK 1
  if (!fs.existsSync(markerPath) || !fs.statSync(markerPath).isFile()) {
    return {
      valid: false,
      check: 1,
      error: `Forbidden shared dir ${relDir}; add owner-port.json marker per owner-port-marker-spec or relocate code into owning module.`,
      marker: null,
    }
  }

  // CHECK 2
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(markerPath, "utf8"))
  } catch (e) {
    return {
      valid: false,
      check: 2,
      error: `Invalid owner-port.json at ${relDir}: not valid JSON (${(e && e.message) || e})`,
      marker: null,
    }
  }
  const schemaResult = validateMarkerSchema(parsed)
  if (!schemaResult.valid) {
    return {
      valid: false,
      check: 2,
      error: `Invalid owner-port.json at ${relDir}: ${schemaResult.errors.join("; ")}`,
      marker: null,
    }
  }

  const marker = /** @type {Record<string, unknown>} */ (parsed)

  // CHECK 3
  if (!MODULE_CATALOGUE.includes(/** @type {string} */ (marker.owner_module))) {
    return {
      valid: false,
      check: 3,
      error: `owner_module=${marker.owner_module} not in module-catalogue (${MODULE_CATALOGUE.join(", ")})`,
      marker,
    }
  }

  // CHECK 4
  const portAbs = path.join(repoRootAbs, /** @type {string} */ (marker.port_path))
  const schemaAbs = path.join(repoRootAbs, /** @type {string} */ (marker.schema_path))
  if (!fs.existsSync(portAbs) || !fs.existsSync(schemaAbs)) {
    return {
      valid: false,
      check: 4,
      error: `owner-port.json at ${relDir} references missing port_path or schema_path (${marker.port_path} / ${marker.schema_path})`,
      marker,
    }
  }

  // CHECK 5: heuristic AST-anchor — any file in <D>/** must reference a top-level
  // export name found in port_path source. Approximation per spec note.
  const portSource = fs.readFileSync(portAbs, "utf8")
  const exportNames = collectExportNames(portSource)
  if (exportNames.length === 0) {
    return {
      valid: false,
      check: 5,
      error: `Shared dir ${relDir}: port_path ${marker.port_path} declares no top-level exports to anchor on`,
      marker,
    }
  }
  const dirFiles = listFilesRecursive(candidateDirAbs).filter(
    (f) => f !== markerPath && /\.(ts|tsx|js|cjs|mjs)$/.test(f),
  )
  let anchorFound = false
  for (const f of dirFiles) {
    const content = fs.readFileSync(f, "utf8")
    if (exportNames.some((n) => new RegExp(`\\b${escapeRe(n)}\\b`).test(content))) {
      anchorFound = true
      break
    }
  }
  if (!anchorFound) {
    return {
      valid: false,
      check: 5,
      error: `Shared dir ${relDir} has owner-port.json but does not anchor on the named port (${marker.port_path}: exports ${exportNames.join(", ")})`,
      marker,
    }
  }

  return { valid: true, check: null, error: null, marker }
}

/**
 * Scan repoRoot for every directory that lies under a banned `src/(shared|utils|common)/...`
 * path AND has a valid owner-port marker. Returns absolute dir paths.
 *
 * Used by `.dependency-cruiser.cjs` to compute the rule's `pathNot` exception
 * list at config load time.
 *
 * @param {string} repoRootAbs
 * @returns {{ exemptedDirsAbs: string[], invalidDirsAbs: Array<{ dir: string, error: string, check: number }> }}
 */
function scanForExemptedDirs(repoRootAbs) {
  const exempted = []
  const invalid = []
  const candidateRoots = ["shared", "utils", "common"]
  for (const sub of candidateRoots) {
    const root = path.join(repoRootAbs, "src", sub)
    if (!fs.existsSync(root)) continue
    // Walk: every directory rooted at or under `src/<sub>/` is a candidate.
    walkDirs(root).forEach((dirAbs) => {
      const result = validateOwnerPortMarker(dirAbs, repoRootAbs)
      if (result.valid) exempted.push(dirAbs)
      else if (result.check !== 1) {
        // Only report dirs that *attempted* a marker (check 2-5 failures).
        // Pure check-1 failures are the default-deny case, no need to surface.
        invalid.push({ dir: dirAbs, error: result.error || "", check: result.check || 0 })
      }
    })
  }
  return { exemptedDirsAbs: exempted, invalidDirsAbs: invalid }
}

// ---------- helpers ----------

function listFilesRecursive(dirAbs) {
  /** @type {string[]} */
  const out = []
  const stack = [dirAbs]
  while (stack.length) {
    const cur = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const p = path.join(cur, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.isFile()) out.push(p)
    }
  }
  return out
}

function walkDirs(rootAbs) {
  /** @type {string[]} */
  const out = []
  const stack = [rootAbs]
  while (stack.length) {
    const cur = stack.pop()
    out.push(cur)
    let entries
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.isDirectory()) stack.push(path.join(cur, e.name))
    }
  }
  return out
}

/**
 * Crude top-level export-name extractor. Picks up:
 *   export const X = ...
 *   export function X(...)
 *   export class X ...
 *   export interface X ...
 *   export type X = ...
 *   export { X, Y as Z }
 *   export default function X
 * Sufficient for the heuristic AST-anchor in CHECK 5.
 */
function collectExportNames(source) {
  /** @type {Set<string>} */
  const names = new Set()
  const patterns = [
    /\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    /\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /\bexport\s+class\s+([A-Za-z_$][\w$]*)/g,
    /\bexport\s+interface\s+([A-Za-z_$][\w$]*)/g,
    /\bexport\s+type\s+([A-Za-z_$][\w$]*)/g,
    /\bexport\s+enum\s+([A-Za-z_$][\w$]*)/g,
  ]
  for (const re of patterns) {
    let m
    while ((m = re.exec(source))) names.add(m[1])
  }
  // export { A, B as C }
  const blockRe = /\bexport\s*\{([^}]+)\}/g
  let bm
  while ((bm = blockRe.exec(source))) {
    bm[1]
      .split(",")
      .map((s) => s.trim())
      .forEach((entry) => {
        if (!entry) return
        const asMatch = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(entry)
        if (asMatch) names.add(asMatch[1])
        else {
          const m2 = /^([A-Za-z_$][\w$]*)/.exec(entry)
          if (m2) names.add(m2[1])
        }
      })
  }
  return [...names]
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

module.exports = {
  MODULE_CATALOGUE,
  BANNED_DIR_PATTERN,
  MARKER_FILENAME,
  validateMarkerSchema,
  validateOwnerPortMarker,
  scanForExemptedDirs,
  // exported for tests
  _internal: { collectExportNames, listFilesRecursive, walkDirs },
}
