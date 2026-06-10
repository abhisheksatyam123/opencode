/**
 * tools/index.ts — IntelGraph transport tool definitions.
 *
 * Each tool maps to one or more LSP operations on the shared LspClient.
 * Outputs are plain text (not raw JSON) so agents can read them directly.
 *
 * Schemas, formatters, and dispatch state live in separate modules:
 *   ./schemas.ts    — Zod schemas, lookup tables, path helpers
 *   ./formatters.ts — All format* functions
 *   ./dispatch.ts   — ToolDef, singletons, set* functions, withFile
 */

import { z } from "zod"
import { loggerPort } from "../logging/logger.js"
import { computeWorkspaceId } from "../daemon/index.js"
import {
  getDaemonBridgePid,
  getDaemonPort,
  getHttpDaemonPid,
  getHttpDaemonPort,
  getPreflightResult,
} from "../daemon/state.js"
import { configLoader } from "../config/config.js"
import { prepareReasonQuery } from "./reason-engine/reason-query.js"
import { buildRuntimeFlowPayload } from "./reason-engine/runtime-flow-output.js"
import { readReasoningConfig } from "./reason-engine/reason-config.js"
import {
  QUERY_INTENTS,
  validateQueryRequest,
  executeOrchestratedQuery,
  queryNodeAdapter,
  diffGraphJson,
} from "../intelligence/public-api.js"
import { resolveCallers } from "./get-callers.js"

import { positionSchema, fileOnlySchema, incomingCallSchema } from "./schemas.js"
import {
  formatHover,
  formatDefinition,
  formatReferences,
  formatDocumentSymbol,
  formatWorkspaceSymbol,
  formatIncomingCalls,
  formatOutgoingCalls,
  formatTypeHierarchy,
  formatDiagnostics,
  formatCodeAction,
  formatDocumentHighlight,
  formatFoldingRange,
  formatSignatureHelp,
  formatRename,
  formatFormat,
  formatInlayHints,
  formatReasonChain,
  formatIntelligenceResponse,
} from "./formatters.js"
import {
  ToolDef,
  INFLIGHT_INDIRECT_CALLERS,
  INDIRECT_CALLER_TELEMETRY,
  unifiedBackendOrThrow,
  inflightIndirectCallerKey,
  withFile,
  getIntelligenceDeps,
} from "./dispatch.js"

export { setDbFoundation, getDbFoundation, setIngestDeps, setExtractFileDeps } from "../intelligence/public-api.js"
export { setUnifiedBackend, setIntelligenceDeps } from "./dispatch.js"
export type { ToolDef }

import type { WorkspaceConfig } from "../config/bootstrap.js"

// Module-level workspace config, set once during init so tools can read it.
let _workspaceConfig: WorkspaceConfig | null = null
let _isSqliteBackend: boolean = false

export function setWorkspaceIntelligenceConfig(ws: WorkspaceConfig, backend: "lsp" | "graph"): void {
  _workspaceConfig = ws
  _isSqliteBackend = backend === "graph"
}

import { getDbFoundation } from "../intelligence/public-api.js"

// Re-export formatters for backward compatibility (tests import from tools/index)
export {
  formatHover,
  formatDefinition,
  formatReferences,
  formatDocumentSymbol,
  formatWorkspaceSymbol,
  formatIncomingCalls,
  formatOutgoingCalls,
  formatTypeHierarchy,
  formatDiagnostics,
  formatCodeAction,
  formatDocumentHighlight,
  formatFoldingRange,
  formatSignatureHelp,
  formatRename,
  formatFormat,
  formatInlayHints,
  formatReasonChain,
  formatIntelligenceResponse,
} from "./formatters.js"

