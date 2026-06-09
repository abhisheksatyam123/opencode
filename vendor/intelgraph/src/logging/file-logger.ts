/**
 * file-logger.ts — File appender with log rotation
 */

import { createWriteStream, WriteStream, statSync, renameSync, unlinkSync, existsSync, mkdirSync } from "fs"
import path from "path"
import { formatLogEntry } from "./log-formatter.js"
import type { LogEntry } from "./log-formatter.js"

export interface FileLoggerOptions {
  filePath: string
  maxSizeBytes?: number // Default: 10MB
  maxBackups?: number // Default: 5
}

export class FileLogger {
  private filePath: string
  private maxSizeBytes: number
  private maxBackups: number
  private stream: WriteStream | null = null

  constructor(options: FileLoggerOptions) {
    this.filePath = options.filePath
    this.maxSizeBytes = options.maxSizeBytes ?? 10 * 1024 * 1024 // 10MB
    this.maxBackups = options.maxBackups ?? 5

    // Ensure directory exists
    const dir = path.dirname(this.filePath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    this.stream = createWriteStream(this.filePath, { flags: "a", encoding: "utf8" })
  }

  write(entry: LogEntry): void {
    try {
      // Check if rotation is needed
      this.rotateIfNeeded()

      // Format and append via stream
      const line = formatLogEntry(entry) + "\n"
      this.stream?.write(line)
    } catch (err) {
      // Silently fail - don't crash the app if logging fails
      console.error(`[FileLogger] Failed to write log: ${err}`)
    }
  }

  private rotateIfNeeded(): void {
    try {
      if (!existsSync(this.filePath)) {
        return
      }

      const stats = statSync(this.filePath)
      if (stats.size < this.maxSizeBytes) {
        return
      }

      // Close stream before rotating
      this.stream?.end()
      this.stream = null

      // Delete the oldest backup if it exists
      const oldest = `${this.filePath}.${this.maxBackups}`
      if (existsSync(oldest)) unlinkSync(oldest)

      // Shift .N-1 → .N down to .1 → .2
      for (let i = this.maxBackups - 1; i >= 1; i--) {
        const src = `${this.filePath}.${i}`
        const dst = `${this.filePath}.${i + 1}`
        if (existsSync(src)) renameSync(src, dst)
      }

      // Rotate current → .1
      renameSync(this.filePath, `${this.filePath}.1`)

      // Reopen stream on new (empty) log file
      this.stream = createWriteStream(this.filePath, { flags: "a", encoding: "utf8" })
    } catch (err) {
      console.error(`[FileLogger] Failed to rotate log: ${err}`)
    }
  }

  close(): void {
    this.stream?.end()
    this.stream = null
  }

  getFilePath(): string {
    return this.filePath
  }
}
