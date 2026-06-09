/**
 * config.ts
 *
 * Unified configuration system for intelgraph.
 * All configuration is stored in .intelgraph.json at the workspace root.
 * This file serves as persistent memory across sessions.
 */

import { readFileSync, writeFileSync, existsSync } from "fs"
import { join } from "path"
import { loggerPort } from "../logging/logger.js"
const log = loggerPort.child("config")
import type { DaemonState } from "../daemon/index.js"
import type { IConfigLoader } from "./ports.js"

/**
 * Unified intelgraph configuration.
 * Stored in .intelgraph.json at workspace root.
 */
export interface IntelgraphConfig {
  // ── Core settings ──────────────────────────────────────────────────────────

  /** Workspace root directory (where compile_commands.json lives) */
  root?: string

  /** Path to clangd binary (default: "clangd" from PATH) */
  clangd?: string

  /** Extra arguments for clangd */
  args?: string[]

  /** Enable/disable the IntelGraph backend (default: true) */
  enabled?: boolean

  // ── Compile commands cleaning ──────────────────────────────────────────────

  compileCommandsCleaning?: {
    /** Enable automatic cleaning on startup (default: true) */
    enabled?: boolean

    /** Remove test/mock/stub files (default: false) */
    removeTests?: boolean

    /** Clean problematic compiler flags like -mduplex (default: true) */
    cleanFlags?: boolean

    /** Hash of last cleaned compile_commands.json (for caching) */
    lastCleanedHash?: string

    /** Timestamp of last cleaning */
    lastCleanedAt?: string

    /** Statistics from last cleaning */
    lastStats?: {
      originalEntries: number
      romFilesAdded: number
      testFilesRemoved: number
      duplicatesRemoved: number
      flagsCleaned: number
      finalEntries: number
    }
    /** What to do when unmatched patch files exist (default: "remap") */
    preflightPolicy?: "reject" | "fix" | "remap"
    /** Whether cleaning must produce zero unmatched entries (default: false) */
    requireZeroUnmatched?: boolean
  }

  // ── Daemon state (managed automatically) ───────────────────────────────────

  daemon?: {
    /** TCP port for clangd bridge */
    port?: number

    /** Bridge process PID */
    bridgePid?: number

    /** Clangd process PID */
    clangdPid?: number

    /** HTTP daemon port */
    httpPort?: number

    /** HTTP daemon PID */
    httpPid?: number

    /** When the daemon was started */
    startedAt?: string
  }

  // ── Index tracking (managed automatically) ─────────────────────────────────

  index?: {
    /** Whether background index is ready */
    ready?: boolean

    /** Index build progress (0-100) */
    progress?: number

    /** Last index status check timestamp */
    lastCheckedAt?: string
  }

  // ── Session memory (persistent across restarts) ───────────────────────────

  memory?: {
    /** Last accessed files (for quick reopening) */
    recentFiles?: string[]

    /** Known issues/warnings that were dismissed */
    dismissedWarnings?: string[]

    /** Custom user preferences */
    preferences?: {
      /** Preferred log level */
      logLevel?: "error" | "warn" | "info" | "debug"

      /** Auto-restart on crash */
      autoRestart?: boolean

      /** Max reconnect attempts */
      maxReconnectAttempts?: number
    }
  }

  // ── LLM reason assistant (optional) ───────────────────────────────────────
  llmReasoning?: {
    /** Enable LLM-assisted indirect-reason extraction (default: false) */
    enabled?: boolean
    /** Provider base URL (QPILOT OpenAI-compatible endpoint) */
    baseURL?: string
    /** Model ID, e.g. qpilot/anthropic::claude-4-6-sonnet */
    model?: string
    /** Optional fallback model IDs tried when primary is unavailable */
    fallbackModels?: string[]
    /** Env var containing API key (default: QPILOT_API_KEY) */
    apiKeyEnv?: string
    /** Max LLM calls per unresolved query (default: 3) */
    maxCallsPerQuery?: number
    /** Max attempts per model candidate for transient failures */
    maxAttemptsPerModel?: number
    /** Base delay for retry backoff in ms */
    backoffBaseMs?: number
    /** Upper cap for retry backoff delay in ms */
    backoffMaxMs?: number
    /** Markdown rule file path loaded into LLM prompt */
    ruleFile?: string
  }

