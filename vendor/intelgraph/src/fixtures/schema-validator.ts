/**
 * WLAN fixture schema validator.
 *
 * Validates fixture objects against the frozen schema contract:
 *   - Cross-family required fields (kind, kind_verbose, canonical_name, aliases, source, relations, description)
 *   - 9 required relation buckets (all must be arrays)
 *   - Family-specific non-empty bucket rules
 *   - Optional contract field type checks
 *
 * Source of truth: doc/project/data/schema/wlan-fixture-schema#Frozen schema and contract model
 */

import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { readdirSync } from "node:fs"

// ── Types ─────────────────────────────────────────────────────────────────────

export type ValidationError = {
  field: string
  message: string
  severity: "error" | "warning"
}

export type ValidationResult = {
  valid: boolean
  errors: ValidationError[]
  warnings: ValidationError[]
}

// ── Constants ─────────────────────────────────────────────────────────────────

const VALID_KINDS = new Set([
  "api",
  "struct",
  "ring",
  "hw_block",
  "thread",
  "signal",
  "interrupt",
  "timer",
  "dispatch_table",
  "message",
  "log_point",
])

const RELATIONS_REQUIRED_BUCKETS = [
  "calls_in_direct",
  "calls_in_runtime",
  "calls_out",
  "registrations_in",
  "registrations_out",
  "structures",
  "logs",
  "owns",
  "uses",
] as const

/**
 * Family-specific: at least one of these buckets must be non-empty.
 * Mirrors FAMILY_MIN_NONEMPTY in entity-contract.test.ts.
 */
