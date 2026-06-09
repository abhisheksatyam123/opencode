/**
 * log-levels.ts — Log level definitions and utilities
 */

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  VERBOSE = 4,
  TRACE = 5,
}

export type LogLevelName = "DEBUG" | "INFO" | "WARN" | "ERROR" | "VERBOSE" | "TRACE"

export function parseLogLevel(level: string): LogLevel {
  const normalized = level.toUpperCase() as LogLevelName
  switch (normalized) {
    case "DEBUG":
      return LogLevel.DEBUG
    case "INFO":
      return LogLevel.INFO
    case "WARN":
      return LogLevel.WARN
    case "ERROR":
      return LogLevel.ERROR
    case "VERBOSE":
      return LogLevel.VERBOSE
    case "TRACE":
      return LogLevel.TRACE
    default:
      return LogLevel.INFO
  }
}

export function logLevelToString(level: LogLevel): LogLevelName {
  switch (level) {
    case LogLevel.DEBUG:
      return "DEBUG"
    case LogLevel.INFO:
      return "INFO"
    case LogLevel.WARN:
      return "WARN"
    case LogLevel.ERROR:
      return "ERROR"
    case LogLevel.VERBOSE:
      return "VERBOSE"
    case LogLevel.TRACE:
      return "TRACE"
    default:
      return "INFO"
  }
}

export function shouldLog(messageLevel: LogLevel, configuredLevel: LogLevel): boolean {
  return messageLevel >= configuredLevel
}
