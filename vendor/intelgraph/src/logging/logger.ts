/**
 * logger.ts — Main logger interface with multiple appenders
 */

import { existsSync } from "fs"
import { homedir } from "os"
import path from "path"
import { LogLevel, parseLogLevel, shouldLog } from "./log-levels.js"
import type { LogLevelName } from "./log-levels.js"
import type { LogEntry } from "./log-formatter.js"
import { FileLogger } from "./file-logger.js"
import { ConsoleLogger } from "./console-logger.js"

export { LogLevel } from "./log-levels.js"
export type { LogLevelName } from "./log-levels.js"

export interface LoggerOptions {
  component: string
  logDir?: string
  logLevel?: LogLevel
  enableConsole?: boolean
  enableFile?: boolean
  /** @internal — pass existing appenders to avoid re-creating them in child() */
  _fileLogger?: FileLogger | null
  /** @internal — pass existing appenders to avoid re-creating them in child() */
  _consoleLogger?: ConsoleLogger | null
  /** @internal — shared mutable box so setLogLevel propagates to all children */
  _levelBox?: { value: LogLevel }
}

export class Logger implements ILogger {
  private component: string
  private _levelBox: { value: LogLevel }
  private fileLogger: FileLogger | null = null
  private consoleLogger: ConsoleLogger | null = null

  constructor(options: LoggerOptions) {
    this.component = options.component
    this._levelBox = options._levelBox ?? { value: options.logLevel ?? LogLevel.INFO }

    // Use pre-built appenders when provided (child construction path).
    // Only construct new appenders at the root (top-level Logger construction).
    if ("_fileLogger" in options) {
      this.fileLogger = options._fileLogger ?? null
    } else if (options.enableFile !== false) {
      const logDir = this.resolveLogDir(options.logDir)
      this.fileLogger = new FileLogger({ filePath: path.join(logDir, "intelgraph.log") })
    }

    if ("_consoleLogger" in options) {
      this.consoleLogger = options._consoleLogger ?? null
    } else if (options.enableConsole !== false) {
      this.consoleLogger = new ConsoleLogger()
    }
  }

  private resolveLogDir(customDir?: string): string {
    // Priority: custom > INTELGRAPH_LOG_DIR > ~/.local/share/intelgraph/logs > /tmp/intelgraph
    if (customDir) {
      return customDir
    }

    if (process.env["INTELGRAPH_LOG_DIR"]) {
      return process.env["INTELGRAPH_LOG_DIR"]
    }
    try {
      const home = homedir()
      return path.join(home, ".local", "share", "intelgraph", "logs")
    } catch {
      return "/tmp/intelgraph"
    }
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.log(LogLevel.DEBUG, message, context)
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.log(LogLevel.INFO, message, context)
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.log(LogLevel.WARN, message, context)
  }

  error(message: string, errorOrContext?: Error | Record<string, unknown>): void {
    if (errorOrContext instanceof Error) {
      this.log(LogLevel.ERROR, message, undefined, errorOrContext)
    } else {
      this.log(LogLevel.ERROR, message, errorOrContext)
    }
  }

  /**
   * Log LSP request/response (always includes full payload for debugging)
   */
  lsp(direction: "request" | "response", method: string, payload: unknown): void {
    this.log(LogLevel.DEBUG, `LSP ${direction}: ${method}`, {
      direction,
      method,
      payload,
    })
  }

  /**
   * Log IntelGraph tool call (always includes full args and result for debugging)
   */
  toolCall(phase: "call" | "result" | "error", toolName: string, data: unknown): void {
    this.log(LogLevel.DEBUG, `Tool ${phase}: ${toolName}`, {
      phase,
      tool: toolName,
      data,
    })
  }

  /**
   * Log Bridge communication (connection events, forwarding)
   */
  bridge(event: string, details: Record<string, unknown>): void {
    this.log(LogLevel.DEBUG, `Bridge: ${event}`, {
      event,
      ...details,
    })
  }

