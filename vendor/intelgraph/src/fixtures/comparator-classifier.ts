/**
 * Comparator mismatch classifier.
 *
 * Exports the canonical taxonomy rules, types, and classifier function
 * for deterministic mismatch_type/severity/rule_id assignment from diff rows.
 *
 * Six canonical mismatch classes (precedence order):
 *   consistency > missing > source_mismatch > unresolved_alias > extra > evidence_weak
 *
 * CI mapping: S0/S1 → fail; S2 → warn; S3 → advisory/pass
 */

export type MismatchType =
  | "consistency"
  | "missing"
  | "source_mismatch"
  | "unresolved_alias"
  | "extra"
  | "evidence_weak"

export type Severity = "S0" | "S1" | "S2" | "S3"

export type CiOutcome = "fail" | "warn" | "pass"

export type ClassifierRule = {
  mismatch_type: MismatchType
  severity: Severity
  rule_id: string
}

export type DiffRow = {
  field: string
  expected: unknown
  actual: unknown
  mismatch_type: MismatchType
  severity: Severity
  rule_id: string
}

/**
 * Lookup table mapping `${mismatch_type}|${field}` keys to deterministic classifier output.
 * Extensible: add new entries to cover additional taxonomy cases.
 */
export const TAXONOMY_RULES: Record<string, ClassifierRule> = {
  "consistency|status": { mismatch_type: "consistency", severity: "S0", rule_id: "CONSISTENCY_STATUS" },
  "missing|data.items.length": { mismatch_type: "missing", severity: "S0", rule_id: "MISSING_ITEMS" },
  "source_mismatch|kind": { mismatch_type: "source_mismatch", severity: "S1", rule_id: "SOURCE_KIND" },
  "source_mismatch|kind_verbose": { mismatch_type: "source_mismatch", severity: "S1", rule_id: "SOURCE_KIND_VERBOSE" },
  "unresolved_alias|canonical_name": { mismatch_type: "unresolved_alias", severity: "S2", rule_id: "ALIAS_CANONICAL_NAME" },
  "extra|rel.calls_out": { mismatch_type: "extra", severity: "S2", rule_id: "EXTRA_RELATION" },
  "evidence_weak|rel.structures (minimum_count)": { mismatch_type: "evidence_weak", severity: "S3", rule_id: "WEAK_EVIDENCE" },
}

/**
 * Classify a diff row by looking up its `${mismatch_type}|${field}` key in TAXONOMY_RULES.
 * Falls back to a stable generated rule_id when no explicit rule exists.
 */
export function classifyDiffRow(row: { field: string; mismatch_type: string }): ClassifierRule {
  const key = `${row.mismatch_type}|${row.field}`
  const rule = TAXONOMY_RULES[key]
  if (rule) return rule
  const safeField = row.field.split(".").join("_").toUpperCase()
  const safeMismatch = row.mismatch_type.toUpperCase()
  return {
    mismatch_type: row.mismatch_type as MismatchType,
    severity: "S3",
    rule_id: `UNKNOWN_${safeMismatch}_${safeField}`,
  }
}

/**
 * Map a severity level to its CI outcome.
 * S0/S1 → fail; S2 → warn; S3 → pass
 */
export function ciOutcome(severity: Severity): CiOutcome {
  if (severity === "S0" || severity === "S1") return "fail"
  if (severity === "S2") return "warn"
  return "pass"
}
