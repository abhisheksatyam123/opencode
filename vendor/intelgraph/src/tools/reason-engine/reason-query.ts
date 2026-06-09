import { readFileSync } from "fs"
import type { ILanguageClient } from "../../lsp/ports.js"
import type { UnifiedBackend } from "../../backend/unified-backend.js"

export interface ReasonQueryInput {
  file: string
  line: number
  character: number
  targetSymbol?: string
  suspectedPatterns?: string[]
}

export interface ReasonPreparedQuery {
  symbol: string
  lineText: string
  graph: Awaited<ReturnType<UnifiedBackend["patterns"]["collectIndirectCallers"]>>
  knownEvidence: Array<{ file: string; line: number; text: string }>
}

/**
 * Shared preparation path for reason tools:
 * - collect indirect-caller graph
 * - resolve target symbol
 * - build knownEvidence payload
 */
export async function prepareReasonQuery(
  backend: UnifiedBackend,
  client: ILanguageClient,
  args: ReasonQueryInput,
): Promise<ReasonPreparedQuery> {
  const lines = readFileSync(args.file, "utf8").split(/\r?\n/)
  const lineText = lines[Math.max(0, args.line - 1)] ?? ""

  const graph = await backend.patterns.collectIndirectCallers(client, {
    file: args.file,
    line: args.line,
    character: args.character,
    maxNodes: 20,
  })

  const cursorToken = resolveCursorToken(lineText, args.character)
  const symbol =
    args.targetSymbol ||
    graph.seed?.name ||
    cursorToken ||
    lineText.match(/\b([A-Za-z_]\w*)\b/)?.[1] ||
    "(unknown)"

  const knownEvidence: Array<{ file: string; line: number; text: string }> = [
    { file: args.file, line: args.line, text: lineText.trim() },
    ...graph.nodes.map((n) => ({ file: n.file, line: n.line, text: n.sourceText })),
  ]

  return { symbol, lineText, graph, knownEvidence }
}

function resolveCursorToken(lineText: string, character1Based: number): string | undefined {
  const tokenRe = /[A-Za-z_]\w*/g
  const col = Math.max(1, character1Based)
  let m: RegExpExecArray | null
  while ((m = tokenRe.exec(lineText)) !== null) {
    const start = m.index + 1
    const end = start + m[0].length - 1
    if (col >= start && col <= end) return m[0]
  }
  return undefined
}
