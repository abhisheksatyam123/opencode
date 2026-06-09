/**
 * Logging-module port.
 *
 * `ILogger` is the minimal structured-logging surface consumers depend
 * on. Every module that needs to emit log lines should type its logger
 * parameter as `ILogger`, not `Logger`, so tests can swap in
 * `FakeLogger` (from `fakes/logger.fake.ts`) without hitting real
 * file/console sinks.
 *
 * Real impl: the `Logger` class in `./logger.ts`, exposed through the
 * `loggerPort` binding at the bottom of that file. The `Logger` class
 * itself keeps richer, non-port methods (`lsp`, `toolCall`, `bridge`,
 * `setLogLevel`, `getLogFile`) that are implementation-specific.
 *
 * Fake impl: `./fakes/logger.fake.ts` — in-memory entry buffer, shared
 * across the child-logger tree. Suitable for contract tests and
 * consumer unit tests.
 *
 * The contract test suite is `test/contracts/ilogger/`.
 */
export interface ILogger {
  /** Emit an INFO-level entry. Context, if provided, is attached as structured data. */
  info(message: string, context?: Record<string, unknown>): void

  /** Emit a DEBUG-level entry. */
  debug(message: string, context?: Record<string, unknown>): void

  /** Emit a WARN-level entry. */
  warn(message: string, context?: Record<string, unknown>): void

  /**
   * Emit an ERROR-level entry. Second argument is either an `Error`
   * (recorded as the error) or a plain context record.
   */
  error(message: string, errorOrContext?: Error | Record<string, unknown>): void

  /**
   * Return a child logger scoped to `subComponent`. The child's
   * component path is `parent.sub` when the parent has a component,
   * otherwise just `sub`. Child loggers remain `ILogger` so the
   * contract composes indefinitely.
   */
  child(subComponent: string): ILogger
}
