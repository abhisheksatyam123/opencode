import { LSP } from "@/provider/lsp"

// ---------------------------------------------------------------------------
// Thin indexing client wrappers used by the notes tool.
//
// All notes-tool symbol/diagnostic traffic flows through this module. Keep
// the surface narrow — if a new call is needed, add it here so the contract
// with the language-service shim stays explicit.
// ---------------------------------------------------------------------------

export async function hasLsp(fp: string) {
  return LSP.hasClients(fp).catch(() => false)
}

export async function touch(fp: string) {
  await LSP.touchFile(fp, true).catch(() => {})
}

/**
 * Query workspace symbols. Returns [] gracefully if unavailable.
 * Each symbol has: name, kind, location.uri, location.range.start.line
 */
export async function workspaceSymbolQuery(query: string): Promise<
  Array<{
    name: string
    kind: number
    location: { uri: string; range: { start: { line: number; character: number } } }
  }>
> {
  return LSP.workspaceSymbol(query).catch(() => []) as Promise<
    Array<{
      name: string
      kind: number
      location: { uri: string; range: { start: { line: number; character: number } } }
    }>
  >
}
