import { readFile } from "node:fs/promises"
import { extname, isAbsolute, resolve } from "node:path"
import { LspClient } from "@intelgraph/lsp/index.js"
import { IndexTracker } from "@intelgraph/tracking/index.js"
import { readConfig, type IntelgraphConfig } from "@intelgraph/config/config.js"
import type { ILanguageClient, LspDiagnostic } from "@intelgraph/lsp/ports.js"

type LanguageKey = "c" | "cpp" | "typescript" | "javascript" | "rust" | "python" | "go"

type LanguageServerConfig = {
  enabled?: boolean
  command?: string
  server?: string
  path?: string
  args?: string[]
  extensions?: string[]
}

type ExtendedIntelGraphConfig = IntelgraphConfig & {
  language?: LanguageKey | string
  server?: string
  languageServers?: Partial<Record<LanguageKey, LanguageServerConfig>>
}

type ServerSpec = {
  key: LanguageKey
  extensions: Set<string>
  command: string
  args: string[]
  enabled: boolean
}

type ClientSlot = {
  spec: ServerSpec
  promise?: Promise<ILanguageClient | null>
  client?: ILanguageClient | null
  unavailable?: string
  openFileText: Map<string, string>
}

const DEFAULT_SPECS: Array<Omit<ServerSpec, "extensions"> & { extensions: string[] }> = [
  {
    key: "c",
    extensions: [".c", ".h", ".m"],
    command: process.env.INTELGRAPH_CLANGD_PATH || "clangd",
    args: [
      "--background-index",
      "--clang-tidy=false",
      "--completion-style=detailed",
      "--header-insertion=never",
      "--log=error",
    ],
    enabled: true,
  },
  {
    key: "cpp",
    extensions: [".cpp", ".cc", ".cxx", ".hpp", ".hxx", ".hh", ".mm", ".cu", ".cuh"],
    command: process.env.INTELGRAPH_CLANGD_PATH || "clangd",
    args: [
      "--background-index",
      "--clang-tidy=false",
      "--completion-style=detailed",
      "--header-insertion=never",
      "--log=error",
    ],
    enabled: true,
  },
  {
    key: "rust",
    extensions: [".rs"],
    command: process.env.INTELGRAPH_RUST_ANALYZER_PATH || "rust-analyzer",
    args: [],
    enabled: true,
  },
  {
    key: "typescript",
    extensions: [".ts", ".tsx", ".mts", ".cts"],
    command: process.env.INTELGRAPH_TYPESCRIPT_LANGUAGE_SERVER_PATH || "typescript-language-server",
    args: ["--stdio"],
    enabled: true,
  },
  {
    key: "javascript",
    extensions: [".js", ".jsx", ".mjs", ".cjs"],
    command: process.env.INTELGRAPH_TYPESCRIPT_LANGUAGE_SERVER_PATH || "typescript-language-server",
    args: ["--stdio"],
    enabled: true,
  },
  {
    key: "python",
    extensions: [".py", ".pyi"],
    command: process.env.INTELGRAPH_PYRIGHT_PATH || "pyright-langserver",
    args: ["--stdio"],
    enabled: true,
  },
  {
    key: "go",
    extensions: [".go"],
    command: process.env.INTELGRAPH_GOPLS_PATH || "gopls",
    args: [],
    enabled: true,
  },
]

function normalizeExtensions(values: string[]) {
  return values.map((value) => (value.startsWith(".") ? value : `.${value}`))
}

function configuredSpecs(root: string): ServerSpec[] {
  const config = readConfig(root) as ExtendedIntelGraphConfig
  return DEFAULT_SPECS.map((defaults) => {
    const override = config.languageServers?.[defaults.key] ?? {}
    const legacyClangd = defaults.key === "c" || defaults.key === "cpp"
    const command =
      override.command ??
      override.server ??
      override.path ??
      (legacyClangd ? (config.clangd ?? config.server) : undefined) ??
      defaults.command
    const args = override.args ?? (legacyClangd ? config.args : undefined) ?? defaults.args
    return {
      key: defaults.key,
      extensions: new Set(normalizeExtensions(override.extensions ?? defaults.extensions)),
      command,
      args,
      enabled: override.enabled ?? defaults.enabled,
    }
  })
}

async function resolveCommand(command: string): Promise<string | null> {
  if (isAbsolute(command) || command.includes("/")) return command
  try {
    return Bun.which(command) ?? null
  } catch {
    return null
  }
}

function emptyDiagnostics(filePath?: string): Map<string, LspDiagnostic[]> | LspDiagnostic[] {
  return filePath ? [] : new Map<string, LspDiagnostic[]>()
}

export class IntelGraphMultiplexLspLayer implements ILanguageClient {
  readonly root: string
  readonly indexTracker = new IndexTracker()
  private readonly slots: ClientSlot[]
  private readonly closeHandlers = new Set<() => void>()