export const TOOLS: ToolDef[] = [
  {
    name: "backend_health",
    description:
      "Return unified backend health/status for this workspace: daemon state, preflight policy/result, and index readiness.",
    inputSchema: z.object({}),
    execute: async (_args, client, tracker) => {
      const clean = configLoader.readConfig(client.root).compileCommandsCleaning ?? {}
      const workspaceId = computeWorkspaceId(client.root)
      const preflight = getPreflightResult(client.root) ?? {}

      const lines = [
        `workspace: ${client.root}`,
        `workspaceId: ${workspaceId}`,
        `indexReady: ${tracker.state.isReady}`,
        `daemonBridgePid: ${getDaemonBridgePid(client.root) ?? "unknown"}`,
        `daemonPort: ${getDaemonPort(client.root) ?? "unknown"}`,
        `httpPid: ${getHttpDaemonPid(client.root) ?? "unknown"}`,
        `httpPort: ${getHttpDaemonPort(client.root) ?? "unknown"}`,
        `preflightOk: ${preflight.preflightOk ?? "unknown"}`,
        `unmatchedPatchCount: ${preflight.unmatchedPatchCount ?? "unknown"}`,
        `requireZeroUnmatched: ${preflight.requireZeroUnmatched ?? "unknown"}`,
        `preflightPolicy: ${preflight.preflightPolicy ?? "unknown"}`,
        `externalEntryCount: ${preflight.externalEntryCount ?? "unknown"}`,
        `remappedExternalCount: ${preflight.remappedExternalCount ?? "unknown"}`,
        `removedExternalCount: ${preflight.removedExternalCount ?? "unknown"}`,
        `preflightRanAt: ${preflight.ranAt ?? "unknown"}`,
        `indirectCallerCacheHits: ${INDIRECT_CALLER_TELEMETRY.cacheHits}`,
        `indirectCallerInflightDedupReuses: ${INDIRECT_CALLER_TELEMETRY.inflightDedupReuses}`,
        `indirectCallerFreshComputes: ${INDIRECT_CALLER_TELEMETRY.freshComputes}`,
      ]
      return lines.join("\n")
    },
  },

  // ── lsp_hover ──────────────────────────────────────────────────────────────
  {
    name: "lsp_hover",
    description: "Get type information, documentation, and signature for the symbol at the given position.",
    inputSchema: positionSchema,
    execute: async (args, client, tracker) =>
      withFile(client, args.file, async () => {
        const result = await client.hover(args.file, args.line - 1, args.character - 1)
        return formatHover(result) + tracker.statusSuffix() + tracker.fileSuffix(args.file)
      }),
  },

  // ── lsp_definition ────────────────────────────────────────────────────────
  {
    name: "lsp_definition",
    description:
      "Jump to the implementation/definition of the symbol. " +
      "For a function declared in a .h file, this jumps to the .c/.cpp body. " +
      "Use lsp_declaration to jump to the .h prototype instead.",
    inputSchema: positionSchema,
    execute: async (args, client, tracker) =>
      withFile(client, args.file, async () => {
        const results = await client.definition(args.file, args.line - 1, args.character - 1)
        return formatDefinition(results, client.root) + tracker.statusSuffix()
      }),
  },

  // ── lsp_declaration ───────────────────────────────────────────────────────
  {
    name: "lsp_declaration",
    description:
      "Jump to the forward declaration of the symbol (e.g. the prototype in a .h header file). " +
      "Distinct from lsp_definition which jumps to the implementation body.",
    inputSchema: positionSchema,
    execute: async (args, client, tracker) =>
      withFile(client, args.file, async () => {
        const results = await client.declaration(args.file, args.line - 1, args.character - 1)
        return formatDefinition(results, client.root, "Declaration") + tracker.statusSuffix()
      }),
  },

  // ── lsp_type_definition ───────────────────────────────────────────────────
  {
    name: "lsp_type_definition",
    description:
      "Jump to the type definition of the symbol under the cursor. " +
      "For a variable 'wlan_vdev_t *vdev', this jumps to 'struct wlan_vdev_t { ... }'. " +
      "Useful for navigating typedef chains and struct definitions.",
    inputSchema: positionSchema,
    execute: async (args, client, tracker) =>
      withFile(client, args.file, async () => {
        const results = await client.typeDefinition(args.file, args.line - 1, args.character - 1)
        return formatDefinition(results, client.root, "Type definition") + tracker.statusSuffix()
      }),
  },

  // ── lsp_references ────────────────────────────────────────────────────────
  {
    name: "lsp_references",
    description: "Find all references to the symbol at the given position across the workspace.",
    inputSchema: positionSchema,
    execute: async (args, client, tracker) =>
      withFile(client, args.file, async () => {
        const results = await client.references(args.file, args.line - 1, args.character - 1)
        return formatReferences(results, client.root) + tracker.statusSuffix()
      }),
  },

  // ── lsp_implementation ────────────────────────────────────────────────────
  {
    name: "lsp_implementation",
    description: "Find implementations of a virtual function or interface method.",
    inputSchema: positionSchema,
    execute: async (args, client, tracker) =>
      withFile(client, args.file, async () => {
        const results = await client.implementation(args.file, args.line - 1, args.character - 1)
        return formatDefinition(results, client.root, "Implementation") + tracker.statusSuffix()
      }),
  },

  // ── lsp_document_highlight ────────────────────────────────────────────────
  {
    name: "lsp_document_highlight",
    description:
      "Find all occurrences of the symbol within the current file, tagged as read/write/text. " +
      "Faster than lsp_references for local variable analysis within a single file.",
    inputSchema: positionSchema,
    execute: async (args, client, tracker) =>
      withFile(client, args.file, async () => {
        const results = await client.documentHighlight(args.file, args.line - 1, args.character - 1)
        return formatDocumentHighlight(results, args.file, client.root) + tracker.fileSuffix(args.file)
      }),
  },

  // ── lsp_document_symbol ───────────────────────────────────────────────────
  {
    name: "lsp_document_symbol",
    description:
      "List all symbols (functions, structs, variables, enums, etc.) defined in a file. " +
      "Use this to get a structural outline before reading the file.",
    inputSchema: fileOnlySchema,
    execute: async (args, client, tracker) =>
      withFile(client, args.file, async () => {
        const results = await client.documentSymbol(args.file)
        return formatDocumentSymbol(results) + tracker.statusSuffix()
      }),
  },

  // ── lsp_workspace_symbol ──────────────────────────────────────────────────
  {
    name: "lsp_workspace_symbol",
    description: "Search for symbols by name across the entire workspace index.",
    inputSchema: z.object({
      query: z.string().describe("Symbol name or prefix to search for"),
    }),
    execute: async (args, client, tracker) => {
      const results = await client.workspaceSymbol(args.query)
      return formatWorkspaceSymbol(results, client.root) + tracker.statusSuffix()
    },
  },

  // ── lsp_folding_range ─────────────────────────────────────────────────────
  {
    name: "lsp_folding_range",
    description:
      "Get all foldable regions in a file: functions, #ifdef blocks, comment blocks, etc. " +
      "Use this to understand the high-level structure of a large file without reading it fully.",
    inputSchema: fileOnlySchema,
    execute: async (args, client, tracker) =>
      withFile(client, args.file, async () => {
        const results = await client.foldingRange(args.file)
        return formatFoldingRange(results, args.file, client.root) + tracker.fileSuffix(args.file)
      }),
  },

  // ── lsp_signature_help ────────────────────────────────────────────────────
  {
    name: "lsp_signature_help",
    description:
      "Get the signature of the function being called at the cursor position, " +
      "with the active parameter highlighted. Use this when the cursor is inside a function call's argument list.",
    inputSchema: positionSchema,
    execute: async (args, client, tracker) =>
      withFile(client, args.file, async () => {
        const result = await client.signatureHelp(args.file, args.line - 1, args.character - 1)
        return formatSignatureHelp(result) + tracker.fileSuffix(args.file)
      }),
  },

  // ── lsp_incoming_calls ────────────────────────────────────────────────────
  {
    name: "lsp_incoming_calls",
    description: "Find all direct callers of the function at the given position (who calls this?).",
    inputSchema: incomingCallSchema,
    execute: async (args, client, tracker) =>
      withFile(client, args.file, async () => {
        const results = await client.incomingCalls(args.file, args.line - 1, args.character - 1)
        return formatIncomingCalls(results, client.root) + tracker.statusSuffix()
      }),
  },

  {
    name: "lsp_indirect_callers",
    description:
      "Collect raw LSP evidence for indirect callers of the function at the given position. " +
      "Uses incomingCalls first; falls back to references+prepareCallHierarchy for fn-ptr callbacks. " +
      "Returns the enclosing functions at all reference sites. " +
      "For the full invocation reason (WHY it is called), use lsp_reason_chain instead.",
    inputSchema: positionSchema.extend({
      maxNodes: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(50)
        .optional()
        .describe("Maximum reference sites to return (default: 50)"),
      resolve: z
        .boolean()
        .default(false)
        .optional()
        .describe(
          "If true, resolve full registration→store→dispatch→trigger chain using clangd (slower, more precise)",
        ),
    }),
    execute: async (args, client, tracker) =>
      withFile(client, args.file, async () => {
        const backend = unifiedBackendOrThrow()
        // Check cache first
        const cacheKey = backend.indirectCallerCache.computeKey(args.file, args.line, args.character)
        const cached = backend.indirectCallerCache.read(client.root, cacheKey, [args.file])
        if (cached) {
          INDIRECT_CALLER_TELEMETRY.cacheHits += 1
          const graph = cached.result
          return (
            backend.patterns.formatIndirectCallerTree(graph, client.root) +
            tracker.statusSuffix() +
            `\n\n[cache: hit — cached at ${cached.cachedAt}]`
          )
        }

        const inflightKey = inflightIndirectCallerKey(client.root, cacheKey)
        const existingInflight = INFLIGHT_INDIRECT_CALLERS.get(inflightKey)
        if (existingInflight) {
          INDIRECT_CALLER_TELEMETRY.inflightDedupReuses += 1
          const graph = await existingInflight
          return (
            backend.patterns.formatIndirectCallerTree(graph, client.root) +
            tracker.statusSuffix() +
            `\n\n[dedup: shared in-flight result]`
          )
        }

        // Cache miss — compute fresh
        const computePromise = backend.patterns.collectIndirectCallers(client, args)
        INFLIGHT_INDIRECT_CALLERS.set(inflightKey, computePromise)
        try {
          INDIRECT_CALLER_TELEMETRY.freshComputes += 1
          const graph = await computePromise

          // Store in cache (best-effort, don't fail the tool if cache write fails)
          try {
            backend.indirectCallerCache.write(client.root, cacheKey, graph, [args.file])
          } catch {
            /* ignore cache write errors */
          }

          return backend.patterns.formatIndirectCallerTree(graph, client.root) + tracker.statusSuffix()
        } finally {
          INFLIGHT_INDIRECT_CALLERS.delete(inflightKey)
        }
      }),
  },

  {
    name: "lsp_reason_chain",
    description:
      "Answer 'Why is this function invoked at runtime?' for the API at a given position. " +
      "Returns the full invocation reason: the external event (Layer C), the dispatch chain " +
      "from that event to the target (Layer B), and the registration gate that wired it in (Layer A). " +
      "Uses a cache+LLM pipeline: cache hit returns instantly; cache miss triggers LLM reasoning " +
      "with tool-calling (read_file, search_code, lsp_incoming_calls) guided by reasoning rules. " +
      "Requires llmReasoning to be enabled in the workspace config (.intelgraph.json).",
    inputSchema: positionSchema.extend({
      targetSymbol: z.string().optional().describe("Optional override target symbol name"),
      suspectedPatterns: z.array(z.string()).optional().describe("Optional pattern hints for difficult indirect flows"),
      workspaceRoot: z.string().optional().describe("Optional workspace root override for LLM tools and DB cache"),
    }),
    execute: async (args, client, tracker) =>
      withFile(client, args.file, async () => {
        const backend = unifiedBackendOrThrow()
        const log = loggerPort
        const reasoningConfig = readReasoningConfig(client.root)
        const prepared = await prepareReasonQuery(backend, client, args)
        const symbol = prepared.symbol

        log.info("lsp_reason_chain: prepared target", {
          file: args.file,
          line: args.line,
          character: args.character,
          argTargetSymbol: args.targetSymbol,
          seedSymbol: prepared.graph.seed?.name,
          resolvedSymbol: symbol,
          evidenceNodes: prepared.graph.nodes.length,
        })

        const result = await backend.reasonEngine.run(
          client,
          {
            targetSymbol: symbol,
            targetFile: args.file,
            targetLine: args.line,
            knownEvidence: prepared.knownEvidence,
            suspectedPatterns: args.suspectedPatterns ?? [],
            workspaceRoot: args.workspaceRoot,
          },
          reasoningConfig,
        )

        log.info("lsp_reason_chain: reason engine result", {
          symbol,
          cacheHit: result.cacheHit,
          usedLlm: result.usedLlm,
          reasonPaths: result.reasonPaths.length,
          rejected: result.rejected,
          staleFiles: result.cacheMismatchedFiles.length,
        })

        return formatReasonChain(result, symbol, args.file, client.root) + "\n" + tracker.statusSuffix()
      }),
  },

  {
    name: "lsp_runtime_flow",
    description:
      "Return structured invoker-centric runtime flow JSON for the API at a given position. " +
      "Primary fields: targetApi, runtimeTrigger, dispatchChain, dispatchSite, immediateInvoker. " +
      "Registration fields are supporting context only.",
    inputSchema: positionSchema.extend({
      targetSymbol: z.string().optional().describe("Optional override target symbol name"),
      suspectedPatterns: z.array(z.string()).optional().describe("Optional pattern hints for difficult indirect flows"),
      workspaceRoot: z.string().optional().describe("Optional workspace root override for DB cache"),
    }),
    execute: async (args, client, tracker) =>
      withFile(client, args.file, async () => {
        const backend = unifiedBackendOrThrow()
        const reasoningConfig = readReasoningConfig(client.root)
        const prepared = await prepareReasonQuery(backend, client, args)
        const symbol = prepared.symbol

        const result = await backend.reasonEngine.run(
          client,
          {
            targetSymbol: symbol,
            targetFile: args.file,
            targetLine: args.line,
            knownEvidence: prepared.knownEvidence,
            suspectedPatterns: args.suspectedPatterns ?? [],
            workspaceRoot: args.workspaceRoot,
          },
          reasoningConfig,
        )

        const payload = buildRuntimeFlowPayload(symbol, result)

        return JSON.stringify(payload, null, 2) + tracker.statusSuffix()
      }),
  },

  // ── lsp_outgoing_calls ────────────────────────────────────────────────────
  {
    name: "lsp_outgoing_calls",
    description: "Find all functions called by the function at the given position (what does this call?).",
    inputSchema: positionSchema,
    execute: async (args, client, tracker) =>
      withFile(client, args.file, async () => {
        const results = await client.outgoingCalls(args.file, args.line - 1, args.character - 1)
        return formatOutgoingCalls(results, client.root) + tracker.statusSuffix()
      }),
  },

  // ── lsp_supertypes ────────────────────────────────────────────────────────
  {
    name: "lsp_supertypes",
    description:
      "Find the base types / parent classes of the type at the given position. " + "Navigates up the type hierarchy.",
    inputSchema: positionSchema,
    execute: async (args, client, tracker) =>
      withFile(client, args.file, async () => {
        const results = await client.supertypes(args.file, args.line - 1, args.character - 1)
        return formatTypeHierarchy(results, client.root, "↑") + tracker.statusSuffix()
      }),
  },

  // ── lsp_subtypes ──────────────────────────────────────────────────────────
  {
    name: "lsp_subtypes",
    description:
      "Find all derived types / child classes of the type at the given position. " +
      "Navigates down the type hierarchy.",
    inputSchema: positionSchema,
    execute: async (args, client, tracker) =>
      withFile(client, args.file, async () => {
        const results = await client.subtypes(args.file, args.line - 1, args.character - 1)
        return formatTypeHierarchy(results, client.root, "↓") + tracker.statusSuffix()
      }),
  },

  // ── lsp_rename ────────────────────────────────────────────────────────────
  {
    name: "lsp_rename",
    description:
      "Show all locations that would change when renaming the symbol at the given position. " +
      "Returns a full change manifest (file + line + new text) across the workspace. " +
      "Review the output before making any edits.",
    inputSchema: positionSchema.extend({
      newName: z.string().describe("The new name for the symbol"),
    }),
    execute: async (args, client, tracker) =>
      withFile(client, args.file, async () => {
        // First check rename is valid at this position
        const prep = await client.prepareRename(args.file, args.line - 1, args.character - 1)
        if (!prep) return "Rename not possible at this position (not a renameable symbol)."
        const edit = await client.rename(args.file, args.line - 1, args.character - 1, args.newName)
        return formatRename(edit, client.root) + tracker.statusSuffix()
      }),
  },

  // ── lsp_format ────────────────────────────────────────────────────────────
  {
    name: "lsp_format",
    description:
      "Get clang-format formatting edits for a file or a line range. " +
      "Returns the list of text edits needed — does NOT modify the file. " +
      "Apply the edits yourself after reviewing them.",
    inputSchema: fileOnlySchema.extend({
      startLine: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Start line for range formatting (1-based, omit for whole file)"),
      endLine: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("End line for range formatting (1-based, omit for whole file)"),
    }),
    execute: async (args, client, tracker) =>
      withFile(client, args.file, async () => {
        let edits: any[]
        if (args.startLine != null && args.endLine != null) {
          edits = await client.rangeFormatting(args.file, args.startLine - 1, 0, args.endLine - 1, 9999)
        } else {
          edits = await client.formatting(args.file)
        }
        return formatFormat(edits, args.file, client.root) + tracker.fileSuffix(args.file)
      }),
  },

  // ── lsp_inlay_hints ───────────────────────────────────────────────────────
  {
    name: "lsp_inlay_hints",
    description:
      "Get inlay hints for a range of lines: inferred types for 'auto' variables, " +
      "parameter names at call sites, and return type annotations. " +
      "Extremely useful for understanding macro-heavy or template-heavy code.",
    inputSchema: fileOnlySchema.extend({
      startLine: z.number().int().min(1).describe("First line of the range (1-based)"),
      endLine: z.number().int().min(1).describe("Last line of the range (1-based)"),
    }),
    execute: async (args, client, tracker) =>
      withFile(client, args.file, async () => {
        const hints = await client.inlayHints(args.file, args.startLine - 1, args.endLine - 1)
        return formatInlayHints(hints, args.file, client.root) + tracker.fileSuffix(args.file)
      }),
  },

  // ── lsp_diagnostics ───────────────────────────────────────────────────────
  {
    name: "lsp_diagnostics",
    description: "Get compiler errors and warnings. Optionally limit to a specific file.",
    inputSchema: z.object({
      file: z.string().optional().describe("Optional: limit diagnostics to this file path"),
    }),
    execute: async (args, client, tracker) => {
      if (args.file) {
        await withFile(client, args.file, async () => "")
        await new Promise((r) => setTimeout(r, 500))
        const diags = client.getDiagnostics(args.file)
        const map = new Map([[args.file, diags]])
        return formatDiagnostics(map, client.root) + tracker.statusSuffix()
      }
      const map = client.getDiagnostics()
      return formatDiagnostics(map, client.root) + tracker.statusSuffix()
    },
  },

  // ── lsp_code_action ───────────────────────────────────────────────────────
  {
    name: "lsp_code_action",
    description: "Get available code actions (quick fixes, refactors) at the given position.",
    inputSchema: positionSchema,
    execute: async (args, client, tracker) =>
      withFile(client, args.file, async () => {
        const results = await client.codeAction(args.file, args.line - 1, args.character - 1)
        return formatCodeAction(results) + tracker.statusSuffix()
      }),
  },

  // ── lsp_file_status ───────────────────────────────────────────────────────
  {
    name: "lsp_file_status",
    description:
      "Get the current parse state of a specific file as reported by clangd. " +
      "States: idle (ready), queued, parsing, building preamble, building AST, indexing. " +
      "Use this to check if a file is ready before querying it.",
    inputSchema: fileOnlySchema,
    execute: async (args, _client, tracker) => {
      const state = tracker.fileState(args.file)
      if (!state) return `${args.file}: unknown (not yet opened or no status received)`
      return `${args.file}: ${state}`
    },
  },

  // ── intelligence_backend_info ────────────────────────────────────────────
  // Returns the workspace intelligence backend kind so the TUI can route
  // symbol resolution and caller queries to the right backend.
  {
    name: "intelligence_backend_info",
    description:
      "Returns the workspace intelligence backend configuration. " +
      "The 'backend' field is either 'lsp' (clangd, for C/C++) or 'graph' (SQLite, for TS/Rust). " +
      "The TUI uses this to decide whether to call lsp_hover/get_callers or intelligence_query.",
    inputSchema: z.object({}),
    execute: async () => {
      const ws = _workspaceConfig ?? {}
      return JSON.stringify({
        backend: _isSqliteBackend ? "graph" : "lsp",
        language: ws.language ?? "c",
        hasSnapshot: Boolean(getIntelligenceDeps()),
      })
    },
  },

  // ── lsp_index_status ──────────────────────────────────────────────────────
  {
    name: "lsp_index_status",
    description:
      "Query the current clangd background index status and per-file parse states. " +
      "Run this first to check if cross-file results will be complete.",
    inputSchema: z.object({}),
    execute: async (_args, client, tracker) => {
      const state = tracker.state
      const info = await client.serverInfo()
      const lines = [
        `Index ready:  ${state.isReady}`,
        `Progress:     ${state.percentage}%`,
        `Status:       ${state.message}`,
        `Updated:      ${state.updatedAt}`,
      ]

      // Per-file states (only non-idle)
      const busy = [...tracker.fileStates.entries()].filter(([, s]) => s !== "idle")
      if (busy.length) {
        lines.push("", `Active files (${busy.length}):`)
        for (const [f, s] of busy) {
          lines.push(`  ${s.padEnd(20)} ${f}`)
        }
      }

      // Structured clangd info
      if (info) {
        const bg = info.background_index_stats
        if (bg) {
          lines.push("", "Background index stats:")
          lines.push(`  Completed: ${bg.completed ?? "?"}`)
          lines.push(`  Total:     ${bg.total ?? "?"}`)
          lines.push(`  Queue:     ${bg.queue_size ?? bg.queued ?? "?"}`)
        }
        const mem = info.memory_usage
        if (mem) {
          lines.push("", "Memory usage:")
          for (const [k, v] of Object.entries(mem)) {
            lines.push(`  ${k}: ${v}`)
          }
        }
      }

      return lines.join("\n")
    },
  },

  // ── get_callers — unified single-endpoint caller resolution ───────────────
  {
    name: "get_callers",
    description:
      "Unified single-endpoint caller resolution. Runs the full waterfall internally and returns " +
      "a single structured JSON response — no need to orchestrate multiple tools.\n\n" +
      "Waterfall (highest quality first):\n" +
      "  1. lsp_runtime_flow      — LLM/cache runtime invoker (best, needs LLM config)\n" +
      "  2. who_calls_api_at_runtime — DB runtime graph (needs intelligence snapshot)\n" +
      "  3. who_calls_api         — DB static graph (needs intelligence snapshot)\n" +
      "  4. lsp_indirect_callers  — LSP + C parser dispatch chain (resolve:true)\n" +
      "  5. lsp_incoming_calls    — Direct callers only (always available)\n\n" +
      "Name-alias handling: DB queries are tried with canonical name AND common C firmware " +
      "alias variants (_foo, __foo, foo___RAM, _foo___RAM) so renamed symbols are found.\n\n" +
      "Response: JSON with targetApi, callers[], source (which step succeeded), and provenance.",
    inputSchema: positionSchema.extend({
      snapshotId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Intelligence snapshot ID (enables DB-backed caller lookup)"),
      maxNodes: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(50)
        .optional()
        .describe("Maximum callers to return (default: 50)"),
      resolve: z
        .boolean()
        .default(true)
        .optional()
        .describe("If true (default), resolve full dispatch chain via lsp_indirect_callers for indirect callers"),
    }),
    execute: async (args, client, tracker) =>
      withFile(client, args.file, async () => {
        const backend = (() => {
          try {
            return unifiedBackendOrThrow()
          } catch {
            return null
          }
        })()
        const INTELLIGENCE_DEPS = getIntelligenceDeps()
        const result = await resolveCallers(client, tracker, backend, INTELLIGENCE_DEPS, args)
        return JSON.stringify(result, null, 2)
      }),
  },

  // ── Intelligence query tool ────────────────────────────────────────────────
  {
    name: "intelligence_query",
    description:
      "Query the code intelligence graph. Supports five capability tiers:\n\n" +
      "  RUNTIME FLOW (require a snapshot):\n" +
      "    who_calls_api_at_runtime, what_api_calls, find_api_logs, find_api_logs_by_level\n\n" +
      "  STRUCTURAL NAVIGATION (module/class/type/API graph):\n" +
      "    find_module_symbols, find_class_inheritance, find_type_fields, find_module_imports, ...\n\n" +
      "  ENTITY SUMMARIES (single-row health metrics per entity):\n" +
      "    find_module_summary, find_class_summary, find_type_summary, find_api_summary\n" +
      "    find_entity_summary  ← auto-detects kind from entity name\n\n" +
      "  CROSS-LAYER NAVIGATION (move between module/class/type/API layers):\n" +
      "    find_module_apis, find_api_type_dependencies, find_type_defining_module,\n" +
      "    find_workspace_health\n\n" +
      "  ADVANCED ANALYSIS (workspace-level insights, no apiName needed):\n" +
      "    analyze_problematic_modules  ← ranked by dead exports + coupling\n" +
      "    analyze_god_classes          ← ranked by complexity, with split recommendation\n" +
      "    analyze_type_health          ← unused / hotspot / healthy classification\n" +
      "    analyze_dead_code            ← exported APIs with no callers, orphan types\n" +
      "    suggest_refactors            ← tightly coupled module pairs to consolidate\n" +
      "    generate_health_report       ← per-module health score 0-100, sorted worst-first\n" +
      "    generate_action_plan         ← cross-layer ranked fix list (P1 dead code → P4 hotspots)\n" +
      "    compare_snapshots            ← diff health metrics; set depth=<prevSnapshotId>\n\n" +
      "Uses a DB-first approach: returns cached snapshot data instantly. " +
      "All supported intents: " +
      QUERY_INTENTS.join(", "),
    inputSchema: z.object({
      intent: z.enum(QUERY_INTENTS).describe("Query intent"),
      snapshotId: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Snapshot ID to query against (0 or omitted = latest ready snapshot)"),
      apiName: z.string().optional().describe("API/function name (required for caller/callee/dispatch/log intents)"),
      structName: z.string().optional().describe("Struct name (required for struct ownership intents)"),
      fieldName: z.string().optional().describe("Field name (required for find_field_access_path)"),
      traceId: z.string().optional().describe("Trace ID (required for show_runtime_flow_for_trace)"),
      pattern: z
        .string()
        .optional()
        .describe(
          "Log pattern (required for find_api_by_log_pattern, find_symbols_by_name, find_symbols_by_kind, find_symbols_by_doc)",
        ),
      logLevel: z
        .enum(["ERROR", "WARN", "INFO", "DEBUG", "VERBOSE", "TRACE", "UNKNOWN"])
        .optional()
        .describe(
          "Log level filter (required for find_api_logs_by_level; one of ERROR, WARN, INFO, DEBUG, VERBOSE, TRACE, UNKNOWN)",
        ),
      srcApi: z
        .string()
        .optional()
        .describe(
          "Source API or type (required for show_cross_module_path, find_call_chain, find_module_interactions, find_data_path)",
        ),
      dstApi: z
        .string()
        .optional()
        .describe(
          "Destination API or type (required for show_cross_module_path, find_call_chain, find_module_interactions, find_data_path)",
        ),
      depth: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Traversal depth limit (find_call_chain, find_data_path, find_transitive_dependencies, find_long_functions, find_import_cycles_deep). Also used as previous snapshot ID for compare_snapshots.",
        ),
      limit: z.number().int().positive().optional().describe("Result row limit"),
      filePath: z
        .string()
        .optional()
        .describe("Workspace-relative file path (required for find_symbol_at_location, find_symbols_in_file)"),
      lineNumber: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("1-based line number (required for find_symbol_at_location)"),
    }),
    execute: async (args, _client, _tracker) => {
      const INTELLIGENCE_DEPS = getIntelligenceDeps()
      if (!INTELLIGENCE_DEPS) {
        return JSON.stringify(
          queryNodeAdapter.toLegacyFlatResponse(
            queryNodeAdapter.toNodeErrorResponse({
              intent: args.intent,
              snapshotId: typeof args.snapshotId === "number" ? args.snapshotId : undefined,
              errors: ["intelligence_query: intelligence backend not initialized."],
            }),
          ),
        )
      }
      // Auto-resolve snapshotId to latest ready snapshot when 0 or absent.
      // This lets the TUI skip snapshot initialization and query directly.
      let resolvedArgs = args
      if (!args.snapshotId || args.snapshotId <= 0) {
        const dbFoundation = getDbFoundation()
        if (dbFoundation) {
          try {
            const latest = await dbFoundation.getLatestReadySnapshot(process.cwd())
            if (latest?.snapshotId) {
              resolvedArgs = { ...args, snapshotId: latest.snapshotId }
            }
          } catch {
            /* use args as-is */
          }
        }
      }
      const validated = validateQueryRequest(resolvedArgs)
      if (!validated.ok) {
        return JSON.stringify(
          queryNodeAdapter.toLegacyFlatResponse(
            queryNodeAdapter.toNodeErrorResponse({
              intent: args.intent,
              snapshotId: typeof args.snapshotId === "number" ? args.snapshotId : undefined,
              errors: validated.errors,
            }),
          ),
        )
      }
      try {
        const res = await executeOrchestratedQuery(validated.value, INTELLIGENCE_DEPS)
        const nodeProto = queryNodeAdapter.toNodeResponse(validated.value, res)
        // Emit the legacy flat format the frontend expects ({status, data:{nodes,edges}})
        // with the full NodeProtocolResponse nested under `nodeProtocol` for forward compat.
        const out = queryNodeAdapter.toLegacyFlatResponse(nodeProto)
        return JSON.stringify(out)
      } catch (err) {
        return JSON.stringify(
          queryNodeAdapter.toLegacyFlatResponse(
            queryNodeAdapter.toNodeErrorResponse({
              intent: args.intent,
              snapshotId: typeof args.snapshotId === "number" ? args.snapshotId : undefined,
              errors: [err instanceof Error ? err.message : String(err)],
            }),
          ),
        )
      }
    },
  },

  // ── Intelligence graph tool ────────────────────────────────────────────────
  // Returns the same node-link GraphJson the snapshot-stats CLI emits
  // via --graph-json / --html, but reads from the live persisted snapshot
  // instead of re-extracting. This is the one-shot way for any transport
  // client (TUI, external visualizer, codegen) to fetch the visualization
  // data without making N intelligence_query calls.
  {
    name: "intelligence_graph",
    description:
      "Return the full node-link graph for a snapshot — the same data the " +
      "snapshot-stats CLI emits via --graph-json / --html, suitable for " +
      "d3-force / cytoscape / sigma / cosmograph visualizers. Reads the live " +
      "persisted snapshot (no re-extraction). Optional edgeKinds and " +
      "symbolKinds filters subset the graph before serialization. Response " +
      "shape: { workspace, snapshot_id, nodes: [...], edges: [...] }.",
    inputSchema: z.object({
      snapshotId: z.number().int().positive().describe("Snapshot ID to read from"),
      workspaceRoot: z.string().describe("Workspace root path (echoed back in the response.workspace field)"),
      edgeKinds: z
        .array(z.string())
        .optional()
        .describe("Keep only edges whose edge_kind is in this list (e.g. ['imports','calls']). Omit for all edges."),
      symbolKinds: z
        .array(z.string())
        .optional()
        .describe(
          "Keep only nodes whose kind is in this list (e.g. ['module','class']) AND edges where both endpoints survive. Omit for all nodes.",
        ),
      centerOf: z
        .string()
        .optional()
        .describe(
          "Scope the graph to nodes within `centerHops` hops of a center symbol. Resolved exact / suffix-after-# / substring (e.g. 'Greeter.greet'). Applied AFTER kind filters.",
        ),
      centerHops: z.number().int().positive().optional().describe("Hop budget for centerOf (default 2)."),
      centerDirection: z
        .enum(["in", "out", "both"])
        .optional()
        .describe(
          "Direction the centerOf BFS walks. 'both' (default) = undirected, 'out' = what X reaches, 'in' = what reaches X.",
        ),
      maxNodes: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Cap the result to the top-N nodes by total degree. Applied LAST in the filter pipeline. Useful for big workspaces where the unfiltered graph would be too dense.",
        ),
    }),
    execute: async (args, _client, _tracker) => {
      const INTELLIGENCE_DEPS = getIntelligenceDeps()
      if (!INTELLIGENCE_DEPS) {
        return JSON.stringify({
          status: "error",
          errors: ["intelligence_graph: backend not initialized."],
        })
      }
      const lookup = INTELLIGENCE_DEPS.persistence.dbLookup
      if (typeof lookup.loadGraphJson !== "function") {
        return JSON.stringify({
          status: "error",
          errors: ["intelligence_graph: configured backend does not support graph reads (no loadGraphJson)"],
        })
      }
      try {
        const filters: {
          edgeKinds?: Set<string>
          symbolKinds?: Set<string>
          centerOf?: string
          centerHops?: number
          centerDirection?: "in" | "out" | "both"
          maxNodes?: number
        } = {}
        if (args.edgeKinds && args.edgeKinds.length > 0) {
          filters.edgeKinds = new Set(args.edgeKinds)
        }
        if (args.symbolKinds && args.symbolKinds.length > 0) {
          filters.symbolKinds = new Set(args.symbolKinds)
        }
        if (args.centerOf) filters.centerOf = args.centerOf
        if (args.centerHops) filters.centerHops = args.centerHops
        if (args.centerDirection) filters.centerDirection = args.centerDirection
        if (args.maxNodes) filters.maxNodes = args.maxNodes
        const graph = lookup.loadGraphJson(args.snapshotId, args.workspaceRoot, filters)
        return JSON.stringify(graph)
      } catch (err) {
        return JSON.stringify({
          status: "error",
          errors: [err instanceof Error ? err.message : String(err)],
        })
      }
    },
  },

  // ── Intelligence graph diff tool ───────────────────────────────────────────
  // Compare two filtered views of the same snapshot and return the
  // structural diff. The TUI uses this to answer "what does this filter
  // hide?" or "what changed when I added centerOf=Cursor?".
  {
    name: "intelligence_graph_diff",
    description:
      "Diff two filtered views of the same snapshot. Loads the graph " +
      "with filtersA and filtersB, then computes the symmetric difference " +
      "at the canonical-name + (src,dst,edge_kind) tuple level. Both filter " +
      "objects accept the same shape as intelligence_graph (edgeKinds, " +
      "symbolKinds, centerOf, centerHops, centerDirection, maxNodes). Omit " +
      "either to use the unfiltered graph as that side of the diff. Returns " +
      "a GraphDiff with sample arrays (capped at 100) and exact counts.",
    inputSchema: z.object({
      snapshotId: z.number().int().positive().describe("Snapshot ID to read from"),
      workspaceRoot: z.string().describe("Workspace root path"),
      filtersA: z
        .object({
          edgeKinds: z.array(z.string()).optional(),
          symbolKinds: z.array(z.string()).optional(),
          centerOf: z.string().optional(),
          centerHops: z.number().int().positive().optional(),
          centerDirection: z.enum(["in", "out", "both"]).optional(),
          maxNodes: z.number().int().positive().optional(),
        })
        .optional()
        .describe("First filter spec (defaults to unfiltered)"),
      filtersB: z
        .object({
          edgeKinds: z.array(z.string()).optional(),
          symbolKinds: z.array(z.string()).optional(),
          centerOf: z.string().optional(),
          centerHops: z.number().int().positive().optional(),
          centerDirection: z.enum(["in", "out", "both"]).optional(),
          maxNodes: z.number().int().positive().optional(),
        })
        .optional()
        .describe("Second filter spec (defaults to unfiltered)"),
    }),
    execute: async (args, _client, _tracker) => {
      const INTELLIGENCE_DEPS = getIntelligenceDeps()
      if (!INTELLIGENCE_DEPS) {
        return JSON.stringify({
          status: "error",
          errors: ["intelligence_graph_diff: backend not initialized."],
        })
      }
      const lookup = INTELLIGENCE_DEPS.persistence.dbLookup
      if (typeof lookup.loadGraphJson !== "function") {
        return JSON.stringify({
          status: "error",
          errors: ["intelligence_graph_diff: configured backend does not support graph reads (no loadGraphJson)"],
        })
      }
      try {
        type FilterArgs = {
          edgeKinds?: string[]
          symbolKinds?: string[]
          centerOf?: string
          centerHops?: number
          centerDirection?: "in" | "out" | "both"
          maxNodes?: number
        }
        const buildFilters = (input: FilterArgs | undefined) => {
          const f: {
            edgeKinds?: Set<string>
            symbolKinds?: Set<string>
            centerOf?: string
            centerHops?: number
            centerDirection?: "in" | "out" | "both"
            maxNodes?: number
          } = {}
          if (!input) return f
          if (input.edgeKinds && input.edgeKinds.length > 0) f.edgeKinds = new Set(input.edgeKinds)
          if (input.symbolKinds && input.symbolKinds.length > 0) f.symbolKinds = new Set(input.symbolKinds)
          if (input.centerOf) f.centerOf = input.centerOf
          if (input.centerHops) f.centerHops = input.centerHops
          if (input.centerDirection) f.centerDirection = input.centerDirection
          if (input.maxNodes) f.maxNodes = input.maxNodes
          return f
        }
        const graphA = lookup.loadGraphJson(args.snapshotId, args.workspaceRoot, buildFilters(args.filtersA))
        const graphB = lookup.loadGraphJson(args.snapshotId, args.workspaceRoot, buildFilters(args.filtersB))
        const diff = diffGraphJson(graphA, graphB)
        return JSON.stringify(diff)
      } catch (err) {
        return JSON.stringify({
          status: "error",
          errors: [err instanceof Error ? err.message : String(err)],
        })
      }
    },
  },
]
