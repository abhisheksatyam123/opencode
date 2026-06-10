import type { IIndirectCallerProvider, IndirectCallerQuery } from "../ports.js"
import type { IndirectCallerGraph } from "../indirect-callers.js"
import type { ILanguageClient } from "../../lsp/ports.js"

/**
 * In-memory IIndirectCallerProvider. Returns a seeded graph instead of
 * actually walking LSP + parser output. Records every call for assertions.
 *
 * Default behavior: return an empty graph (seed = null, nodes = []).
 * Call `seed()` to register a result keyed by (file, line, character).
 */
export class FakeIndirectCallerProvider implements IIndirectCallerProvider {
  private seeds = new Map<string, IndirectCallerGraph>()
  readonly calls: Array<{ kind: string; args?: IndirectCallerQuery; graph?: IndirectCallerGraph }> = []

  /** Pre-seed a response for a specific query. Keyed by (file, line, character). */
  seed(query: IndirectCallerQuery, graph: IndirectCallerGraph): void {
    this.seeds.set(this.key(query), graph)
  }

  async collectIndirectCallers(_client: ILanguageClient, args: IndirectCallerQuery): Promise<IndirectCallerGraph> {
    this.calls.push({ kind: "collectIndirectCallers", args })
    const hit = this.seeds.get(this.key(args))
    if (hit) return hit
    return {
      seed: { name: "unseeded_symbol", file: args.file, line: args.line },
      nodes: [],
    }
  }

  formatIndirectCallerTree(graph: IndirectCallerGraph, _workspaceRoot: string): string {
    this.calls.push({ kind: "formatIndirectCallerTree", graph })
    // Minimal deterministic rendering for test assertions.
    if (!graph.seed) return "<no seed>"
    const lines = [`target: ${graph.seed.name} (${graph.seed.file}:${graph.seed.line})`]
    for (const node of graph.nodes) {
      lines.push(`  ↳ ${node.name} @ ${node.file}:${node.line}`)
    }
    return lines.join("\n")
  }

  private key(q: IndirectCallerQuery): string {
    return `${q.file}:${q.line}:${q.character}`
  }
}
