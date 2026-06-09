const C_RELATION_CONTROL_WORDS = new Set(["if", "for", "while", "switch", "return", "sizeof", "defined", "catch"])

const C_RELATION_DEFINITION_PREFIX =
  /^(?:[A-Za-z_][A-Za-z0-9_]*(?:\s*\*+)?\s+|static\s+|inline\s+|extern\s+|const\s+|unsigned\s+|signed\s+|struct\s+|enum\s+|union\s+|\*+\s*|\s+)+$/

export type RelationSymbolMatch = {
  name: string
  line: number
  column?: number
}

function relationIdentifierFromText(value: string) {
  const matches = [...value.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)]
    .map((match) => ({ name: match[1], column: (match.index ?? 0) + 1 }))
    .filter((match) => match.name && !C_RELATION_CONTROL_WORDS.has(match.name))
  return matches.at(-1)
}

export function relationSymbolNameFromSelection(value: string | undefined): RelationSymbolMatch | undefined {
  const selected = value?.trim()
  if (!selected) return undefined
  const direct = relationIdentifierFromText(selected)
  if (direct) return { name: direct.name, line: 0, column: direct.column }
  const bare = selected.match(/^([A-Za-z_][A-Za-z0-9_]*)$/)?.[1]
  if (bare && !C_RELATION_CONTROL_WORDS.has(bare)) return { name: bare, line: 0 }
  return undefined
}

function relationDefinitionIdentifierFromText(value: string) {
  const match = value.match(/^\s*([A-Za-z_][A-Za-z0-9_\s\*]*?)\b([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*\{?\s*$/)
  if (!match) return undefined
  const prefix = match[1] ?? ""
  const name = match[2]
  if (!name || C_RELATION_CONTROL_WORDS.has(name)) return undefined
  if (!C_RELATION_DEFINITION_PREFIX.test(prefix)) return undefined
  return name
}

function relationLineLooksCallable(lines: string[], index: number, candidate: string) {
  const text = lines[index] ?? ""
  if (!candidate) return false
  const trimmed = text.trim()
  if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) return false

  // Ordinary C call statements usually end in semicolon. Reject only lines that
  // look like function prototypes/declarations, not assignment/return/argument
  // call expressions such as `x = api(...)` or `return api(...)`.
  if (/;\s*$/.test(trimmed) && !/[={,]/.test(trimmed)) {
    const prototype = trimmed.match(/^([A-Za-z_][A-Za-z0-9_\s\*]*?)\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/)
    if (prototype?.[2] === candidate && C_RELATION_DEFINITION_PREFIX.test(prototype[1] ?? "")) return false
  }
  return true
}

function relationDefinitionFromSource(lines: string[], lineNumber: number): RelationSymbolMatch | undefined {
  let braceDepth = 0
  for (let index = lineNumber - 1; index >= Math.max(0, lineNumber - 220); index--) {
    const text = lines[index] ?? ""
    for (let char = text.length - 1; char >= 0; char--) {
      const value = text[char]
      if (value === "}") braceDepth++
      else if (value === "{") {
        if (braceDepth === 0) {
          const beforeBrace = text.slice(0, char + 1)
          const currentLineCandidate = relationDefinitionIdentifierFromText(beforeBrace)
          if (currentLineCandidate) return { name: currentLineCandidate, line: index + 1 }
          for (let sig = index - 1; sig >= Math.max(0, index - 6); sig--) {
            const candidate = relationDefinitionIdentifierFromText(lines[sig] ?? "")
            if (candidate) return { name: candidate, line: sig + 1 }
          }
        } else braceDepth--
      }
    }
    if (index === 0 || /;\s*$/.test(text)) {
      const candidate = relationDefinitionIdentifierFromText(text)
      if (candidate) return { name: candidate, line: index + 1 }
    }
  }
  return undefined
}

export function relationSymbolNameFromSource(source: string, lineNumber?: number): RelationSymbolMatch | undefined {
  if (!lineNumber || lineNumber < 1) return undefined
  const lines = source.split(/\r?\n/)
  const scan = (index: number) => {
    const text = lines[index] ?? ""
    const definition = relationDefinitionIdentifierFromText(text)
    if (definition) return { name: definition, line: index + 1 }
    const candidate = relationIdentifierFromText(text)
    if (!candidate) return undefined
    if (!relationLineLooksCallable(lines, index, candidate.name)) return undefined
    return { name: candidate.name, line: index + 1, column: candidate.column }
  }

  // Exact clicked/selected line wins. Never scan downward to a later API: that
  // made Show Relation on API callsites incorrectly target a subsequent API.
  const direct = scan(lineNumber - 1)
  if (direct) return direct

  // If the click landed on a continuation line of a multiline call, search a
  // tiny window upward for the call start. This preserves cursor locality.
  for (let index = lineNumber - 2; index >= Math.max(0, lineNumber - 4); index--) {
    const candidate = scan(index)
    if (candidate) return candidate
    const text = (lines[index] ?? "").trim()
    if (text.endsWith(";") || text.endsWith("{")) break
  }

  return relationDefinitionFromSource(lines, lineNumber)
}
