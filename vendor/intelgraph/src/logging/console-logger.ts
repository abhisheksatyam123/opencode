/**
 * console-logger.ts — Console appender for stderr output
 */

import { formatConsoleEntry } from "./log-formatter.js"
import type { LogEntry } from "./log-formatter.js"

export class ConsoleLogger {
  write(entry: LogEntry): void {
    try {
      const line = formatConsoleEntry(entry)
      process.stderr.write(`[intelgraph] ${line}\n`)
    } catch (err) {
      // Ignore EPIPE errors when stderr is closed (detached process)
    }
  }
}
