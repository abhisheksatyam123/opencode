import { queryVaultNotes, type PriorWorkNote, type VaultSemanticSearch } from "@/process/memory/vault-query"

export type RelatedPriorWorkNote = {
  link: string
  excerpt: string
}

export type SessionBootInput = {
  noteText: string
  notesRoot: string
  alreadySelected?: string[]
  topK?: number
  semanticSearch?: VaultSemanticSearch
}

function section(text: string, heading: string): string {
  const re = new RegExp(`^##\\s+${heading}\\s*$`, "im")
  const m = re.exec(text)
  if (!m) return ""
  const start = m.index + m[0].length
  const rest = text.slice(start)
  const next = rest.search(/^##\s/m)
  return (next === -1 ? rest : rest.slice(0, next)).trim()
}

export function parseTaskBootInput(noteText: string): { goal: string; system_components: string } {
  const goalRaw = section(noteText, "Goal")
  const systemRaw = section(noteText, "System components")
  const goal =
    goalRaw
      .split("\n")
      .find((l) => l.trim())
      ?.trim() ?? ""
  return {
    goal,
    system_components: systemRaw,
  }
}

function toRelatedNote(note: PriorWorkNote): RelatedPriorWorkNote {
  const score = note.score.toFixed(2)
  const excerpt = `(score: ${score}) ${note.title}${note.snippet ? ` — ${note.snippet}` : ""}`
  return {
    link: `[[${note.path}]]`,
    excerpt,
  }
}

export async function loadRelatedPriorWork(input: SessionBootInput): Promise<RelatedPriorWorkNote[]> {
  const parsed = parseTaskBootInput(input.noteText)
  if (!parsed.goal && !parsed.system_components) return []
  const result = await queryVaultNotes({
    notesRoot: input.notesRoot,
    goal: parsed.goal,
    systemComponents: parsed.system_components,
    topK: input.topK ?? 5,
    alreadySelected: input.alreadySelected ?? [],
    semanticSearch: input.semanticSearch,
  }).catch(() => ({ notes: [] }))
  return result.notes.map(toRelatedNote)
}
