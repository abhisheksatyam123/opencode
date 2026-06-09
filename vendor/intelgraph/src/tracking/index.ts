/**
 * IndexTracker — listens to clangd's $/progress and clangd/fileStatus
 * notifications and maintains workspace-level and per-file parse state.
 *
 * clangd sends:
 *   window/workDoneProgress/create  { token }
 *   $/progress { token, value: { kind:"begin"|"report"|"end", percentage?, message? } }
 *   clangd/fileStatus { uri, state }   (per-file parse state)
 */

export interface IndexState {
  /** True once clangd has sent at least one "end" progress for indexing */
  isReady: boolean
  /** 0-100 while building, 100 when done */
  percentage: number
  /** Human-readable status string */
  message: string
  /** ISO timestamp of last update */
  updatedAt: string
}

/** Per-file parse state reported by clangd/fileStatus */
export type FileParseState =
  | "idle"
  | "queued"
  | "parsing"
  | "building preamble"
  | "building AST"
  | "indexing"
  | "unknown"

export class IndexTracker {
  private _state: IndexState = {
    isReady: false,
    percentage: 0,
    message: "Waiting for clangd to start indexing…",
    updatedAt: new Date().toISOString(),
  }

  /** Tokens registered via window/workDoneProgress/create */
  private _tokens = new Set<string | number>()

  /** Per-file parse state: filePath → state string */
  private _fileStates = new Map<string, FileParseState>()

  get state(): Readonly<IndexState> {
    return this._state
  }

  /** Returns a copy of the per-file state map */
  get fileStates(): ReadonlyMap<string, FileParseState> {
    return this._fileStates
  }

  /** Returns the parse state for a specific file, or undefined if unknown */
  fileState(filePath: string): FileParseState | undefined {
    return this._fileStates.get(filePath)
  }

  /** True if the given file is fully parsed and idle */
  isFileReady(filePath: string): boolean {
    const s = this._fileStates.get(filePath)
    return s === "idle" || s === undefined
  }

  /** Call this when clangd sends window/workDoneProgress/create */
  onProgressCreate(token: string | number): void {
    this._tokens.add(token)
  }

  /** Call this when clangd sends $/progress */
  onProgress(token: string | number, value: any): void {
    if (!this._tokens.has(token)) return

    const kind: string = value?.kind ?? ""
    const percentage: number | undefined = value?.percentage
    const message: string = value?.message ?? value?.title ?? ""

    if (kind === "begin") {
      this._update({
        isReady: false,
        percentage: percentage ?? 0,
        message: message || "Indexing started…",
      })
    } else if (kind === "report") {
      this._update({
        isReady: false,
        percentage: percentage ?? this._state.percentage,
        message: message || `Indexing… ${percentage ?? this._state.percentage}%`,
      })
    } else if (kind === "end") {
      this._tokens.delete(token)
      const allDone = this._tokens.size === 0
      this._update({
        isReady: allDone,
        percentage: 100,
        message: allDone ? "Index ready" : message || "Partial index complete",
      })
    }
  }

  /** Call this when clangd sends clangd/fileStatus { uri, state } */
  onFileStatus(uri: string, state: string): void {
    try {
      // Simple file:// → path conversion without importing url module
      const filePath = uri.startsWith("file://")
        ? decodeURIComponent(new URL(uri).pathname)
        : uri
      this._fileStates.set(filePath, (state as FileParseState) ?? "unknown")
    } catch {
      // ignore malformed URIs
    }
  }

  /** Returns a short status suffix to append to tool outputs */
  statusSuffix(): string {
    if (this._state.isReady) return ""
    const pct = this._state.percentage
    return `\n\n[Index: building ${pct}% — cross-file results may be incomplete]`
  }

  /** Returns a per-file status suffix if the file is being parsed */
  fileSuffix(filePath: string): string {
    const s = this._fileStates.get(filePath)
    if (!s || s === "idle") return ""
    return `\n\n[File: ${s} — results may be stale]`
  }

  markReady(): void {
    this._update({
      isReady: true,
      percentage: 100,
      message: "Index ready (reconnected to existing daemon)",
    })
  }

  private _update(patch: Partial<IndexState>): void {
    this._state = {
      ...this._state,
      ...patch,
      updatedAt: new Date().toISOString(),
    }
  }
}
