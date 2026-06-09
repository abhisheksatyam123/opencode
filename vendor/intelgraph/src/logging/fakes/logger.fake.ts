import type { ILogger } from "../ports.js"

/**
 * A single recorded log call on a `FakeLogger`. Distinct from the
 * concrete `LogEntry` in `../log-formatter.ts`, which carries a
 * `Date` timestamp and a numeric `LogLevel` for the real sink path;
 * here we record method-name levels for test-assertion readability.
 */
export interface FakeLogEntry {
  level: "info" | "debug" | "warn" | "error"
  component: string
  message: string
  context?: Record<string, unknown>
  error?: Error
}

/**
 * In-memory `ILogger`. Entries go into a shared `entries` buffer that
 * children inherit, so a test can construct a root FakeLogger, derive
 * children from it, and inspect every emitted line through a single
 * array.
 *
 * Suitable for:
 *   - contract-test suites
 *   - consumer unit tests that need to verify log output without
 *     writing to disk or the console
 *
 * NOT suitable for: exercising file-sink or console-formatter
 * behavior — those live on the real `Logger` class and belong in
 * integration tests.
 */
export class FakeLogger implements ILogger {
  readonly component: string
  readonly entries: FakeLogEntry[]

  constructor(component: string = "", entries: FakeLogEntry[] = []) {
    this.component = component
    this.entries = entries
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.entries.push({ level: "info", component: this.component, message, context })
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.entries.push({ level: "debug", component: this.component, message, context })
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.entries.push({ level: "warn", component: this.component, message, context })
  }

  error(message: string, errorOrContext?: Error | Record<string, unknown>): void {
    if (errorOrContext instanceof Error) {
      this.entries.push({ level: "error", component: this.component, message, error: errorOrContext })
    } else {
      this.entries.push({ level: "error", component: this.component, message, context: errorOrContext })
    }
  }

  child(subComponent: string): FakeLogger {
    const nextComponent = this.component ? `${this.component}.${subComponent}` : subComponent
    // Share the entries array so the parent sees every descendant's output.
    return new FakeLogger(nextComponent, this.entries)
  }
}
