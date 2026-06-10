import z from "zod"
import { Effect, Layer, ServiceMap } from "effect"
import { makeRuntime } from "@/foundation/effect/run-service"
export * from "@/provider/lsp/contract/port"

export namespace LSP {
  export const Range = z
    .object({
      start: z.object({
        line: z.number(),
        character: z.number(),
      }),
      end: z.object({
        line: z.number(),
        character: z.number(),
      }),
    })
    .meta({
      ref: "Range",
    })
  export type Range = z.infer<typeof Range>

  export const Symbol = z
    .object({
      name: z.string(),
      kind: z.number(),
      location: z.object({
        uri: z.string(),
        range: Range,
      }),
    })
    .meta({
      ref: "Symbol",
    })
  export type Symbol = z.infer<typeof Symbol>

  export const DocumentSymbol = z
    .object({
      name: z.string(),
      detail: z.string().optional(),
      kind: z.number(),
      range: Range,
      selectionRange: Range,
      children: z.array(z.any()).optional(),
    })
    .meta({
      ref: "DocumentSymbol",
    })
  export type DocumentSymbol = z.infer<typeof DocumentSymbol>

  export const Status = z
    .object({
      id: z.string(),
      name: z.string(),
      root: z.string(),
      status: z.union([z.literal("connected"), z.literal("error")]),
    })
    .meta({
      ref: "LSPStatus",
    })
  export type Status = z.infer<typeof Status>

  export interface Diagnostic {
    severity?: number
    message: string
    range: {
      start: { line: number; character: number }
      end: { line: number; character: number }
    }
  }

  type LocInput = { file: string; line: number; character: number }

  export interface TextEdit {
    range: {
      start: { line: number; character: number }
      end: { line: number; character: number }
    }
    newText: string
  }

  export function isEdit(value: unknown): value is TextEdit {
    const row = value as {
      newText?: unknown
      range?: {
        start?: { line?: unknown; character?: unknown }
        end?: { line?: unknown; character?: unknown }
      }
    }
    return (
      !!row &&
      typeof row.newText === "string" &&
      typeof row.range?.start?.line === "number" &&
      typeof row.range?.start?.character === "number" &&
      typeof row.range?.end?.line === "number" &&
      typeof row.range?.end?.character === "number"
    )
  }

  export interface Interface {
    readonly init: () => Effect.Effect<void>
    readonly status: () => Effect.Effect<Status[]>
    readonly hasClients: (file: string) => Effect.Effect<boolean>
    readonly touchFile: (input: string, waitForDiagnostics?: boolean) => Effect.Effect<void>
    readonly diagnostics: () => Effect.Effect<Record<string, Diagnostic[]>>
    readonly hover: (input: LocInput) => Effect.Effect<any>
    readonly definition: (input: LocInput) => Effect.Effect<any[]>
    readonly references: (input: LocInput) => Effect.Effect<any[]>
    readonly implementation: (input: LocInput) => Effect.Effect<any[]>
    readonly documentSymbol: (uri: string) => Effect.Effect<(LSP.DocumentSymbol | LSP.Symbol)[]>
    readonly workspaceSymbol: (query: string) => Effect.Effect<LSP.Symbol[]>
    readonly prepareCallHierarchy: (input: LocInput) => Effect.Effect<any[]>
    readonly incomingCalls: (input: LocInput) => Effect.Effect<any[]>
    readonly outgoingCalls: (input: LocInput) => Effect.Effect<any[]>
    readonly willSaveWaitUntil: (input: {
      file: string
      reason?: number
    }) => Effect.Effect<{ ok: boolean; edits: TextEdit[] }>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/LSP") {}

  export const layer = Layer.succeed(
    Service,
    Service.of({
      init: () => Effect.void,
      status: () => Effect.succeed([]),
      hasClients: () => Effect.succeed(false),
      touchFile: () => Effect.void,
      diagnostics: () => Effect.succeed({}),
      hover: () => Effect.succeed([]),
      definition: () => Effect.succeed([]),
      references: () => Effect.succeed([]),
      implementation: () => Effect.succeed([]),
      documentSymbol: () => Effect.succeed([]),
      workspaceSymbol: () => Effect.succeed([]),
      prepareCallHierarchy: () => Effect.succeed([]),
      incomingCalls: () => Effect.succeed([]),
      outgoingCalls: () => Effect.succeed([]),
      willSaveWaitUntil: () => Effect.succeed({ ok: true, edits: [] }),
    }),
  )

  export const defaultLayer = layer

  const { runPromise } = makeRuntime(Service, defaultLayer)

  export const init = async () => runPromise((svc) => svc.init())
  export const status = async () => runPromise((svc) => svc.status())
  export const hasClients = async (file: string) => runPromise((svc) => svc.hasClients(file))
  export const touchFile = async (input: string, waitForDiagnostics?: boolean) =>
    runPromise((svc) => svc.touchFile(input, waitForDiagnostics))
  export const diagnostics = async () => runPromise((svc) => svc.diagnostics())
  export const hover = async (input: LocInput) => runPromise((svc) => svc.hover(input))
  export const definition = async (input: LocInput) => runPromise((svc) => svc.definition(input))
  export const references = async (input: LocInput) => runPromise((svc) => svc.references(input))
  export const implementation = async (input: LocInput) => runPromise((svc) => svc.implementation(input))
  export const documentSymbol = async (uri: string) => runPromise((svc) => svc.documentSymbol(uri))
  export const workspaceSymbol = async (query: string) => runPromise((svc) => svc.workspaceSymbol(query))
  export const prepareCallHierarchy = async (input: LocInput) => runPromise((svc) => svc.prepareCallHierarchy(input))
  export const incomingCalls = async (input: LocInput) => runPromise((svc) => svc.incomingCalls(input))
  export const outgoingCalls = async (input: LocInput) => runPromise((svc) => svc.outgoingCalls(input))
  export const willSaveWaitUntil = async (input: { file: string; reason?: number }) =>
    runPromise((svc) => svc.willSaveWaitUntil(input))

  export namespace Diagnostic {
    export function pretty(diagnostic: LSP.Diagnostic) {
      const severityMap = {
        1: "ERROR",
        2: "WARN",
        3: "INFO",
        4: "HINT",
      } as const
      const severity = severityMap[(diagnostic.severity || 1) as 1 | 2 | 3 | 4] ?? "ERROR"
      const line = (diagnostic.range?.start?.line ?? 0) + 1
      const col = (diagnostic.range?.start?.character ?? 0) + 1
      return `${severity} [${line}:${col}] ${diagnostic.message}`
    }
  }
}
