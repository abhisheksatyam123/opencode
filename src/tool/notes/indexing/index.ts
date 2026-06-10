// ---------------------------------------------------------------------------
// notes/indexing barrel — single entry point for every symbol/diagnostic call
// the notes tool makes. Anything that talks to the language-service shim from
// inside tool/notes/ should live in this folder, not in io.ts or operation
// files.
//
//   client.ts    — hasLsp, touch (indexing primitives)
//   normalize.ts — willSaveWaitUntil round-trip + applyLspEdits
//   headings.ts  — documentSymbol-based heading reader
//   link.ts      — opLink, lspResolve, title-by-filename resolver, diagnostics
// ---------------------------------------------------------------------------

export { hasLsp, touch, workspaceSymbolQuery } from "@/tool/notes/indexing/client"
export { lineOffsets, pointOffset, applyLspEdits, normalizeLsp } from "@/tool/notes/indexing/normalize"
export { linesToHeading, flatSymbol, readLspHeadings } from "@/tool/notes/indexing/headings"
export {
  resolveByTitle,
  invalidateTitleIndex,
  looksLikeFilename,
  lspResolve,
  noteDiagnostics,
  opLink,
} from "@/tool/notes/indexing/link"
