import { resolve } from "node:path"
import { registerDisposer } from "@/foundation/effect/instance-registry"
import type {
  IntelGraphApi,
  IntelGraphDiagnostic,
  IntelGraphLanguage,
  IntelGraphRelationRequest,
  IntelGraphRelationResponse,
  IntelGraphSymbolSearchRequest,
  IntelGraphSymbolSearchResult,
} from "@/intelgraph/contract"
import { intelGraphLspLikeFromLayer, type IntelGraphLspLayerLike } from "@/intelgraph/backend/lsp/adapter"
import { createIntelGraphLspLayer } from "@/intelgraph/backend/lsp/layer"
import { createDynamicIntelGraphResolver } from "@/intelgraph/backend/resolver/dynamic-resolver"

export type IntelGraphRuntimeState = "starting" | "indexing" | "ready" | "degraded" | "stopped"

export type IntelGraphRuntimeIndexStatus = {
  isReady: boolean
  percentage: number
  message: string
  updatedAt: string
}

export type IntelGraphRuntimeLanguageStatus = {
  language: string
  enabled: boolean
  running: boolean
  unavailable?: string
  openFiles?: number
}

export type IntelGraphRuntimeStatus = {
  workspaceRoot: string
  state: IntelGraphRuntimeState
  startedAt?: string
  stoppedAt?: string
  lastError?: string
  index: IntelGraphRuntimeIndexStatus
  languages: IntelGraphRuntimeLanguageStatus[]
}

export type IntelGraphRuntimeLayerStatus = {
  index: IntelGraphRuntimeIndexStatus
  languages: IntelGraphRuntimeLanguageStatus[]
}

export type IntelGraphRuntimeLayer = IntelGraphLspLayerLike & {
  definition?(filePath: string, line: number, character: number): Promise<unknown[]>
  serverInfo?(): Promise<unknown>
  warmup?(language?: IntelGraphLanguage): Promise<void>
  shutdown?(): Promise<void>
  runtimeStatus?(): IntelGraphRuntimeLayerStatus
}

export type IntelGraphWorkspaceRuntimeOptions = {
  layer?: IntelGraphRuntimeLayer
  autoStart?: boolean
  defaultLanguage?: IntelGraphLanguage
  searchReadyWaitMs?: number
  relationReadyWaitMs?: number
  pollIntervalMs?: number
}

const DEFAULT_LANGUAGE: IntelGraphLanguage = "c"
const DEFAULT_SEARCH_READY_WAIT_MS = 0
const DEFAULT_RELATION_READY_WAIT_MS = numberFromEnv("INTELGRAPH_RELATION_READY_WAIT_MS", 250)
const DEFAULT_POLL_INTERVAL_MS = 50
const stoppedIndexStatus = (): IntelGraphRuntimeIndexStatus => ({
  isReady: false,
  percentage: 0,
  message: "IntelGraph runtime is stopped",
  updatedAt: new Date().toISOString(),
})

export class IntelGraphWorkspaceRuntime {
  readonly workspaceRoot: string
  readonly api: IntelGraphApi
  private readonly layer: IntelGraphRuntimeLayer
  private readonly defaultLanguage: IntelGraphLanguage
  private readonly searchReadyWaitMs: number
  private readonly relationReadyWaitMs: number
  private readonly pollIntervalMs: number
  private startPromise: Promise<void> | undefined
  private readonly requestedLanguages = new Set<string>()
  private startedAt: string | undefined
  private stoppedAt: string | undefined
  private lastError: string | undefined
  private stopped = false

  constructor(workspaceRoot: string, options: IntelGraphWorkspaceRuntimeOptions = {}) {
    this.workspaceRoot = resolve(workspaceRoot)
    this.layer = options.layer ?? createIntelGraphLspLayer(this.workspaceRoot)
    this.defaultLanguage = options.defaultLanguage ?? DEFAULT_LANGUAGE
    this.searchReadyWaitMs = options.searchReadyWaitMs ?? DEFAULT_SEARCH_READY_WAIT_MS
    this.relationReadyWaitMs = options.relationReadyWaitMs ?? DEFAULT_RELATION_READY_WAIT_MS
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS

    const delegate = createDynamicIntelGraphResolver({
      lsp: intelGraphLspLikeFromLayer(this.layer),
      defaultLanguage: this.defaultLanguage,
    })
    this.api = this.wrapApi(delegate)

    if (options.autoStart ?? true) {
      void this.start(this.defaultLanguage)
    }
  }

  start(language: IntelGraphLanguage = this.defaultLanguage): Promise<void> {
    if (this.stopped) {
      this.stopped = false
      this.stoppedAt = undefined
    }
    this.requestedLanguages.add(language)
    if (this.startPromise) return this.startPromise
    this.startedAt ??= new Date().toISOString()
    this.lastError = undefined
    const warmup = this.layer.warmup ? this.layer.warmup(language) : Promise.resolve()
    this.startPromise = warmup
      .catch((error) => {
        this.lastError = errorMessage(error)
      })
      .finally(() => {
        this.startPromise = undefined
      })
    return this.startPromise
  }

