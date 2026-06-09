import type { IConfigLoader, IndexState, IntelgraphConfig, DaemonState } from "../ports.js"

/**
 * In-memory IConfigLoader. Stores config per-workspace-root in a Map
 * instead of on disk; `resolveConfigPath` returns a synthetic
 * `${root}/.intelgraph.json` path that never touches the filesystem.
 *
 * Suitable for:
 *   - contract-test suites
 *   - consumer unit tests that need IConfigLoader without touching disk
 *     (daemon startup flow, index-state updates, CLI tool flows)
 *
 * NOT suitable for: testing JSON serialization, legacy-file fallback,
 * or error-path behavior of the real fs-backed impl — those live in
 * integration tests.
 */
export class FakeConfigLoader implements IConfigLoader {
  private readonly store = new Map<string, IntelgraphConfig>()
  /** Append-only recorder: every `writeConfig` call appends a snapshot. */
  readonly written: IntelgraphConfig[] = []

  resolveConfigPath(workspaceRoot: string): string {
    return `${this.normalize(workspaceRoot)}/.intelgraph.json`
  }

  readConfig(workspaceRoot: string): IntelgraphConfig {
    const key = this.normalize(workspaceRoot)
    const stored = this.store.get(key)
    if (stored) return this.clone(stored)
    return this.defaultConfig()
  }

  writeConfig(workspaceRoot: string, config: IntelgraphConfig): void {
    const key = this.normalize(workspaceRoot)
    const snapshot = this.clone(config)
    this.store.set(key, snapshot)
    this.written.push(this.clone(config))
  }

  updateDaemonState(workspaceRoot: string, state: DaemonState): void {
    const current = this.readConfig(workspaceRoot)
    const next: IntelgraphConfig = {
      ...current,
      daemon: {
        port: state.port,
        bridgePid: state.bridgePid,
        clangdPid: state.serverPid,
        httpPort: state.httpPort,
        httpPid: state.httpPid,
        startedAt: state.startedAt,
      },
    }
    this.writeConfig(workspaceRoot, next)
  }

  updateIndexState(workspaceRoot: string, state: IndexState): void {
    const current = this.readConfig(workspaceRoot)
    const next: IntelgraphConfig = {
      ...current,
      index: { ...state },
    }
    this.writeConfig(workspaceRoot, next)
  }

  private defaultConfig(): IntelgraphConfig {
    return {
      enabled: true,
      version: "1.0.0",
      daemon: {},
      index: {},
    }
  }

  private normalize(root: string): string {
    return root.replace(/\/+$/, "")
  }

  private clone(config: IntelgraphConfig): IntelgraphConfig {
    // Structured clone to avoid aliasing between store and returned values.
    // JSON round-trip is safe here: IntelgraphConfig is plain data.
    return JSON.parse(JSON.stringify(config)) as IntelgraphConfig
  }
}
