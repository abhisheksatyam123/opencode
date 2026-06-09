/**
 * lsp-service.ts — LSP service exposed to plugin extractors via ctx.lsp.
 *
 * Wraps the existing ILanguageClient with two improvements that the
 * pattern-resolver already discovered the hard way:
 *
 *   1. **File open before request**: clangd needs the file opened in its
 *      buffer before some requests will succeed. This service auto-opens
 *      files for any positional request, so plugin authors never have to
 *      think about it.
 *
 *   2. **Timing + classified errors**: every request is timed and any
 *      thrown error is classified (timeout / non-added-document /
 *      transport / other) so the plugin's logger and the runner's metrics
 *      get useful data without per-call boilerplate.
 *
 * The plain LSP methods are still exposed (via the wrapped client) so
 * plugins that don't need the convenience layer can call through directly.
 *
 * Lifted helpers (with attribution):
 *   - timedPrepareCallHierarchy: src/tools/pattern-resolver/index.ts:143
 *   - timedIncomingCalls:        src/tools/pattern-resolver/index.ts:196
 *
 * The originals stay in pattern-resolver/index.ts until Step 8 of the
 * extraction infrastructure rollout migrates that file to use this service.
 */

import type { ILanguageClient } from "../../../lsp/ports.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type LspErrorClass =
  | "non-added-document"
  | "timeout"
  | "transport"
  | "other"

export interface LspCallResult<T> {
  /** The LSP response, or null on error or no result. */
  value: T | null
  /** Wall-clock duration in ms. */
  durationMs: number
  /** Set when the call failed. */
  error?: { class: LspErrorClass; message: string }
}

export interface LspServiceLogger {
  debug(event: string, context: Record<string, unknown>): void
}

/**
 * The shape plugins consume via ctx.lsp.
 *
 * This is a deliberate superset of ILanguageClient: every base LSP method is
 * exposed unchanged so plugins can call through, plus the convenience
 * methods that auto-open files, time the call, and classify errors.
 */
export interface LspService {
  /** The wrapped client. Use this for raw LSP calls when convenience is overkill. */
  readonly client: ILanguageClient

  /**
   * Open the file in the language server's buffer if not already open.
   * Idempotent — safe to call before every positional request. Returns true
   * on first open, false if already open or if the underlying client does
   * not support openFile.
   */
  openFileIfNeeded(filePath: string, fileText: string): Promise<boolean>

  /**
   * Timed prepareCallHierarchy with auto-file-open. The `stage` label is
   * passed through to the logger for trace correlation.
   */
  prepareCallHierarchy(
    filePath: string,
    fileText: string,
    line: number,
    character: number,
    stage?: string,
  ): Promise<LspCallResult<unknown[]>>

  /**
   * Timed incomingCalls with auto-file-open.
   */
  incomingCalls(
    filePath: string,
    fileText: string,
    line: number,
    character: number,
  ): Promise<LspCallResult<unknown[]>>

  /**
   * Timed outgoingCalls with auto-file-open.
   */
  outgoingCalls(
    filePath: string,
    fileText: string,
    line: number,
    character: number,
  ): Promise<LspCallResult<unknown[]>>

  /**
   * Timed documentSymbol with auto-file-open. The most common entry point
   * for plugins that walk a workspace symbol-by-symbol.
   */
  documentSymbol(
    filePath: string,
    fileText: string,
  ): Promise<LspCallResult<unknown[]>>
}

// ---------------------------------------------------------------------------
// Error classification (lifted from pattern-resolver/index.ts)
// ---------------------------------------------------------------------------

