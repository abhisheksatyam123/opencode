/**
 * dispatch.ts — Tool interface, backend singletons, and file-priming helper.
 *
 * Owns all mutable module-level state and the ToolDef contract.
 */

import { z } from "zod"
import { readFileSync } from "fs"
import type { ILanguageClient } from "../lsp/ports.js"
import type { IndexTracker } from "../tracking/index.js"
import type { UnifiedBackend } from "../backend/unified-backend.js"
import type { OrchestratorRunnerDeps } from "../intelligence/contracts/orchestrator-runner-deps.js"

/**
 * ToolDef — contract for a single tool registration.
 * Shared between src/tools/ and src/intelligence/tools/ to avoid
 * cross-boundary imports.
 */
export interface ToolDef {
  name: string
  description: string
  inputSchema: z.ZodTypeAny
  execute: (args: any, client: ILanguageClient, tracker: IndexTracker) => Promise<string>
}

// ── Module-level singletons ───────────────────────────────────────────────────

let UNIFIED_BACKEND: UnifiedBackend | null = null
export const INFLIGHT_INDIRECT_CALLERS = new Map<string, Promise<any>>()
export const INDIRECT_CALLER_TELEMETRY = {
  cacheHits: 0,
  inflightDedupReuses: 0,
  freshComputes: 0,
}

let INTELLIGENCE_DEPS: OrchestratorRunnerDeps | null = null

// ── Mutators ──────────────────────────────────────────────────────────────────

export function setUnifiedBackend(backend: UnifiedBackend): void {
  UNIFIED_BACKEND = backend
}

export function setIntelligenceDeps(deps: OrchestratorRunnerDeps): void {
  INTELLIGENCE_DEPS = deps
}

export function getIntelligenceDeps(): OrchestratorRunnerDeps | null {
  return INTELLIGENCE_DEPS
}

export function unifiedBackendOrThrow(): UnifiedBackend {
  if (!UNIFIED_BACKEND) {
    throw new Error("Unified backend not initialized")
  }
  return UNIFIED_BACKEND
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function inflightIndirectCallerKey(workspaceRoot: string, cacheKey: string): string {
  return `${workspaceRoot}::${cacheKey}`
}

export async function withFile(
  client: ILanguageClient,
  filePath: string,
  fn: () => Promise<string>,
): Promise<string> {
  try {
    const text = readFileSync(filePath, "utf8")
    const isFirstOpen = await client.openFile(filePath, text)
    if (isFirstOpen) await new Promise((r) => setTimeout(r, 300))
  } catch {
    // Proceed anyway — the language server may already have it indexed.
  }
  return fn()
}

// ── IToolDispatcher binding ──────────────────────────────────────────────────
//
// Real-implementation binding for the port declared in ./ports.ts.
// Consumers that want DI depend on IToolDispatcher; the composition
// root (or tests with FakeToolDispatcher) injects a concrete.

import type { IToolDispatcher } from "./ports.js"

export const toolDispatcher: IToolDispatcher = {
  setUnifiedBackend,
  setIntelligenceDeps,
  getIntelligenceDeps,
  unifiedBackendOrThrow,
  inflightIndirectCallerKey,
  withFile,
}