  constructor(workspaceRoot: string) {
    this.root = resolve(workspaceRoot)
    this.slots = configuredSpecs(this.root).map((spec) => ({ spec, openFileText: new Map<string, string>() }))
  }

  private slotFor(filePath: string): ClientSlot | undefined {
    const ext = extname(filePath).toLowerCase()
    return this.slots.find((slot) => slot.spec.extensions.has(ext))
  }

  private async clientFor(slot: ClientSlot | undefined): Promise<ILanguageClient | null> {
    if (!slot) return null
    if (process.env.INTELGRAPH_LSP_DISABLED === "1") {
      slot.unavailable = "language server disabled by INTELGRAPH_LSP_DISABLED"
      slot.client = null
      return null
    }
    if (!slot.spec.enabled) {
      slot.unavailable = `language server disabled for ${slot.spec.key}`
      slot.client = null
      return null
    }
    if (slot.client !== undefined) return slot.client
    if (slot.promise) return slot.promise
    slot.promise = (async () => {
      try {
        const command = await resolveCommand(slot.spec.command)
        if (!command) {
          slot.unavailable = `language server not found: ${slot.spec.command}`
          slot.client = null
          return null
        }
        const client = await LspClient.create({
          root: this.root,
          clangdPath: command,
          clangdArgs: slot.spec.args,
          indexTracker: this.indexTracker,
          onExit: () => {
            slot.client = null
            slot.promise = undefined
            slot.openFileText.clear()
            for (const handler of this.closeHandlers) handler()
          },
        })
        for (const handler of this.closeHandlers) client.onConnectionClose(handler)
        slot.client = client
        return client
      } catch (error) {
        slot.unavailable = error instanceof Error ? error.message : String(error)
        slot.client = null
        return null
      } finally {
        slot.promise = undefined
      }
    })()
    return slot.promise
  }

  private async ensureOpenFile(filePath: string): Promise<ILanguageClient | null> {
    const slot = this.slotFor(filePath)
    const client = await this.clientFor(slot)
    if (!slot || !client) return client
    const text = await readFile(filePath, "utf8").catch(() => null)
    if (text === null) return client
    if (slot.openFileText.get(filePath) === text) return client
    const synced = await client
      .openFile(filePath, text)
      .then(() => true)
      .catch(() => false)
    if (synced) slot.openFileText.set(filePath, text)
    return client
  }

  async openFile(filePath: string, text: string): Promise<boolean> {
    const slot = this.slotFor(filePath)
    const client = await this.clientFor(slot)
    if (!slot || !client) return false
    const opened = await client.openFile(filePath, text)
    slot.openFileText.set(filePath, text)
    return opened
  }

  getDiagnostics(filePath: string): LspDiagnostic[]
  getDiagnostics(): Map<string, LspDiagnostic[]>
  getDiagnostics(filePath?: string): Map<string, LspDiagnostic[]> | LspDiagnostic[] {
    if (filePath) return this.slotFor(filePath)?.client?.getDiagnostics(filePath) ?? []
    const all = new Map<string, LspDiagnostic[]>()
    for (const slot of this.slots) {
      const diagnostics = slot.client?.getDiagnostics()
      if (!(diagnostics instanceof Map)) continue
      for (const [path, items] of diagnostics) all.set(path, items)
    }
    return all
  }

  onConnectionClose(handler: () => void): void {
    this.closeHandlers.add(handler)
    for (const slot of this.slots) slot.client?.onConnectionClose(handler)
  }

  disconnect(): void {
    for (const slot of this.slots) slot.client?.disconnect()
  }

  async hover(filePath: string, line: number, character: number): Promise<any> {
    return (await this.ensureOpenFile(filePath))?.hover(filePath, line, character) ?? null
  }

  async definition(filePath: string, line: number, character: number): Promise<any[]> {
    return (await this.ensureOpenFile(filePath))?.definition(filePath, line, character) ?? []
  }

  async declaration(filePath: string, line: number, character: number): Promise<any[]> {
    return (await this.ensureOpenFile(filePath))?.declaration(filePath, line, character) ?? []
  }

  async typeDefinition(filePath: string, line: number, character: number): Promise<any[]> {
    return (await this.ensureOpenFile(filePath))?.typeDefinition(filePath, line, character) ?? []
  }

  async references(filePath: string, line: number, character: number): Promise<any[]> {
    return (await this.ensureOpenFile(filePath))?.references(filePath, line, character) ?? []
  }

  async implementation(filePath: string, line: number, character: number): Promise<any[]> {
    return (await this.ensureOpenFile(filePath))?.implementation(filePath, line, character) ?? []
  }

  async documentHighlight(filePath: string, line: number, character: number): Promise<any[]> {
    return (await this.ensureOpenFile(filePath))?.documentHighlight(filePath, line, character) ?? []
  }

