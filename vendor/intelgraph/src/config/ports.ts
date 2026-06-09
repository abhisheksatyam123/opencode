/**
 * Config-module port.
 *
 * The config module is the single source of truth for workspace-level
 * persistent configuration — daemon state, index state, user preferences,
 * LLM settings, recent files, and the schema-version bookkeeping needed
 * for future migrations. Everything lives in `.intelgraph.json` (with a
 * `.intelgraph.json` at the workspace root.
 *
 * `IConfigLoader` is the port the composition root depends on. Real impl:
 * the named-function bundle in `config.ts`, bound at the bottom of that
 * file as `configLoader`. Fake impl: `fakes/config-loader.fake.ts` —
 * in-memory Map keyed by workspaceRoot.
 *
 * Convenience helpers that wrap multiple reads/writes (addRecentFile,
 * dismissWarning, isWarningDismissed, generateExampleConfig,
 * clearDaemonState, updateConfig) stay as free functions in config.ts —
 * they're composition over the port surface, not contract material.
 */

import type { IntelgraphConfig } from "./config.js"
import type { DaemonState } from "../daemon/index.js"

/**
 * Shape of the `index` block inside IntelgraphConfig. Re-declared here
 * as a named type so consumers have a single import surface for the port.
 */
export type IndexState = NonNullable<IntelgraphConfig["index"]>

export interface IConfigLoader {
  /**
   * Read the workspace config file. Returns a config object merged with
   * module defaults; never throws for a missing file — callers always
   * get a usable config back.
   */
  readConfig(workspaceRoot: string): IntelgraphConfig

  /**
   * Overwrite the workspace config file with `config`. Sets the
   * `updatedAt` timestamp as a side effect.
   */
  writeConfig(workspaceRoot: string, config: IntelgraphConfig): void

  /**
   * Merge `state` into the `daemon` block of the workspace config,
   * preserving unrelated blocks (compileCommandsCleaning, memory, etc.).
   */
  updateDaemonState(workspaceRoot: string, state: DaemonState): void

  /**
   * Merge `state` into the `index` block of the workspace config,
   * preserving unrelated blocks. Implementations may stamp a
   * lastCheckedAt timestamp.
   */
  updateIndexState(workspaceRoot: string, state: IndexState): void

  /**
   * Resolve the absolute path to the workspace config file. Deterministic
   * for a fixed root — callers can cache it.
   */
  resolveConfigPath(workspaceRoot: string): string
}

export type { IntelgraphConfig, DaemonState }
