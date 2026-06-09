/**
 * log-formatter.ts — Log message formatting utilities
 */

import { LogLevel, logLevelToString } from "./log-levels.js"

export interface LogEntry {
  timestamp: Date
  level: LogLevel
  component: string
  message: string
  context?: Record<string, unknown>
  error?: Error
}

/**
 * Format log entry as JSON (for structured logging and debugging LSP/Tools/Bridge)
 */
export function formatLogEntry(entry: LogEntry): string {
  const logObject: Record<string, unknown> = {
    timestamp: entry.timestamp.toISOString(),
    level: logLevelToString(entry.level),
    component: entry.component,
    message: entry.message,
  }

  // Add context if present
  if (entry.context && Object.keys(entry.context).length > 0) {
    logObject.context = entry.context
  }

  // Add error details if present
  if (entry.error) {
    logObject.error = {
      message: entry.error.message,
      name: entry.error.name,
      stack: entry.error.stack?.split("\n") || [],
    }
  }

  return JSON.stringify(logObject)
}

/**
 * Format log entry for console output (simplified JSON for readability)
 */
export function formatConsoleEntry(entry: LogEntry): string {
  const logObject: Record<string, unknown> = {
    level: logLevelToString(entry.level),
    component: entry.component,
    message: entry.message,
  }

  // Add context if present
  if (entry.context && Object.keys(entry.context).length > 0) {
    logObject.context = entry.context
  }

  // Add error message if present (not full stack for console)
  if (entry.error) {
    logObject.error = entry.error.message
  }

  return JSON.stringify(logObject)
}