  private log(level: LogLevel, message: string, context?: Record<string, unknown>, error?: Error): void {
    if (!shouldLog(level, this._levelBox.value)) {
      return
    }

    const entry: LogEntry = {
      timestamp: new Date(),
      level,
      component: this.component,
      message,
      context,
      error,
    }

    if (this.fileLogger) {
      this.fileLogger.write(entry)
    }

    if (this.consoleLogger) {
      this.consoleLogger.write(entry)
    }
  }

  setLogLevel(level: LogLevel): void {
    this._levelBox.value = level
  }

  getLogFile(): string | null {
    return this.fileLogger?.getFilePath() ?? null
  }

  child(subComponent: string): Logger {
    return new Logger({
      component: `${this.component}.${subComponent}`,
      _fileLogger: this.fileLogger,
      _consoleLogger: this.consoleLogger,
      _levelBox: this._levelBox,
    })
  }
}

// Global logger instance
let _globalLogger: Logger | null = null

export function initLogger(options: LoggerOptions): Logger {
  // Env-var level: INTELGRAPH_LOG_LEVEL overrides default INFO when no explicit logLevel passed
  if (options.logLevel === undefined) {
    const envLevel = process.env["INTELGRAPH_LOG_LEVEL"]
    if (envLevel) {
      options = { ...options, logLevel: parseLogLevel(envLevel) }
    }
  }
  _globalLogger = new Logger(options)
  _globalLogger.info("=".repeat(72))
  _globalLogger.info(`intelgraph starting — PID ${process.pid}`)
  _globalLogger.info(`Log file: ${_globalLogger.getLogFile() ?? "disabled"}`)
  _globalLogger.info(`Node version: ${process.version}`)
  _globalLogger.info(`Platform: ${process.platform}`)
  return _globalLogger
}

export function getLogger(): Logger {
  if (!_globalLogger) {
    // Fallback logger if not initialized
    _globalLogger = new Logger({ component: "intelgraph" })
  }
  return _globalLogger
}

// Convenience functions for backward compatibility
export function log(level: LogLevelName, message: string, context?: Record<string, unknown>): void {
  const logger = getLogger()
  const logLevel = parseLogLevel(level)

  switch (logLevel) {
    case LogLevel.DEBUG:
      logger.debug(message, context)
      break
    case LogLevel.INFO:
      logger.info(message, context)
      break
    case LogLevel.WARN:
      logger.warn(message, context)
      break
    case LogLevel.ERROR:
      logger.error(message, context)
      break
    case LogLevel.VERBOSE:
    case LogLevel.TRACE:
      logger.debug(message, context)
      break
  }
}

export function logError(message: string, err?: unknown): void {
  const logger = getLogger()
  if (err instanceof Error) {
    logger.error(message, err)
  } else {
    logger.error(`${message}: ${String(err ?? "")}`)
  }
}

export function getLogFile(): string {
  return getLogger().getLogFile() ?? "/tmp/intelgraph.log"
}

// ---- ILogger port binding ----

import type { ILogger } from "./ports.js"

/**
 * Adapt a `Logger` resolver into the `ILogger` port. The resolver is
 * re-invoked on every call so a late `initLogger()` replacing the
 * global instance is picked up by existing references to the port.
 * Child loggers resolve their parent once per call too, keeping the
 * same late-binding behavior through the tree.
 */
function asPort(resolve: () => Logger): ILogger {
  return {
    info: (message, context) => resolve().info(message, context),
    debug: (message, context) => resolve().debug(message, context),
    warn: (message, context) => resolve().warn(message, context),
    error: (message, errorOrContext) => resolve().error(message, errorOrContext),
    child: (sub) => asPort(() => resolve().child(sub)),
  }
}

/**
 * Bind the global `Logger` to the `ILogger` port. Consumers that type
 * against `ILogger` take this binding; everything that already calls
 * `getLogger()` / `log()` / `logError()` keeps working unchanged.
 */
export const loggerPort: ILogger = asPort(getLogger)