export function classifyLspError(err: unknown): LspErrorClass {
  const msg = err instanceof Error ? err.message : String(err)
  if (/non-added document/i.test(msg)) return "non-added-document"
  if (/timeout/i.test(msg)) return "timeout"
  if (/closed|disconnected|socket/i.test(msg)) return "transport"
  return "other"
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class LspServiceImpl implements LspService {
  constructor(
    public readonly client: ILanguageClient,
    private readonly logger: LspServiceLogger = { debug: () => {} },
  ) {}

  async openFileIfNeeded(filePath: string, fileText: string): Promise<boolean> {
    if (!fileText) return false
    const openStarted = Date.now()
    try {
      const isFirstOpen = await this.client.openFile(filePath, fileText)
      this.logger.debug("lsp:open-file:done", {
        filePath,
        durationMs: Date.now() - openStarted,
        isFirstOpen,
      })
      return isFirstOpen
    } catch (err) {
      this.logger.debug("lsp:open-file:error", {
        filePath,
        durationMs: Date.now() - openStarted,
        errorClass: classifyLspError(err),
        message: errorMessage(err).slice(0, 200),
      })
      return false
    }
  }

  async prepareCallHierarchy(
    filePath: string,
    fileText: string,
    line: number,
    character: number,
    stage = "default",
  ): Promise<LspCallResult<unknown[]>> {
    await this.openFileIfNeeded(filePath, fileText)
    const started = Date.now()
    this.logger.debug("lsp:prepare:start", { stage, filePath, line, character })
    try {
      const out = await this.client.prepareCallHierarchy(filePath, line, character)
      const durationMs = Date.now() - started
      this.logger.debug("lsp:prepare:done", {
        stage,
        filePath,
        line,
        durationMs,
        itemCount: out?.length ?? 0,
      })
      return { value: out ?? null, durationMs }
    } catch (err) {
      const durationMs = Date.now() - started
      const cls = classifyLspError(err)
      const message = errorMessage(err).slice(0, 200)
      this.logger.debug("lsp:prepare:error", {
        stage,
        filePath,
        line,
        durationMs,
        errorClass: cls,
        message,
      })
      return { value: null, durationMs, error: { class: cls, message } }
    }
  }

  async incomingCalls(
    filePath: string,
    fileText: string,
    line: number,
    character: number,
  ): Promise<LspCallResult<unknown[]>> {
    await this.openFileIfNeeded(filePath, fileText)
    const started = Date.now()
    this.logger.debug("lsp:incoming:start", { filePath, line, character })
    try {
      const out = await this.client.incomingCalls(filePath, line, character)
      const durationMs = Date.now() - started
      this.logger.debug("lsp:incoming:done", {
        filePath,
        line,
        durationMs,
        itemCount: out?.length ?? 0,
      })
      return { value: out ?? null, durationMs }
    } catch (err) {
      const durationMs = Date.now() - started
      const cls = classifyLspError(err)
      const message = errorMessage(err).slice(0, 200)
      this.logger.debug("lsp:incoming:error", {
        filePath,
        line,
        durationMs,
        errorClass: cls,
        message,
      })
      return { value: null, durationMs, error: { class: cls, message } }
    }
  }

  async outgoingCalls(
    filePath: string,
    fileText: string,
    line: number,
    character: number,
  ): Promise<LspCallResult<unknown[]>> {
    await this.openFileIfNeeded(filePath, fileText)
    const started = Date.now()
    this.logger.debug("lsp:outgoing:start", { filePath, line, character })
    try {
      const out = await this.client.outgoingCalls(filePath, line, character)
      const durationMs = Date.now() - started
      this.logger.debug("lsp:outgoing:done", {
        filePath,
        line,
        durationMs,
        itemCount: out?.length ?? 0,
      })
      return { value: out ?? null, durationMs }
    } catch (err) {
      const durationMs = Date.now() - started
      const cls = classifyLspError(err)
      const message = errorMessage(err).slice(0, 200)
      this.logger.debug("lsp:outgoing:error", {
        filePath,
        line,
        durationMs,
        errorClass: cls,
        message,
      })
      return { value: null, durationMs, error: { class: cls, message } }
    }
  }

  async documentSymbol(
    filePath: string,
    fileText: string,
  ): Promise<LspCallResult<unknown[]>> {
    await this.openFileIfNeeded(filePath, fileText)
    const started = Date.now()
    this.logger.debug("lsp:document-symbol:start", { filePath })
    try {
      const out = await this.client.documentSymbol(filePath)
      const durationMs = Date.now() - started
      this.logger.debug("lsp:document-symbol:done", {
        filePath,
        durationMs,
        itemCount: out?.length ?? 0,
      })
      return { value: out ?? null, durationMs }
    } catch (err) {
      const durationMs = Date.now() - started
      const cls = classifyLspError(err)
      const message = errorMessage(err).slice(0, 200)
      this.logger.debug("lsp:document-symbol:error", {
        filePath,
        durationMs,
        errorClass: cls,
        message,
      })
      return { value: null, durationMs, error: { class: cls, message } }
    }
  }
}
