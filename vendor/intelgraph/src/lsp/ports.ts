/**
 * types.ts — Language-agnostic LSP client interface.
 *
 * `ILanguageClient` is the contract every language server adapter must
 * satisfy. It abstracts the concrete `LspClient` so that consumers
 * (tools, backend, intelligence) can be wired against any LSP-compliant
 * server (clangd, rust-analyzer, pyright, gopls, etc.) without coupling
 * to a single implementation.
 *
 * Adding a new language server:
 *   1. Create a class that implements `ILanguageClient`
 *   2. Wire it through a factory in `src/core/lifecycle.ts`
 *   3. Configure spawn args via `WorkspaceConfig.server` / `args`
 */

import type { IndexTracker } from "../tracking/index.js"

/**
 * Minimal typed shape for an LSP diagnostic.
 * Matches the LSP 3.x `Diagnostic` protocol object as returned by
 * textDocument/publishDiagnostics notifications. Consumers may safely
 * access any field not listed here via `unknown` narrowing.
 */
export interface LspDiagnostic {
  /** 1=Error, 2=Warning, 3=Information, 4=Hint */
  severity?: 1 | 2 | 3 | 4
  range: {
    start: { line: number; character: number }
    end: { line: number; character: number }
  }
  message: string
  source?: string
  code?: string | number
}

export interface ILanguageClient {
  /** Absolute path to the workspace root */
  readonly root: string
  /** Shared index readiness tracker (background indexing progress) */
  readonly indexTracker: IndexTracker

  // ── File management ─────────────────────────────────────────────────────
  /** Open a file in the language server. Returns true if this was the first open. */
  openFile(filePath: string, text: string): Promise<boolean>
  /** Get diagnostics for a file, or a map of all files → diagnostics. */
  getDiagnostics(filePath: string): LspDiagnostic[]
  getDiagnostics(): Map<string, LspDiagnostic[]>
  getDiagnostics(filePath?: string): Map<string, LspDiagnostic[]> | LspDiagnostic[]

  // ── Connection lifecycle ─────────────────────────────────────────────────
  /**
   * Register a handler that fires when the underlying transport connection
   * drops (e.g. clangd bridge restarted). Called by lifecycle.ts to
   * trigger reconnect logic without coupling to the internal _conn object.
   */
  onConnectionClose(handler: () => void): void
  /**
   * Forcefully close the underlying transport (end + dispose). Used by the
   * SIGTERM handler in index.ts to disconnect cleanly without waiting for
   * the LSP shutdown handshake to complete.
   */
  disconnect(): void

  // ── Standard LSP requests ───────────────────────────────────────────────
  hover(filePath: string, line: number, character: number): Promise<any>
  definition(filePath: string, line: number, character: number): Promise<any[]>
  declaration(filePath: string, line: number, character: number): Promise<any[]>
  typeDefinition(filePath: string, line: number, character: number): Promise<any[]>
  references(filePath: string, line: number, character: number): Promise<any[]>
  implementation(filePath: string, line: number, character: number): Promise<any[]>
  documentHighlight(filePath: string, line: number, character: number): Promise<any[]>
  documentSymbol(filePath: string): Promise<any[]>
  workspaceSymbol(query: string): Promise<any[]>
  foldingRange(filePath: string): Promise<any[]>
  signatureHelp(filePath: string, line: number, character: number): Promise<any>
  prepareRename(filePath: string, line: number, character: number): Promise<any>
  rename(filePath: string, line: number, character: number, newName: string): Promise<any>
  formatting(filePath: string): Promise<any[]>
  rangeFormatting(
    filePath: string,
    startLine: number,
    startChar: number,
    endLine: number,
    endChar: number,
  ): Promise<any[]>
  inlayHints(filePath: string, startLine: number, endLine: number): Promise<any[]>
  prepareCallHierarchy(filePath: string, line: number, character: number): Promise<any[]>
  incomingCalls(filePath: string, line: number, character: number): Promise<any[]>
  outgoingCalls(filePath: string, line: number, character: number): Promise<any[]>
  prepareTypeHierarchy(filePath: string, line: number, character: number): Promise<any[]>
  supertypes(filePath: string, line: number, character: number): Promise<any[]>
  subtypes(filePath: string, line: number, character: number): Promise<any[]>
  codeAction(filePath: string, line: number, character: number): Promise<any[]>
  semanticTokensFull(filePath: string): Promise<any>

  // ── Optional server-specific extensions ─────────────────────────────────
  /**
   * Server-specific status info (e.g. clangd's `$/clangd/info`).
   * Returns null if the underlying server does not implement this extension.
   * Adapters should override this when they have a meaningful response.
   */
  serverInfo(): Promise<any>

  // ── Lifecycle ───────────────────────────────────────────────────────────
  shutdown(): Promise<void>
}