  async documentSymbol(filePath: string): Promise<any[]> {
    return (await this.ensureOpenFile(filePath))?.documentSymbol(filePath) ?? []
  }

  async workspaceSymbol(query: string): Promise<any[]> {
    const clients = await Promise.all(this.slots.map((slot) => this.clientFor(slot)))
    const results = await Promise.all(
      clients
        .filter((client): client is ILanguageClient => Boolean(client))
        .map((client) => client.workspaceSymbol(query)),
    )
    return results.flat()
  }

  async foldingRange(filePath: string): Promise<any[]> {
    return (await this.ensureOpenFile(filePath))?.foldingRange(filePath) ?? []
  }

  async signatureHelp(filePath: string, line: number, character: number): Promise<any> {
    return (await this.ensureOpenFile(filePath))?.signatureHelp(filePath, line, character) ?? null
  }

  async prepareRename(filePath: string, line: number, character: number): Promise<any> {
    return (await this.ensureOpenFile(filePath))?.prepareRename(filePath, line, character) ?? null
  }

  async rename(filePath: string, line: number, character: number, newName: string): Promise<any> {
    return (await this.ensureOpenFile(filePath))?.rename(filePath, line, character, newName) ?? null
  }

  async formatting(filePath: string): Promise<any[]> {
    return (await this.ensureOpenFile(filePath))?.formatting(filePath) ?? []
  }

  async rangeFormatting(
    filePath: string,
    startLine: number,
    startChar: number,
    endLine: number,
    endChar: number,
  ): Promise<any[]> {
    return (
      (await this.ensureOpenFile(filePath))?.rangeFormatting(filePath, startLine, startChar, endLine, endChar) ?? []
    )
  }

  async inlayHints(filePath: string, startLine: number, endLine: number): Promise<any[]> {
    return (await this.ensureOpenFile(filePath))?.inlayHints(filePath, startLine, endLine) ?? []
  }

  async prepareCallHierarchy(filePath: string, line: number, character: number): Promise<any[]> {
    return (await this.ensureOpenFile(filePath))?.prepareCallHierarchy(filePath, line, character) ?? []
  }

  async incomingCalls(filePath: string, line: number, character: number): Promise<any[]> {
    return (await this.ensureOpenFile(filePath))?.incomingCalls(filePath, line, character) ?? []
  }

  async outgoingCalls(filePath: string, line: number, character: number): Promise<any[]> {
    return (await this.ensureOpenFile(filePath))?.outgoingCalls(filePath, line, character) ?? []
  }

  async prepareTypeHierarchy(filePath: string, line: number, character: number): Promise<any[]> {
    return (await this.ensureOpenFile(filePath))?.prepareTypeHierarchy(filePath, line, character) ?? []
  }

  async supertypes(filePath: string, line: number, character: number): Promise<any[]> {
    return (await this.ensureOpenFile(filePath))?.supertypes(filePath, line, character) ?? []
  }

  async subtypes(filePath: string, line: number, character: number): Promise<any[]> {
    return (await this.ensureOpenFile(filePath))?.subtypes(filePath, line, character) ?? []
  }

  async codeAction(filePath: string, line: number, character: number): Promise<any[]> {
    return (await this.ensureOpenFile(filePath))?.codeAction(filePath, line, character) ?? []
  }

  async semanticTokensFull(filePath: string): Promise<any> {
    return (await this.ensureOpenFile(filePath))?.semanticTokensFull(filePath) ?? null
  }

  async serverInfo(): Promise<any> {
    const infos = await Promise.all(
      this.slots.map(async (slot) => ({
        language: slot.spec.key,
        unavailable: slot.unavailable,
        info: await slot.client?.serverInfo().catch(() => null),
      })),
    )
    return infos
  }

  async warmup(language: string = "c"): Promise<void> {
    const selected = this.slots.filter((slot) => slot.spec.key === language)
    await Promise.all(selected.map((slot) => this.clientFor(slot)))
  }

  runtimeStatus() {
    const state = this.indexTracker.state
    return {
      index: {
        isReady: state.isReady,
        percentage: state.percentage,
        message: state.message,
        updatedAt: state.updatedAt,
      },
      languages: this.slots.map((slot) => ({
        language: slot.spec.key,
        enabled: slot.spec.enabled,
        running: Boolean(slot.client),
        unavailable: slot.unavailable,
        openFiles: slot.openFileText.size,
      })),
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.slots.map((slot) => slot.client?.shutdown().catch(() => undefined)))
    for (const slot of this.slots) {
      slot.client = null
      slot.promise = undefined
      slot.openFileText.clear()
    }
  }
}

export function createIntelGraphLspLayer(workspaceRoot: string): IntelGraphMultiplexLspLayer {
  return new IntelGraphMultiplexLspLayer(workspaceRoot)
}