  // ── Metadata ───────────────────────────────────────────────────────────────

  /** Config schema version (for migrations) */
  version?: string

  /** Last updated timestamp */
  updatedAt?: string

  /** User notes/comments */
  notes?: string
}

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: Partial<IntelgraphConfig> = {
  enabled: true,
  version: "1.0.0",
  compileCommandsCleaning: {
    enabled: true,
    removeTests: false,
    cleanFlags: true,
  },
  memory: {
    recentFiles: [],
    dismissedWarnings: [],
    preferences: {
      logLevel: "info",
      autoRestart: true,
      maxReconnectAttempts: 5,
    },
  },
  llmReasoning: {
    enabled: false,
    baseURL: "https://qpilot-api.qualcomm.com/v1",
    model: "qpilot/anthropic::claude-4-5-sonnet",
    fallbackModels: ["qpilot/anthropic::claude-4-6-sonnet"],
    apiKeyEnv: "QPILOT_API_KEY",
    maxCallsPerQuery: 3,
    maxAttemptsPerModel: 2,
    backoffBaseMs: 500,
    backoffMaxMs: 4000,
    ruleFile: "doc/atomic/skill/indirect-caller-reasoning-rules.md",
  },
}

/**
 * Resolve the workspace config file path. IntelGraph only reads and writes
 * `.intelgraph.json`; old config filenames are intentionally ignored.
 * Exported so other modules (compile-commands-cleaner, etc.) use the same path.
 */
export function resolveConfigPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".intelgraph.json")
}

/**
 * Read configuration from the workspace .intelgraph.json file.
 */
export function readConfig(workspaceRoot: string): IntelgraphConfig {
  const configPath = resolveConfigPath(workspaceRoot)

  try {
    if (!existsSync(configPath)) {
      log.info("No workspace config found — using defaults", {
        workspaceRoot,
        searched: [".intelgraph.json"],
      })
      return { ...DEFAULT_CONFIG }
    }

    const content = readFileSync(configPath, "utf8")
    const config = JSON.parse(content) as IntelgraphConfig

    // Merge with defaults. Use ?? {} to guard against explicit null values in
    // JSON (e.g. "memory": null) — spreading null throws a TypeError.
    const merged = {
      ...DEFAULT_CONFIG,
      ...config,
      compileCommandsCleaning: {
        ...DEFAULT_CONFIG.compileCommandsCleaning,
        ...(config.compileCommandsCleaning ?? {}),
      },
      memory: {
        ...DEFAULT_CONFIG.memory,
        ...(config.memory ?? {}),
        preferences: {
          ...DEFAULT_CONFIG.memory?.preferences,
          ...(config.memory?.preferences ?? {}),
        },
      },
      llmReasoning: {
        ...DEFAULT_CONFIG.llmReasoning,
        ...(config.llmReasoning ?? {}),
      },
    }

    log.info("Loaded workspace config", {
      configPath,
      cleaningEnabled: merged.compileCommandsCleaning?.enabled,
      daemonPort: merged.daemon?.port,
    })

    return merged
  } catch (err) {
    log.error("Failed to read workspace config — using defaults", err instanceof Error ? err : { raw: String(err) })
    return { ...DEFAULT_CONFIG }
  }
}

/**
 * Write configuration to the workspace .intelgraph.json file.
 */
export function writeConfig(workspaceRoot: string, config: IntelgraphConfig): void {
  const configPath = resolveConfigPath(workspaceRoot)

  try {
    // Update timestamp
    config.updatedAt = new Date().toISOString()

    // Pretty-print with 2-space indentation
    const content = JSON.stringify(config, null, 2)
    writeFileSync(configPath, content + "\n")

    log.info("Wrote workspace config", { configPath })
  } catch (err) {
    log.error("Failed to write workspace config", err instanceof Error ? err : { raw: String(err) })
  }
}

/**
 * Update specific config section
 */
export function updateConfig(
  workspaceRoot: string,
  updates: Partial<IntelgraphConfig>
): void {
  const config = readConfig(workspaceRoot)
  const merged = deepMerge(config, updates)
  writeConfig(workspaceRoot, merged)
}

