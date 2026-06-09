/**
 * Daemon-module ports.
 *
 * The daemon module manages a persistent language-server daemon and an
 * HTTP JSON daemon for a workspace. Both are detached, long-lived
 * processes that outlive short-lived clients; their coordination state lives
 * in `<root>/.intelgraph-state.json`.
 *
 * `IDaemonManager` is the port the composition root depends on. Real
 * impl: the named-function bundle in `index.ts`. Fake impl:
 * `fakes/daemon-manager.fake.ts` — in-memory state, no real processes.
 *
 * System utilities that don't model a contract (normaliseRoot,
 * computeWorkspaceId, isProcessAlive, isTcpPortOpen, findFreePort,
 * waitForPort) stay as free functions in index.ts — they're helpers,
 * not port material.
 */

import type { DaemonState, SpawnDaemonOptions, SpawnHttpDaemonOptions } from "./index.js"

export interface IDaemonManager {
  /**
   * Read the state file for the given workspace root. Returns null if
   * no state file exists, the file is unreadable, or the schema version
   * doesn't match.
   */
  readState(root: string): DaemonState | null

  /**
   * Overwrite the state file for `root` with `state`. Creates the file
   * if it doesn't exist.
   */
  writeState(root: string, state: DaemonState): void

  /**
   * Remove the state file(s) for `root`. Idempotent — missing files
   * are not an error. Removes both the new `.intelgraph-state.json`
   * if present.
   */
  clearState(root: string): void

  /**
   * Check whether the daemon described by `state` is actually alive.
   * Verifies (a) root matches (when `expectedRoot` is provided),
   * (b) bridge PID is alive, (c) TCP port is responding.
   *
   * Returns true only if all three hold.
   */
  checkDaemonAlive(state: DaemonState, expectedRoot?: string): Promise<boolean>

  /**
   * Spawn the language-server TCP bridge as a detached process and
   * write the resulting state to disk. The returned DaemonState
   * reflects what was written.
   */
  spawnDaemon(opts: SpawnDaemonOptions): Promise<DaemonState>

  /**
   * Spawn the IntelGraph HTTP JSON daemon as a detached process. Uses a
   * spawn lock to coordinate when multiple proxies race. Returns the
   * port and PID once the daemon is accepting connections (or throws
   * on timeout).
   */
  spawnHttpDaemon(opts: SpawnHttpDaemonOptions): Promise<{ httpPort: number; httpPid: number }>
}