  status(): IntelGraphRuntimeStatus {
    if (this.stopped) {
      return {
        workspaceRoot: this.workspaceRoot,
        state: "stopped",
        startedAt: this.startedAt,
        stoppedAt: this.stoppedAt,
        lastError: this.lastError,
        index: stoppedIndexStatus(),
        languages: [],
      }
    }

    const layerStatus = this.layer.runtimeStatus?.() ?? {
      index: {
        isReady: false,
        percentage: 0,
        message: this.startPromise ? "Starting language server" : "Language server not started",
        updatedAt: new Date().toISOString(),
      },
      languages: [],
    }
    const enabled = layerStatus.languages.filter((item) => item.enabled)
    const observed = this.requestedLanguages.size
      ? enabled.filter((item) => this.requestedLanguages.has(item.language))
      : enabled
    const unavailableObserved = observed.filter((item) => item.unavailable)
    const runningObserved = observed.filter((item) => item.running)
    const state: IntelGraphRuntimeState = this.lastError
      ? "degraded"
      : this.startPromise
        ? "starting"
        : layerStatus.index.isReady
          ? "ready"
          : observed.length > 0 && runningObserved.length === 0 && unavailableObserved.length === observed.length
            ? "degraded"
            : "indexing"

    return {
      workspaceRoot: this.workspaceRoot,
      state,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      lastError: this.lastError,
      index: layerStatus.index,
      languages: layerStatus.languages,
    }
  }

  async definition(input: { file: string; line: number; character: number }): Promise<unknown[]> {
    await this.start(this.defaultLanguage)
    return this.layer.definition?.(input.file, input.line, input.character) ?? []
  }

  async serverInfo(): Promise<unknown | undefined> {
    await this.start(this.defaultLanguage)
    return this.layer.serverInfo?.()
  }

  async shutdown(): Promise<void> {
    this.stopped = true
    this.stoppedAt = new Date().toISOString()
    await this.layer.shutdown?.()
  }

  private wrapApi(delegate: IntelGraphApi): IntelGraphApi {
    return {
      capabilities: () => delegate.capabilities(),
      searchSymbol: async (request) => {
        const ready = await this.prepareForRequest(request, this.searchReadyWaitMs)
        const result = await delegate.searchSymbol(request)
        return ready ? result : withRuntimeDiagnostic(result, this.status())
      },
      resolveRelations: async (request) => {
        const waitMs = Math.min(request.limits?.timeoutMs ?? this.relationReadyWaitMs, this.relationReadyWaitMs)
        const ready = await this.prepareForRequest(request, waitMs)
        const result = await delegate.resolveRelations(request)
        return ready ? result : withRuntimeDiagnostic(result, this.status())
      },
    }
  }

  private async prepareForRequest(
    request: IntelGraphSymbolSearchRequest | IntelGraphRelationRequest,
    waitMs: number,
  ): Promise<boolean> {
    await this.start(request.language ?? this.defaultLanguage)
    return this.waitForReady(waitMs)
  }

  private async waitForReady(waitMs: number): Promise<boolean> {
    if (this.status().state === "ready") return true
    if (waitMs <= 0) return false
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
      await sleep(Math.min(this.pollIntervalMs, Math.max(0, deadline - Date.now())))
      if (this.status().state === "ready") return true
    }
    return this.status().state === "ready"
  }
}

const defaultRuntimes = new Map<string, IntelGraphWorkspaceRuntime>()

export function getDefaultIntelGraphRuntime(workspaceRoot: string): IntelGraphWorkspaceRuntime {
  const key = resolve(workspaceRoot)
  const existing = defaultRuntimes.get(key)
  if (existing) return existing
  const runtime = new IntelGraphWorkspaceRuntime(key)
  defaultRuntimes.set(key, runtime)
  return runtime
}

async function closeDefaultIntelGraphRuntime(workspaceRoot: string): Promise<void> {
  const key = resolve(workspaceRoot)
  const runtime = defaultRuntimes.get(key)
  if (!runtime) return
  defaultRuntimes.delete(key)
  await runtime.shutdown()
}

registerDisposer(async (directory) => {
  await closeDefaultIntelGraphRuntime(directory)
})

function withRuntimeDiagnostic<T extends IntelGraphSymbolSearchResult | IntelGraphRelationResponse>(
  result: T,
  status: IntelGraphRuntimeStatus,
): T {
  const diagnostic = runtimeDiagnostic(status)
  if ("matches" in result) {
    return {
      ...result,
      diagnostics: [...(result.diagnostics ?? []), diagnostic],
    }
  }
  return {
    ...result,
    diagnostics: [...(result.diagnostics ?? []), diagnostic],
    root: {
      ...result.root,
      diagnostics: [...(result.root.diagnostics ?? []), diagnostic],
    },
  }
}

function runtimeDiagnostic(status: IntelGraphRuntimeStatus): IntelGraphDiagnostic {
  return {
    code: status.state === "degraded" ? "intelgraph_runtime_degraded" : "intelgraph_index_not_ready",
    message: `IntelGraph runtime is ${status.state}; ${status.index.message}`,
    severity: status.state === "degraded" ? "warn" : "info",
    tool: "lsp",
  }
}

function numberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