/**
 * Deep merge two objects
 */
function deepMerge<T>(target: T, source: Partial<T>): T {
  const result = { ...target }

  for (const key in source) {
    const sourceValue = source[key]
    const targetValue = result[key]

    if (sourceValue === undefined) {
      continue
    }

    if (
      typeof sourceValue === "object" &&
      sourceValue !== null &&
      !Array.isArray(sourceValue) &&
      typeof targetValue === "object" &&
      targetValue !== null &&
      !Array.isArray(targetValue)
    ) {
      result[key] = deepMerge(targetValue, sourceValue) as any
    } else {
      result[key] = sourceValue as any
    }
  }

  return result
}

/**
 * Clear daemon state from config
 */
export function clearDaemonState(workspaceRoot: string): void {
  const config = readConfig(workspaceRoot)
  const { daemon: _dropped, ...rest } = config
  writeConfig(workspaceRoot, rest)
}

/**
 * Update daemon state in config. Accepts the full DaemonState struct
 * from the daemon module and projects it onto the IntelgraphConfig
 * `daemon` block, preserving other config sections.
 */
export function updateDaemonState(
  workspaceRoot: string,
  state: DaemonState,
): void {
  const daemon: NonNullable<IntelgraphConfig["daemon"]> = {
    port: state.port,
    bridgePid: state.bridgePid,
    clangdPid: state.serverPid,
    httpPort: state.httpPort,
    httpPid: state.httpPid,
    startedAt: state.startedAt,
  }
  updateConfig(workspaceRoot, { daemon })
}

/**
 * Update index state in config
 */
export function updateIndexState(
  workspaceRoot: string,
  state: NonNullable<IntelgraphConfig["index"]>
): void {
  updateConfig(workspaceRoot, {
    index: {
      ...state,
      lastCheckedAt: new Date().toISOString(),
    },
  })
}

/**
 * Add file to recent files list
 */
export function addRecentFile(workspaceRoot: string, filePath: string): void {
  const config = readConfig(workspaceRoot)
  const recentFiles = config.memory?.recentFiles || []

  // Add to front, remove duplicates, limit to 50
  const updated = [
    filePath,
    ...recentFiles.filter(f => f !== filePath),
  ].slice(0, 50)

  updateConfig(workspaceRoot, {
    memory: {
      ...config.memory,
      recentFiles: updated,
    },
  })
}

/**
 * Dismiss a warning (won't show again)
 */
export function dismissWarning(workspaceRoot: string, warningId: string): void {
  const config = readConfig(workspaceRoot)
  const dismissed = config.memory?.dismissedWarnings || []

  if (!dismissed.includes(warningId)) {
    updateConfig(workspaceRoot, {
      memory: {
        ...config.memory,
        dismissedWarnings: [...dismissed, warningId],
      },
    })
  }
}

/**
 * Check if a warning was dismissed
 */
export function isWarningDismissed(workspaceRoot: string, warningId: string): boolean {
  const config = readConfig(workspaceRoot)
  return config.memory?.dismissedWarnings?.includes(warningId) || false
}

/**
 * Generate example config file content
 */
export function generateExampleConfig(): string {
  const example: IntelgraphConfig = {
    version: "1.0.0",
    enabled: true,
    clangd: "/usr/local/bin/clangd-20",
    args: [
      "--background-index",
      "--enable-config",
      "--log=error",
    ],
    compileCommandsCleaning: {
      enabled: true,
      removeTests: false,
      cleanFlags: true,
    },
    memory: {
      preferences: {
        logLevel: "info",
        autoRestart: true,
        maxReconnectAttempts: 5,
      },
    },
    notes: "Custom configuration for this workspace",
  }

  return JSON.stringify(example, null, 2)
}

/**
 * IConfigLoader port binding. Composition roots depend on this symbol;
 * direct callers of `readConfig`, `writeConfig`, etc. continue to work.
 */
export const configLoader: IConfigLoader = {
  readConfig,
  writeConfig,
  updateDaemonState,
  updateIndexState,
  resolveConfigPath,
}
