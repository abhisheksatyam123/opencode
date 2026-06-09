/**
 * schemas.ts — Shared Zod schemas, lookup tables, and path helpers for IntelGraph tools.
 *
 * Zero dependencies on backend state — safe to import from anywhere.
 */

import { z } from "zod"
import path from "path"
import { fileURLToPath } from "url"

// ── Symbol kind number → readable name ───────────────────────────────────────
export const SYMBOL_KIND: Record<number, string> = {
  1: "File", 2: "Module", 3: "Namespace", 4: "Package",
  5: "Class", 6: "Method", 7: "Property", 8: "Field",
  9: "Constructor", 10: "Enum", 11: "Interface", 12: "Function",
  13: "Variable", 14: "Constant", 15: "String", 16: "Number",
  17: "Boolean", 18: "Array", 19: "Object", 20: "Key",
  21: "Null", 22: "EnumMember", 23: "Struct", 24: "Event",
  25: "Operator", 26: "TypeParameter",
}

// Highlight kind: 1=Text, 2=Read, 3=Write
export const HIGHLIGHT_KIND: Record<number, string> = { 1: "text", 2: "read", 3: "write" }

// Folding range kind
export const FOLD_KIND: Record<string, string> = {
  comment: "comment", imports: "imports", region: "region",
}

// ── Shared schemas ────────────────────────────────────────────────────────────

export const positionSchema = z.object({
  file:      z.string().describe("Absolute path to the C/C++ source file"),
  line:      z.number().int().min(1).describe("Line number (1-based)"),
  character: z.number().int().min(1).describe("Character offset (1-based)"),
})

export const fileOnlySchema = z.object({
  file: z.string().describe("Absolute path to the C/C++ source file"),
})

export const incomingCallSchema = positionSchema

// ── Path helpers ──────────────────────────────────────────────────────────────

export function displayPath(uriOrPath: string, root: string): string {
  try {
    const abs = uriOrPath.startsWith("file://") ? fileURLToPath(uriOrPath) : uriOrPath
    return path.relative(root, abs)
  } catch {
    return uriOrPath
  }
}

export function fmtLocation(loc: any, root: string): string {
  if (!loc) return "(unknown location)"
  const uri = loc.uri ?? loc.targetUri ?? ""
  const range = loc.range ?? loc.targetSelectionRange ?? loc.targetRange
  const line = range?.start?.line != null ? range.start.line + 1 : "?"
  const col  = range?.start?.character != null ? range.start.character + 1 : "?"
  return `${displayPath(uri, root)}:${line}:${col}`
}