const FAMILY_MIN_NONEMPTY: Record<string, string[]> = {
  api: ["calls_in_runtime", "calls_in_direct", "registrations_in"],
  struct: ["structures"],
  ring: ["registrations_out", "uses"],
  hw_block: ["registrations_out", "uses"],
  thread: ["calls_in_runtime", "calls_out"],
  signal: ["calls_in_runtime"],
  interrupt: ["calls_out", "registrations_out"],
  timer: ["calls_out", "registrations_out"],
  dispatch_table: ["calls_out"],
  message: ["calls_in_runtime", "calls_out"],
  log_point: ["logs"],
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function err(field: string, message: string): ValidationError {
  return { field, message, severity: "error" }
}

function warn(field: string, message: string): ValidationError {
  return { field, message, severity: "warning" }
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0
}

// ── Core validator ────────────────────────────────────────────────────────────

/**
 * Validate a fixture object against the frozen schema contract.
 * Accepts `unknown` so callers can pass raw JSON.parse output.
 */
export function validateFixture(fixture: unknown): ValidationResult {
  const errors: ValidationError[] = []
  const warnings: ValidationError[] = []

  if (fixture === null || typeof fixture !== "object" || Array.isArray(fixture)) {
    errors.push(err("(root)", "fixture must be a non-null object"))
    return { valid: false, errors, warnings }
  }

  const f = fixture as Record<string, unknown>

  // ── kind ──────────────────────────────────────────────────────────────────
  if (!("kind" in f)) {
    errors.push(err("kind", "required field 'kind' is missing"))
  } else if (!isNonEmptyString(f.kind)) {
    errors.push(err("kind", "field 'kind' must be a non-empty string"))
  } else if (!VALID_KINDS.has(f.kind)) {
    errors.push(err("kind", `field 'kind' must be one of: ${[...VALID_KINDS].join(", ")}; got '${f.kind}'`))
  }

  // ── kind_verbose ──────────────────────────────────────────────────────────
  if (!("kind_verbose" in f)) {
    errors.push(err("kind_verbose", "required field 'kind_verbose' is missing"))
  } else if (!isNonEmptyString(f.kind_verbose)) {
    errors.push(err("kind_verbose", "field 'kind_verbose' must be a non-empty string"))
  }

  // ── canonical_name ────────────────────────────────────────────────────────
  if (!("canonical_name" in f)) {
    errors.push(err("canonical_name", "required field 'canonical_name' is missing"))
  } else if (!isNonEmptyString(f.canonical_name)) {
    errors.push(err("canonical_name", "field 'canonical_name' must be a non-empty string"))
  }

  // ── aliases ───────────────────────────────────────────────────────────────
  if (!("aliases" in f)) {
    errors.push(err("aliases", "required field 'aliases' is missing"))
  } else if (!Array.isArray(f.aliases)) {
    errors.push(err("aliases", "field 'aliases' must be an array"))
  }

  // ── source ────────────────────────────────────────────────────────────────
  if (!("source" in f)) {
    errors.push(err("source", "required field 'source' is missing"))
  } else if (f.source === null || typeof f.source !== "object" || Array.isArray(f.source)) {
    errors.push(err("source", "field 'source' must be an object"))
  } else {
    const src = f.source as Record<string, unknown>
    if (!isNonEmptyString(src.file)) {
      errors.push(err("source.file", "field 'source.file' must be a non-empty string"))
    }
    if (!isPositiveInt(src.line)) {
      errors.push(err("source.line", "field 'source.line' must be a positive integer"))
    }
  }

  // ── description ───────────────────────────────────────────────────────────
  if (!("description" in f)) {
    errors.push(err("description", "required field 'description' is missing"))
  } else if (!isNonEmptyString(f.description)) {
    errors.push(err("description", "field 'description' must be a non-empty string"))
  } else if ((f.description as string).length < 10) {
    warnings.push(warn("description", "field 'description' is very short (recommend 50-200 chars)"))
  }

  // ── relations ─────────────────────────────────────────────────────────────
  if (!("relations" in f)) {
    errors.push(err("relations", "required field 'relations' is missing"))
  } else if (f.relations === null || typeof f.relations !== "object" || Array.isArray(f.relations)) {
    errors.push(err("relations", "field 'relations' must be an object"))
  } else {
    const rel = f.relations as Record<string, unknown>
    for (const bucket of RELATIONS_REQUIRED_BUCKETS) {
      if (!(bucket in rel)) {
        errors.push(err(`relations.${bucket}`, `required relation bucket '${bucket}' is missing`))
      } else if (!Array.isArray(rel[bucket])) {
        errors.push(err(`relations.${bucket}`, `relation bucket '${bucket}' must be an array`))
      }
    }

    // Family-specific non-empty bucket rule
    const kind = typeof f.kind === "string" ? f.kind : null
    if (kind && FAMILY_MIN_NONEMPTY[kind]) {
      const required = FAMILY_MIN_NONEMPTY[kind]
      const hasAny = required.some((bucket) => {
        const arr = rel[bucket]
        return Array.isArray(arr) && arr.length > 0
      })
      if (!hasAny) {
        errors.push(
          err(
            `relations[${required.join("|")}]`,
            `family '${kind}' requires at least one non-empty bucket from: [${required.join(", ")}]`,
          ),
        )
      }
    }
  }

  // ── contract (optional) ───────────────────────────────────────────────────
  if ("contract" in f && f.contract !== undefined && f.contract !== null) {
    if (typeof f.contract !== "object" || Array.isArray(f.contract)) {
      errors.push(err("contract", "field 'contract' must be an object if present"))
    } else {
      const c = f.contract as Record<string, unknown>
      if ("required_relation_kinds" in c && !Array.isArray(c.required_relation_kinds)) {
        errors.push(err("contract.required_relation_kinds", "must be an array if present"))
      }
      if ("required_directions" in c && !Array.isArray(c.required_directions)) {
        errors.push(err("contract.required_directions", "must be an array if present"))
      }
      if ("minimum_counts" in c && (typeof c.minimum_counts !== "object" || Array.isArray(c.minimum_counts) || c.minimum_counts === null)) {
        errors.push(err("contract.minimum_counts", "must be an object if present"))
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  }
}

/**
 * Load and validate a single fixture file from disk.
 */
export async function validateFixtureFile(filePath: string): Promise<ValidationResult> {
  let raw: string
  try {
    raw = await readFile(filePath, "utf8")
  } catch (e) {
    return {
      valid: false,
      errors: [err("(file)", `cannot read file '${filePath}': ${(e as Error).message}`)],
      warnings: [],
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return {
      valid: false,
      errors: [err("(json)", `invalid JSON in '${filePath}': ${(e as Error).message}`)],
      warnings: [],
    }
  }

  return validateFixture(parsed)
}

/**
 * Validate all *.json fixture files in a directory (non-recursive, top-level only).
 * For corpus validation, pass the family subdirectory.
 */
export async function validateCorpus(
  fixtureDir: string,
): Promise<{ results: Map<string, ValidationResult>; summary: { total: number; valid: number; invalid: number } }> {
  let files: string[]
  try {
    files = readdirSync(fixtureDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => join(fixtureDir, f))
  } catch (e) {
    return {
      results: new Map(),
      summary: { total: 0, valid: 0, invalid: 0 },
    }
  }

  const results = new Map<string, ValidationResult>()
  let valid = 0
  let invalid = 0

  await Promise.all(
    files.map(async (fp) => {
      const result = await validateFixtureFile(fp)
      results.set(fp, result)
      if (result.valid) valid++
      else invalid++
    }),
  )

  return { results, summary: { total: files.length, valid, invalid } }
}
