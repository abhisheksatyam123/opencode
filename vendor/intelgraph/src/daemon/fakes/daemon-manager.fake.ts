import type { IDaemonManager } from "../ports.js"
import type { DaemonState, SpawnDaemonOptions, SpawnHttpDaemonOptions } from "../index.js"

interface FakeDaemonBehavior {
  /** Synthetic port returned by spawnDaemon. Default 35000. */
  bridgePort?: number
  /** Synthetic PID for the bridge process. Default 11000. */
  bridgePid?: number
  /** Synthetic port for the HTTP daemon. Default 45000. */
  httpPort?: number
  /** Synthetic PID for the HTTP daemon. Default 12000. */
  httpPid?: number
  /**
   * Whether checkDaemonAlive() should return true after spawnDaemon.
   * Default: true (matches the happy path of a freshly spawned daemon).
   */
  aliveAfterSpawn?: boolean
}

/**
 * In-memory IDaemonManager. Stores state per-root in a Map instead of
 * on disk; returns synthetic PIDs and ports from spawn operations;
 * makes liveness decisions based on behavior flags rather than real
 * process/TCP checks.
 *
 * Suitable for:
 *   - contract-test suites
 *   - consumer unit tests that need IDaemonManager without real
 *     processes (IntelGraph startup flow, daemon reconnect logic)
 *
 * NOT suitable for: testing actual spawn/liveness semantics end-to-end —
 * that lives in integration tests.
 */
export class FakeDaemonManager implements IDaemonManager {
  private states = new Map<string, DaemonState>()
  private behavior: FakeDaemonBehavior
  readonly events: Array<{ kind: string; root?: string; reason?: string }> = []

  constructor(behavior: FakeDaemonBehavior = {}) {
    this.behavior = {
      bridgePort: 35000,
      bridgePid: 11000,
      httpPort: 45000,
      httpPid: 12000,
      aliveAfterSpawn: true,
      ...behavior,
    }
  }

  readState(root: string): DaemonState | null {
    const state = this.states.get(this.normalize(root))
    this.events.push({ kind: "readState", root })
    return state ? { ...state } : null
  }

  writeState(root: string, state: DaemonState): void {
    this.states.set(this.normalize(root), { ...state })
    this.events.push({ kind: "writeState", root })
  }

  clearState(root: string): void {
    this.states.delete(this.normalize(root))
    this.events.push({ kind: "clearState", root })
  }

  async checkDaemonAlive(state: DaemonState, expectedRoot?: string): Promise<boolean> {
    this.events.push({ kind: "checkDaemonAlive", root: state.root })
    if (expectedRoot && state.root !== expectedRoot) return false
    if (state.bridgePid === 0) return false
    return Boolean(this.behavior.aliveAfterSpawn)
  }

  async spawnDaemon(opts: SpawnDaemonOptions): Promise<DaemonState> {
    const root = this.normalize(opts.root)
    const existing = this.states.get(root)
    const state: DaemonState = {
      version: 1,
      bridgePid: this.behavior.bridgePid!,
      serverPid: 0,
      port: this.behavior.bridgePort!,
      root,
      serverBin: opts.serverBin,
      serverArgs: [...opts.serverArgs],
      startedAt: new Date().toISOString(),
      httpPort: existing?.httpPort,
      httpPid: existing?.httpPid,
    }
    this.states.set(root, state)
    this.events.push({ kind: "spawnDaemon", root })
    return { ...state }
  }

  async spawnHttpDaemon(opts: SpawnHttpDaemonOptions): Promise<{ httpPort: number; httpPid: number }> {
    const root = this.normalize(opts.root)
    const existing = this.states.get(root)
    const httpPort = this.behavior.httpPort!
    const httpPid = this.behavior.httpPid!
    const state: DaemonState = existing
      ? { ...existing, httpPort, httpPid }
      : {
          version: 1,
          bridgePid: 0,
          serverPid: 0,
          port: 0,
          root,
          serverBin: opts.serverBin,
          serverArgs: [...opts.serverArgs],
          startedAt: new Date().toISOString(),
          httpPort,
          httpPid,
        }
    this.states.set(root, state)
    this.events.push({ kind: "spawnHttpDaemon", root })
    return { httpPort, httpPid }
  }

  // ---- Test hooks (not part of IDaemonManager) ----

  /** Simulate a daemon crash: clear the "alive" flag. checkDaemonAlive will return false. */
  setAlive(alive: boolean): void {
    this.behavior.aliveAfterSpawn = alive
  }

  private normalize(root: string): string {
    // The real impl normalizes paths aggressively; the fake just trims trailing slash
    // and collapses it to a canonical string. Keeps the fake tiny but correct for
    // the "same root ⇒ same state" invariant.
    return root.replace(/\/+$/, "")
  }
}
