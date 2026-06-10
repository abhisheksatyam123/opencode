import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { generateText, tool } from "ai"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { execSync, execFileSync } from "node:child_process"
import type { ILanguageClient } from "../../lsp/ports.js"
import { z } from "zod"
import type { ILogger } from "../../logging/ports.js"
import { getLogger, loggerPort } from "../../logging/logger.js"
import { createRipgrepService } from "../../intelligence/public-api.js"
import type { RipgrepService } from "../../intelligence/public-api.js"

/**
 * Bypass self-signed certificate errors for the duration of a callback.
 *
 * The Vercel AI SDK calls `globalThis.fetch` directly. Corporate endpoints like
 * QPILOT use internal CAs not trusted by Node's default bundle. We temporarily
 * set NODE_TLS_REJECT_UNAUTHORIZED=0 for the callback, then restore.
 */
async function withTlsPermissiveFetch<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"

  try {
    return await fn()
  } finally {
    if (prev === undefined) {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    } else {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev
    }
  }
}

export interface LlmReasoningConfig {
  enabled: boolean
  baseURL: string
  model: string
  /** Optional ordered fallback models when primary model is unavailable. */
  fallbackModels?: string[]
  apiKeyEnv: string
  /** Max LLM tool-call steps per query. Default 8 — enough for a full 5-step investigation. */
  maxCallsPerQuery: number
  /** Max attempts per model candidate for transient failures (rate limits/network). */
  maxAttemptsPerModel?: number
  /** Base backoff delay in ms for transient retry loop. */
  backoffBaseMs?: number
  /** Maximum backoff delay cap in ms. */
  backoffMaxMs?: number
  ruleFile?: string
}

export function isTransientLlmError(message: string): boolean {
  return /rate limit|429|timeout|timed out|etimedout|econnreset|enotfound|socket hang up|temporar/i.test(message)
}

export function computeBackoffDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  const exp = Math.max(0, attempt - 1)
  return Math.min(maxMs, baseMs * Math.pow(2, exp))
}

async function sleepMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * OpenAI-compatible providers in Vercel AI SDK expect a model id string scoped
 * to the provider instance (for example: "anthropic::claude-4-6-sonnet").
 *
 * Some caller configs pass an OpenCode-style fully-qualified id
 * (for example: "qpilot/anthropic::claude-4-6-sonnet"). In that form,
 * AI SDK can treat the left side as an external provider namespace and reject
 * the call with "Unsupported external provider".
 */
export function normalizeModelIdForOpenAICompatible(model: string): string {
  if (!model) return model
  const idx = model.indexOf("/")
  if (idx <= 0) return model
  return model.slice(idx + 1)
}

export interface LlmToolContext {
  client: ILanguageClient
  workspaceRoot: string
}

export interface ReasonProposalRequest {
  targetSymbol: string
  targetFile: string
  targetLine: number
  knownEvidence: Array<{ file: string; line: number; text: string }>
  suspectedPatterns: string[]
}

export interface ProposedReasonPath {
  registrarFn?: string
  registrationApi?: string
  storageFieldPath?: string
  dispatchPattern?: string
  gates?: string[]
  invocationReason?: {
    runtimeTrigger: string
    dispatchChain: string[]
    dispatchSite: { file: string; line: number; snippet: string }
    registrationGate: {
      registrarFn: string
      registrationApi: string
      conditions: string[]
    }
  }
  requiredFiles: string[]
  confidence: number
  rationale: string
}

export interface ReasonProposalResponse {
  proposedPaths: ProposedReasonPath[]
  openQuestions?: string[]
}

function normalizeProposalResponse(
  parsed: ReasonProposalResponse,
  req: ReasonProposalRequest,
  workspaceRoot?: string,
): ReasonProposalResponse {
  const normalizeOne = (p: ProposedReasonPath): ProposedReasonPath => {
    const dispatchFile = p.invocationReason?.dispatchSite?.file || req.targetFile
    const dispatchLine = p.invocationReason?.dispatchSite?.line || req.targetLine
    const sourceSnippet = req.knownEvidence[0]?.text || req.targetSymbol

    const registrationGate = {
      registrarFn: p.invocationReason?.registrationGate?.registrarFn || p.registrarFn || "(unknown-registrar)",
      registrationApi:
        p.invocationReason?.registrationGate?.registrationApi || p.registrationApi || "(unknown-registration-api)",
      conditions: p.invocationReason?.registrationGate?.conditions?.length
        ? p.invocationReason.registrationGate.conditions
        : p.gates && p.gates.length
          ? p.gates
          : ["dispatch conditions unresolved"],
    }

    const invocationReason = p.invocationReason ?? {
      runtimeTrigger: "Runtime trigger inferred from registration/dispatch evidence; confirm upstream event chain.",
      dispatchChain: [registrationGate.registrarFn, req.targetSymbol],
      dispatchSite: {
        file: dispatchFile,
        line: dispatchLine,
        snippet: p.storageFieldPath || sourceSnippet,
      },
      registrationGate,
    }

    const requiredFiles = Array.from(
      new Set([...(p.requiredFiles ?? []), req.targetFile, invocationReason.dispatchSite.file].filter(Boolean)),
    )

    return {
      ...p,
      confidence: Math.max(p.confidence ?? 0, 0.55),
      invocationReason: {
        ...invocationReason,
        registrationGate,
        dispatchChain:
          invocationReason.dispatchChain?.length >= 2
            ? invocationReason.dispatchChain
            : [registrationGate.registrarFn, req.targetSymbol],
        dispatchSite: {
          file: invocationReason.dispatchSite?.file || req.targetFile,
          line: invocationReason.dispatchSite?.line || req.targetLine,
          snippet: invocationReason.dispatchSite?.snippet || sourceSnippet,
        },
      },
      requiredFiles,
    } as ProposedReasonPath
  }

  const normalizedPaths = (parsed.proposedPaths ?? []).map(normalizeOne)

  // Deterministic rescue path: if model returns valid JSON envelope but no paths,
  // synthesize one minimal proposal from known evidence so downstream validator
  // and cache flow remain stable under partial model outputs.
  if (normalizedPaths.length === 0) {
    const firstEvidence = req.knownEvidence[0]
    const derived =
      deriveRegistrarFromTargetFile(req.targetFile, req.targetSymbol) ||
      (workspaceRoot ? deriveRegistrarFromWorkspace(workspaceRoot, req.targetSymbol) : null)
    const evidenceLine = firstEvidence?.text ?? req.targetSymbol
    const registrationApi =
      derived?.registrationApi ?? extractLikelyApiName(evidenceLine) ?? "(unknown-registration-api)"
    const registrarFn = derived?.registrarFn ?? "(evidence-derived-registrar)"
    const synthetic: ProposedReasonPath = {
      registrarFn,
      registrationApi,
      storageFieldPath: derived?.snippet ?? evidenceLine,
      dispatchPattern: "other",
      gates: ["dispatch conditions unresolved"],
      invocationReason: {
        runtimeTrigger: "Runtime trigger inferred from deterministic evidence rescue; verify upstream event chain.",
        dispatchChain: [registrarFn, req.targetSymbol],
        dispatchSite: {
          file: derived?.file || firstEvidence?.file || req.targetFile,
          line: derived?.line || firstEvidence?.line || req.targetLine,
          snippet: derived?.snippet || evidenceLine,
        },
        registrationGate: {
          registrarFn,
          registrationApi,
          conditions: ["dispatch conditions unresolved"],
        },
      },
      requiredFiles: [derived?.file || firstEvidence?.file || req.targetFile],
      confidence: 0.55,
      rationale: "Deterministic rescue path synthesized from known evidence after empty LLM proposal set.",
    }
    return {
      proposedPaths: [normalizeOne(synthetic)],
      openQuestions: parsed.openQuestions ?? [],
    }
  }

  return {
    proposedPaths: normalizedPaths,
    openQuestions: parsed.openQuestions ?? [],
  }
}

function extractLikelyApiName(text: string): string | null {
  const m = text.match(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/)
  return m?.[1] ?? null
}

function deriveRegistrarFromTargetFile(
  filePath: string,
  targetSymbol: string,
): { registrarFn: string; registrationApi: string; file: string; line: number; snippet: string } | null {
  try {
    const text = readFileSync(filePath, "utf8")
    const lines = text.split(/\r?\n/)
    const targetPattern = new RegExp(`\\b${escapeRegex(targetSymbol)}\\b`)

    const readStmt = (start: number): { text: string; end: number } => {
      let out = ""
      let end = start
      for (let k = start; k < Math.min(lines.length, start + 8); k += 1) {
        out += (out ? " " : "") + (lines[k] ?? "").trim()
        end = k
        if ((lines[k] ?? "").includes(";")) break
      }
      return { text: out, end }
    }

    for (let i = 0; i < lines.length; i += 1) {
      const stmt = readStmt(i)
      if (!targetPattern.test(stmt.text)) continue
      const registrationApi = extractLikelyApiName(stmt.text)
      if (!registrationApi || registrationApi === targetSymbol) continue
      const registrarFn = findEnclosingFunctionName(lines, i)
      if (!registrarFn || registrarFn === targetSymbol) continue
      return {
        registrarFn,
        registrationApi,
        file: filePath,
        line: i + 1,
        snippet: stmt.text.slice(0, 200),
      }
    }
  } catch {
    return null
  }
  return null
}

function deriveRegistrarFromWorkspace(
  workspaceRoot: string,
  targetSymbol: string,
): { registrarFn: string; registrationApi: string; file: string; line: number; snippet: string } | null {
  // Migrated to RipgrepService in Step 8 of the plugin extractor
  // infrastructure rollout. The previous implementation shelled out to
  // `rg --json` directly; the service centralizes that pattern with
  // typed RipgrepMatch results, glob defaults, and graceful handling
  // of "rg not on PATH".
  const candidates: Array<{
    registrarFn: string
    registrationApi: string
    file: string
    line: number
    snippet: string
  }> = []
  try {
    const rg: RipgrepService = createRipgrepService(workspaceRoot)
    const matches = rg.search(targetSymbol, {
      glob: "*.{c,h}",
      maxCount: 200,
      timeoutMs: 15000,
    })
    for (const match of matches) {
      const hit = deriveRegistrarFromFileAtHint(match.filePath, targetSymbol, match.line)
      if (hit) candidates.push(hit)
    }
  } catch {
    // RipgrepUnavailable falls through here, matching the previous
    // try/catch behavior of returning null when rg is missing.
    return null
  }
  if (!candidates.length) return null

  candidates.sort((a, b) => scoreRegistrarCandidate(b) - scoreRegistrarCandidate(a))
  return candidates[0]
}

export function scoreRegistrarCandidate(c: { registrarFn: string; registrationApi: string; file: string }): number {
  let score = 0
  const fileLower = c.file.toLowerCase()
  const fnLower = c.registrarFn.toLowerCase()
  const apiLower = c.registrationApi.toLowerCase()

  // Prefer production code paths over tests/mocks.
  if (/test|mock|stub/.test(fileLower)) score -= 50
  else score += 20

  if (/test|mock|stub/.test(fnLower)) score -= 40
  if (/enable|register|attach|init/.test(fnLower)) score += 25

  if (/register|deregister/.test(apiLower)) score += 20
  if (/offload/.test(apiLower)) score += 10

  return score
}

function deriveRegistrarFromFileAtHint(
  filePath: string,
  targetSymbol: string,
  hintLine: number,
): { registrarFn: string; registrationApi: string; file: string; line: number; snippet: string } | null {
  try {
    const text = readFileSync(filePath, "utf8")
    const lines = text.split(/\r?\n/)
    const i = Math.max(0, Math.min(lines.length - 1, hintLine - 1))
    const stmtStart = Math.max(0, i - 3)
    const stmtEnd = Math.min(lines.length - 1, i + 3)
    const stmt = lines.slice(stmtStart, stmtEnd + 1).join(" ")
    if (!new RegExp(`\\b${escapeRegex(targetSymbol)}\\b`).test(stmt)) return null
    if (stmt.includes(`${targetSymbol}(`)) return null
    const registrationApi = extractLikelyApiName(stmt)
    if (!registrationApi) return null
    const registrarFn = findEnclosingFunctionName(lines, i)
    if (!registrarFn || registrarFn === targetSymbol) return null
    return {
      registrarFn,
      registrationApi,
      file: filePath,
      line: stmtStart + 1,
      snippet: stmt.trim().slice(0, 200),
    }
  } catch {
    return null
  }
}

function findEnclosingFunctionName(lines: string[], fromIndex: number): string | null {
  for (let i = fromIndex; i >= 0; i -= 1) {
    const ln = (lines[i] ?? "").trim()
    const m = ln.match(/^([A-Za-z_][A-Za-z0-9_\s\*]+?)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*\{?$/)
    if (!m) continue
    const name = m[2]
    if (!name) continue
    if (["if", "for", "while", "switch"].includes(name)) continue
    return name
  }
  return null
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// ---------------------------------------------------------------------------
// Rule file loader
// ---------------------------------------------------------------------------

function loadRuleText(ruleFile?: string): string {
  const candidates = [
    ruleFile,
    path.join(process.cwd(), "doc/atomic/skill/indirect-caller-reasoning-rules.md"),
    path.join(
      path.dirname(new URL(import.meta.url).pathname),
      "../../../doc/atomic/skill/indirect-caller-reasoning-rules.md",
    ),
  ].filter(Boolean) as string[]

  for (const p of candidates) {
    if (!existsSync(p)) continue
    try {
      return readFileSync(p, "utf8")
    } catch {
      /* try next */
    }
  }
  return ""
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

function buildPrompt(req: ReasonProposalRequest, ruleText: string): string {
  const schema = JSON.stringify(
    {
      proposedPaths: [
        {
          registrarFn: "<function that called the registration API>",
          registrationApi: "<registration API name>",
          storageFieldPath: "<struct.field storing the fn-ptr>",
          dispatchPattern: "<timer-callback|event-handler|dispatch-table|fn-ptr-field|linked-list|other>",
          gates: ["<runtime condition 1>"],
          invocationReason: {
            runtimeTrigger: "<plain-English external event that causes the handler to be called>",
            dispatchChain: ["<entry-point function>", "...", "<target-symbol>"],
            dispatchSite: {
              file: "<absolute path to file containing the fn-ptr call>",
              line: 0,
              snippet: "<the fn-ptr call expression>",
            },
            registrationGate: {
              registrarFn: "<function that called the registration API>",
              registrationApi: "<registration API name>",
              conditions: ["<condition 1>", "<condition 2>"],
            },
          },
          requiredFiles: ["<registration site file>", "<dispatch site file>"],
          confidence: 0.0,
          rationale: "<one sentence: evidence chain summary>",
        },
      ],
      openQuestions: ["<anything that could not be determined>"],
    },
    null,
    2,
  )

  const evidenceLines = req.knownEvidence.length
    ? req.knownEvidence.map((e) => `  ${e.file}:${e.line}  ${e.text}`)
    : ["  (none — use search_code to find where the symbol appears as an argument)"]

  return [
    "You are an expert C/C++ code reasoning assistant.",
    "",
    "═══════════════════════════════════════════════════════════",
    "GOAL: Answer 'Why is this function invoked at runtime?'",
    "═══════════════════════════════════════════════════════════",
    "",
    "The answer has THREE layers — you must find all three:",
    "",
    "  Layer A — Registration gate",
    "    Which function called the registration API that stored this fn-ptr?",
    "    What struct field or table slot holds it?",
    "    What runtime conditions gate whether it is dispatched?",
    "",
    "  Layer B — Dispatch site",
    "    Which function reads the stored fn-ptr and calls it?",
    "    What is the exact call expression (e.g. table[i].fn(args))?",
    "    What file and line?",
    "",
    "  Layer C — Runtime trigger",
    "    What external event drives the dispatch site?",
    "    (e.g. 'incoming RX packet from hardware', 'WMI command from host',",
    "     'OS timer fires', 'hardware interrupt', 'vdev state change')",
    "",
    "The registrar alone is NOT the answer. The runtime trigger is the answer.",
    "",
    "═══════════════════════════════════════════════════════════",
    "INVESTIGATION STEPS — follow in order, use tools at each step:",
    "═══════════════════════════════════════════════════════════",
    "",
    "Step 1: Find where the target symbol appears as a function argument.",
    "  → search_code(pattern='" + req.targetSymbol + "', glob='*.{c,h}')",
    "    (or OpenCode-style grep(pattern='" + req.targetSymbol + "', include='*.{c,h}'))",
    "  → Look for lines where it is passed as an argument (not a definition, not a direct call)",
    "",
    "Step 2: Read the registration call site.",
    "  → read_file(filePath=<file>, startLine=<line-5>, endLine=<line+10>)",
    "    (or OpenCode-style read(filePath=<file>, offset=<line-5>, limit=20))",
    "  → Identify the registration API name and the struct field that stores the fn-ptr",
    "  → The enclosing function is the registrar (Layer A)",
    "",
    "Step 3: Find the dispatch site — where the stored fn-ptr is called.",
    "  → search_code(pattern='<struct_field>\\s*\\(', glob='*.{c,h}')",
    "  → OR: search_code(pattern='<struct_field>', glob='*.{c,h}') then read context",
    "  → OR use glob(pattern='**/*.{c,h}', path=<subdir>) + grep(...) for broad workspace scanning",
    "  → Read the dispatch function to confirm the fn-ptr call expression (Layer B)",
    "",
    "Step 4: Trace what drives the dispatch site.",
    "  → lsp_incoming_calls(file=<dispatch_file>, line=<dispatch_line>, character=1)",
    "  → For each caller, use lsp_outgoing_calls to confirm the edge direction",
    "  → If you hit signal/event registration, resolve emitter API via lsp_definition + search_code",
    "  → Follow callers upward until you reach an external event boundary",
    "  → Name the external event in plain English (Layer C)",
    "",
    "Step 5: Read the dispatch loop to find the runtime conditions.",
    "  → read_file around the dispatch call to find if/guard conditions",
    "  → List them in registrationGate.conditions",
    "",
    "═══════════════════════════════════════════════════════════",
    "TARGET",
    "═══════════════════════════════════════════════════════════",
    `Symbol:  ${req.targetSymbol}`,
    `File:    ${req.targetFile}`,
    `Line:    ${req.targetLine}`,
    "",
    "Known evidence (reference sites where the symbol appears as an argument):",
    ...evidenceLines,
    "",
    `Suspected patterns: ${req.suspectedPatterns.length ? req.suspectedPatterns.join(", ") : "(unknown — infer from code)"}`,
    "",
    ruleText
      ? "═══════════════════════════════════════════════════════════\nREASONING RULES\n═══════════════════════════════════════════════════════════\n" +
        ruleText
      : "",
    "",
    "═══════════════════════════════════════════════════════════",
    "OUTPUT FORMAT",
    "═══════════════════════════════════════════════════════════",
    "Return ONLY valid JSON. No markdown fences. No prose before or after.",
    "Schema:",
    schema,
    "",
    "REJECTION RULES — paths failing any rule are discarded:",
    "  1. invocationReason MUST be present",
    "  2. runtimeTrigger MUST describe an external event, not a function name",
    "     BAD:  'wlan_bpf_enable_data_path calls the handler'",
    "     GOOD: 'Incoming RX data packet from hardware drives the offload dispatch loop'",
    "  3. dispatchChain MUST have ≥2 entries; last entry MUST be '" + req.targetSymbol + "'",
    "  4. dispatchSite.file MUST be a real absolute path (verify with read_file)",
    "  5. registrationGate.registrarFn MUST be non-empty",
    "  6. registrationGate.conditions MUST be non-empty",
    "  7. requiredFiles MUST include both the registration file and the dispatch file",
    "  8. confidence MUST be ≥ 0.5",
  ]
    .filter((s) => s !== undefined)
    .join("\n")
}

function buildJsonFinalizationPrompt(rawText: string): string {
  return [
    "Convert the following reasoning text into STRICT JSON only.",
    "Do not call tools. Do not add prose. Return only a JSON object.",
    "Required top-level shape:",
    '{"proposedPaths":[],"openQuestions":[]}',
    "If details are missing, still return best-effort JSON with empty arrays where needed.",
    "Source text:",
    rawText,
  ].join("\n")
}

// ---------------------------------------------------------------------------
// JSON extraction — robust against markdown fences and leading prose
// ---------------------------------------------------------------------------

function extractJson(raw: string, symbol: string): ReasonProposalResponse | null {
  const log = getLogger()

  if (!raw?.trim()) {
    log.warn("llm-advisor: LLM returned empty text", { symbol })
    return null
  }

  log.debug("llm-advisor: raw LLM response", {
    symbol,
    length: raw.length,
    preview: raw.slice(0, 300).replace(/\n/g, "↵"),
  })

  // Try direct parse first
  try {
    const parsed = JSON.parse(raw.trim()) as ReasonProposalResponse
    if (parsed && Array.isArray(parsed.proposedPaths)) {
      log.info("llm-advisor: JSON parsed directly", { symbol, pathCount: parsed.proposedPaths.length })
      return parsed
    }
  } catch {
    /* fall through */
  }

  // Strip markdown code fences
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim()) as ReasonProposalResponse
      if (parsed && Array.isArray(parsed.proposedPaths)) {
        log.info("llm-advisor: JSON extracted from markdown fence", { symbol, pathCount: parsed.proposedPaths.length })
        return parsed
      }
    } catch {
      /* fall through */
    }
  }

  // Find the first { ... } block
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1)) as ReasonProposalResponse
      if (parsed && Array.isArray(parsed.proposedPaths)) {
        log.info("llm-advisor: JSON extracted from brace scan", { symbol, pathCount: parsed.proposedPaths.length })
        return parsed
      }
    } catch {
      /* fall through */
    }
  }

  log.error("llm-advisor: JSON extraction failed — all strategies exhausted", {
    symbol,
    rawLength: raw.length,
    rawTail: raw.slice(-200).replace(/\n/g, "↵"),
  })
  return null
}

// ---------------------------------------------------------------------------
// LLM tool definitions
// ---------------------------------------------------------------------------

function buildTools(ctx: LlmToolContext) {
  return {
    // OpenCode-compatible read tool alias
    read: tool({
      description:
        "Read a file using OpenCode-style arguments (filePath, offset, limit). " +
        "Returns numbered lines as '<line>: <content>'.",
      parameters: z.object({
        filePath: z.string().describe("Absolute or workspace-relative path to the file"),
        offset: z.number().int().min(1).optional().describe("1-based start line (default: 1)"),
        limit: z.number().int().min(1).max(2000).optional().describe("max lines to return (default: 200)"),
      }),
      execute: async ({ filePath, offset, limit }) => {
        try {
          const abs = path.isAbsolute(filePath) ? filePath : path.join(ctx.workspaceRoot, filePath)
          const text = readFileSync(abs, "utf8")
          const lines = text.split(/\r?\n/)
          const start = Math.max(1, offset ?? 1)
          const max = Math.min(2000, limit ?? 200)
          const end = Math.min(lines.length, start + max - 1)
          const content = lines
            .slice(start - 1, end)
            .map((l, i) => `${start + i}: ${l}`)
            .join("\n")
          return { filePath: abs, start, end, totalLines: lines.length, content }
        } catch (err: any) {
          return { error: err?.message ?? "read failed" }
        }
      },
    }),

    // OpenCode-compatible glob tool alias
    glob: tool({
      description: "Find files by glob pattern. Returns matching file paths sorted by tool output order.",
      parameters: z.object({
        pattern: z.string().describe("Glob pattern like '**/*.c'"),
        path: z.string().optional().describe("Optional root path (default: workspace root)"),
      }),
      execute: async ({ pattern, path: rootPath }) => {
        try {
          const root = rootPath
            ? path.isAbsolute(rootPath)
              ? rootPath
              : path.join(ctx.workspaceRoot, rootPath)
            : ctx.workspaceRoot
          const escapedPattern = pattern.replace(/"/g, '\\"')
          const escapedRoot = root.replace(/"/g, '\\"')
          const cmd = `rg --files \"${escapedRoot}\" --glob \"${escapedPattern}\"`
          const raw = execSync(cmd, { stdio: "pipe", timeout: 15000 }).toString()
          const files = raw
            .split("\n")
            .map((x) => x.trim())
            .filter(Boolean)
          return { count: files.length, files }
        } catch (err: any) {
          return { count: 0, files: [], error: err?.message ?? "glob failed" }
        }
      },
    }),

    // OpenCode-compatible grep tool alias
    grep: tool({
      description: "Search file contents by regex pattern. Returns file path + line number + snippet.",
      parameters: z.object({
        pattern: z.string().describe("Regex pattern"),
        path: z.string().optional().describe("Search root (default: workspace root)"),
        include: z.string().optional().describe("Optional include glob e.g. '*.{c,h}'"),
      }),
      execute: async ({ pattern, path: rootPath, include }) => {
        try {
          const root = rootPath
            ? path.isAbsolute(rootPath)
              ? rootPath
              : path.join(ctx.workspaceRoot, rootPath)
            : ctx.workspaceRoot
          const escapedPattern = pattern.replace(/"/g, '\\"')
          const escapedRoot = root.replace(/"/g, '\\"')
          const globArg = include ? `--glob \"${include.replace(/"/g, '\\"')}\"` : ""
          const cmd = `rg --json -n \"${escapedPattern}\" \"${escapedRoot}\" ${globArg}`
          const raw = execSync(cmd, { stdio: "pipe", timeout: 15000 }).toString()
          const matches: Array<{ file: string; line: number; text: string }> = []
          for (const line of raw.split("\n")) {
            if (!line.trim()) continue
            try {
              const parsed = JSON.parse(line)
              if (parsed.type === "match") {
                matches.push({
                  file: parsed.data?.path?.text ?? "",
                  line: parsed.data?.line_number ?? 0,
                  text: (parsed.data?.lines?.text ?? "").trim(),
                })
              }
            } catch {
              // ignore malformed lines
            }
          }
          return { count: matches.length, matches }
        } catch (err: any) {
          return { count: 0, matches: [], error: err?.message ?? "grep failed" }
        }
      },
    }),

    // Read a file with optional line range
    read_file: tool({
      description:
        "Read source code from a file. Use startLine/endLine to read a specific range. " +
        "Returns numbered lines. Max 150 lines per call.",
      parameters: z.object({
        filePath: z.string().describe("Absolute path to the file"),
        startLine: z.number().int().min(1).optional().describe("First line to read (1-based)"),
        endLine: z.number().int().min(1).optional().describe("Last line to read (1-based)"),
      }),
      execute: async ({ filePath, startLine, endLine }) => {
        try {
          const abs = path.isAbsolute(filePath) ? filePath : path.join(ctx.workspaceRoot, filePath)
          const text = readFileSync(abs, "utf8")
          const lines = text.split(/\r?\n/)
          const s = Math.max(1, startLine ?? 1)
          const e = Math.min(lines.length, endLine ?? Math.min(lines.length, s + 149))
          const out = lines
            .slice(s - 1, e)
            .map((l, i) => `${s + i}: ${l}`)
            .join("\n")
          return { filePath: abs, lines: `${s}-${e} of ${lines.length}`, content: out }
        } catch (err: any) {
          return { error: err?.message ?? "read_file failed" }
        }
      },
    }),

    // Search code with ripgrep
    search_code: tool({
      description:
        "Search source code with a regex pattern using ripgrep. " +
        "Returns file path, line number, and matching text for each hit. " +
        "Use glob to restrict to specific file types (e.g. '*.c', '*.{c,h}').",
      parameters: z.object({
        pattern: z.string().describe("Regex pattern to search for"),
        glob: z.string().optional().describe("File glob filter (default: *.{c,h,cpp,hpp})"),
        maxResults: z.number().int().min(1).max(100).optional().describe("Max results (default: 40)"),
      }),
      execute: async ({ pattern, glob, maxResults }) => {
        try {
          const escaped = pattern.replace(/"/g, '\\"')
          const globArg = glob ? `--glob "${glob.replace(/"/g, '\\"')}"` : `--glob "*.{c,h,cpp,hpp}"`
          const cmd = `rg --json -n "${escaped}" "${ctx.workspaceRoot}" ${globArg} --max-count ${maxResults ?? 40}`
          const raw = execSync(cmd, { stdio: "pipe", timeout: 15000 }).toString()
          const hits: Array<{ file: string; line: number; text: string }> = []
          for (const line of raw.split("\n")) {
            if (!line.trim()) continue
            try {
              const parsed = JSON.parse(line)
              if (parsed.type === "match") {
                hits.push({
                  file: parsed.data?.path?.text ?? "",
                  line: parsed.data?.line_number ?? 0,
                  text: (parsed.data?.lines?.text ?? "").trim(),
                })
              }
            } catch {
              /* skip non-JSON lines */
            }
          }
          return { count: hits.length, hits }
        } catch (err: any) {
          return { count: 0, hits: [], error: err?.message ?? "search_code failed" }
        }
      },
    }),

    // LSP incoming calls — who calls this function directly
    lsp_incoming_calls: tool({
      description:
        "Find all direct callers of the function at the given position using LSP. " +
        "Returns the calling function name, file, and line. " +
        "Use character=1 when you don't know the exact column.",
      parameters: z.object({
        file: z.string().describe("Absolute path to the source file"),
        line: z.number().int().min(1).describe("Line number (1-based)"),
        character: z.number().int().min(1).describe("Character offset (1-based, use 1 if unknown)"),
      }),
      execute: async ({ file, line, character }) => {
        try {
          const result = await ctx.client.incomingCalls(file, line - 1, character - 1)
          const calls = (result ?? []).map((c: any) => {
            const from = c.from ?? c.caller ?? {}
            return {
              name: from.name ?? "(unknown)",
              file: from.uri?.replace("file://", "") ?? "",
              line: (from.selectionRange?.start?.line ?? from.range?.start?.line ?? 0) + 1,
            }
          })
          return { count: calls.length, calls }
        } catch (err: any) {
          return { count: 0, calls: [], error: err?.message ?? "lsp_incoming_calls failed" }
        }
      },
    }),

    // LSP outgoing calls — what this function calls (edge-direction validation)
    lsp_outgoing_calls: tool({
      description:
        "Find callees of the function at the given position using LSP. " +
        "Use this to validate control-flow direction while tracing runtime triggers.",
      parameters: z.object({
        file: z.string().describe("Absolute path to the source file"),
        line: z.number().int().min(1).describe("Line number (1-based)"),
        character: z.number().int().min(1).describe("Character offset (1-based, use 1 if unknown)"),
      }),
      execute: async ({ file, line, character }) => {
        try {
          const result = await ctx.client.outgoingCalls(file, line - 1, character - 1)
          const calls = (result ?? []).map((c: any) => {
            const to = c.to ?? c.callee ?? {}
            return {
              name: to.name ?? "(unknown)",
              file: to.uri?.replace("file://", "") ?? "",
              line: (to.selectionRange?.start?.line ?? to.range?.start?.line ?? 0) + 1,
            }
          })
          return { count: calls.length, calls }
        } catch (err: any) {
          return { count: 0, calls: [], error: err?.message ?? "lsp_outgoing_calls failed" }
        }
      },
    }),

    // LSP definition — jump from signal registration token to emitter/impl API.
    lsp_definition: tool({
      description:
        "Jump to the implementation/definition at a given position. " +
        "Useful for resolving the real emitter API behind signal/event registration wrappers.",
      parameters: z.object({
        file: z.string().describe("Absolute path to the source file"),
        line: z.number().int().min(1).describe("Line number (1-based)"),
        character: z.number().int().min(1).describe("Character offset (1-based, use 1 if unknown)"),
      }),
      execute: async ({ file, line, character }) => {
        try {
          const result = await ctx.client.definition(file, line - 1, character - 1)
          const defs = (result ?? []).slice(0, 20).map((d: any) => ({
            file: d.uri?.replace("file://", "") ?? "",
            line: (d.range?.start?.line ?? 0) + 1,
            character: (d.range?.start?.character ?? 0) + 1,
          }))
          return { count: defs.length, definitions: defs }
        } catch (err: any) {
          return { count: 0, definitions: [], error: err?.message ?? "lsp_definition failed" }
        }
      },
    }),

    // LSP references — all places the symbol is used (including as fn-ptr argument)
    lsp_references: tool({
      description:
        "Find all references to the symbol at the given position using LSP. " +
        "This includes places where the symbol is passed as a function pointer argument. " +
        "Use character=1 when you don't know the exact column.",
      parameters: z.object({
        file: z.string().describe("Absolute path to the source file"),
        line: z.number().int().min(1).describe("Line number (1-based)"),
        character: z.number().int().min(1).describe("Character offset (1-based, use 1 if unknown)"),
      }),
      execute: async ({ file, line, character }) => {
        try {
          const result = await ctx.client.references(file, line - 1, character - 1)
          const refs = (result ?? []).map((r: any) => ({
            file: r.uri?.replace("file://", "") ?? "",
            line: (r.range?.start?.line ?? 0) + 1,
            character: (r.range?.start?.character ?? 0) + 1,
          }))
          return { count: refs.length, refs }
        } catch (err: any) {
          return { count: 0, refs: [], error: err?.message ?? "lsp_references failed" }
        }
      },
    }),

    // LSP workspace symbol search — find a symbol by name to get its file/line
    lsp_find_symbol: tool({
      description:
        "Search for a symbol by name across the workspace index. " +
        "Returns the file path and line number for each match. " +
        "Use this to find the definition of a function you discovered via search_code.",
      parameters: z.object({
        query: z.string().describe("Symbol name or prefix to search for"),
      }),
      execute: async ({ query }) => {
        try {
          const result = await ctx.client.workspaceSymbol(query)
          const symbols = (result ?? []).slice(0, 20).map((s: any) => ({
            name: s.name ?? "",
            kind: s.kind ?? 0,
            file: s.location?.uri?.replace("file://", "") ?? "",
            line: (s.location?.range?.start?.line ?? 0) + 1,
          }))
          return { count: symbols.length, symbols }
        } catch (err: any) {
          return { count: 0, symbols: [], error: err?.message ?? "lsp_find_symbol failed" }
        }
      },
    }),
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function requestReasonProposals(
  config: LlmReasoningConfig,
  req: ReasonProposalRequest,
  ctx: LlmToolContext,
  logger?: ILogger,
): Promise<ReasonProposalResponse | null> {
  const log = logger ?? loggerPort

  if (!config.enabled) return null

  const apiKey = process.env[config.apiKeyEnv]
  if (!apiKey) {
    log.warn("llm-advisor: no API key found", { envVar: config.apiKeyEnv, symbol: req.targetSymbol })
    return null
  }

  const provider = createOpenAICompatible({
    name: "qpilot",
    apiKey,
    baseURL: config.baseURL,
  })

  const modelCandidates = [
    normalizeModelIdForOpenAICompatible(config.model),
    ...(config.fallbackModels ?? []).map(normalizeModelIdForOpenAICompatible),
  ].filter(Boolean)
  const uniqueModels = Array.from(new Set(modelCandidates))
  const ruleText = loadRuleText(config.ruleFile)
  const tools = buildTools(ctx)
  const maxSteps = Math.max(2, config.maxCallsPerQuery ?? 8)
  const maxAttemptsPerModel = Math.max(1, config.maxAttemptsPerModel ?? 2)
  const backoffBaseMs = Math.max(50, config.backoffBaseMs ?? 500)
  const backoffMaxMs = Math.max(backoffBaseMs, config.backoffMaxMs ?? 4000)

  log.info("llm-advisor: starting LLM call", {
    symbol: req.targetSymbol,
    model: config.model,
    normalizedModel: uniqueModels[0],
    fallbackModels: uniqueModels.slice(1),
    baseURL: config.baseURL,
    maxSteps,
    maxAttemptsPerModel,
    backoffBaseMs,
    backoffMaxMs,
    ruleFileLoaded: ruleText.length > 0,
    evidenceCount: req.knownEvidence.length,
  })

  const generateOnce = async (modelName: string, stepBudget: number) => {
    const model = provider(modelName)
    return withTlsPermissiveFetch(() =>
      generateText({
        model,
        prompt: buildPrompt(req, ruleText),
        tools,
        maxSteps: stepBudget,
        temperature: 0,
        onStepFinish: (step) => {
          // Log each tool call and its result as the LLM works
          for (const tc of step.toolCalls ?? []) {
            log.debug("llm-advisor: tool call", {
              symbol: req.targetSymbol,
              model: modelName,
              tool: tc.toolName,
              args: JSON.stringify(tc.args).slice(0, 200),
            })
          }
          for (const tr of step.toolResults ?? []) {
            log.debug("llm-advisor: tool result", {
              symbol: req.targetSymbol,
              model: modelName,
              tool: tr.toolName,
              resultSummary: JSON.stringify(tr.result).slice(0, 300),
            })
          }
          const toolNames = (step.toolCalls ?? []).map((tc) => tc.toolName)
          if (toolNames.length) {
            const hasIncoming = toolNames.includes("lsp_incoming_calls")
            const hasOutgoing = toolNames.includes("lsp_outgoing_calls")
            const hasDef = toolNames.includes("lsp_definition")
            const hasSearch = toolNames.includes("search_code") || toolNames.includes("grep")
            const hasRead = toolNames.includes("read_file") || toolNames.includes("read")
            log.info("llm-advisor: step tool-coverage", {
              symbol: req.targetSymbol,
              model: modelName,
              finishReason: step.finishReason,
              tools: toolNames,
              hasIncoming,
              hasOutgoing,
              hasDefinition: hasDef,
              hasSearch,
              hasRead,
            })
          }
          if (step.text) {
            log.debug("llm-advisor: step text", {
              symbol: req.targetSymbol,
              model: modelName,
              finishReason: step.finishReason,
              textPreview: step.text.slice(0, 200).replace(/\n/g, "↵"),
            })
          }
        },
      }),
    )
  }

  const finalizeJsonOnce = async (modelName: string, rawText: string) => {
    const model = provider(modelName)
    return withTlsPermissiveFetch(() =>
      generateText({
        model,
        prompt: buildJsonFinalizationPrompt(rawText),
        maxSteps: 1,
        temperature: 0,
      }),
    )
  }

  let result: { text: string; steps?: any[]; finishReason?: string; usage?: any } | null = null
  let lastErr: any = null

  let abortAllModels = false
  for (const modelName of uniqueModels) {
    for (let attempt = 1; attempt <= maxAttemptsPerModel; attempt += 1) {
      try {
        log.info("llm-advisor: trying model", {
          symbol: req.targetSymbol,
          model: modelName,
          attempt,
          maxAttemptsPerModel,
        })
        result = await generateOnce(modelName, maxSteps)
        log.info("llm-advisor: model call succeeded", { symbol: req.targetSymbol, model: modelName, attempt })
        break
      } catch (err: any) {
        lastErr = err
        const msg = String(err?.message ?? "")
        const modelUnavailable = /model not available/i.test(msg)
        const unsupportedProvider = /unsupported external provider/i.test(msg)
        const tlsFailure =
          /self-signed certificate|unable to verify the first certificate|unable to get local issuer certificate/i.test(
            msg,
          )
        const transientError = isTransientLlmError(msg)
        log.warn("llm-advisor: model call failed", {
          symbol: req.targetSymbol,
          model: modelName,
          attempt,
          maxAttemptsPerModel,
          modelUnavailable,
          unsupportedProvider,
          tlsFailure,
          transientError,
          error: msg.slice(0, 300),
        })

        if (transientError && attempt < maxAttemptsPerModel) {
          const delayMs = computeBackoffDelayMs(attempt, backoffBaseMs, backoffMaxMs)
          log.info("llm-advisor: backing off before retry", {
            symbol: req.targetSymbol,
            model: modelName,
            attempt,
            delayMs,
          })
          await sleepMs(delayMs)
          continue
        }

        if (modelUnavailable || unsupportedProvider || tlsFailure) {
          break
        }

        if (!transientError) {
          abortAllModels = true
          break
        }
      }
    }
    if (result || abortAllModels) break
  }

  if (!result) {
    log.error("llm-advisor: generateText failed for all model candidates", {
      symbol: req.targetSymbol,
      triedModels: uniqueModels,
      error: lastErr?.message,
      stack: lastErr?.stack?.slice(0, 400),
    })
    return null
  }

  log.info("llm-advisor: LLM call complete", {
    symbol: req.targetSymbol,
    steps: result.steps?.length ?? 0,
    finishReason: result.finishReason,
    textLength: result.text?.length ?? 0,
    usage: result.usage,
  })

  const parsed = extractJson(result.text, req.targetSymbol)
  if (parsed) return normalizeProposalResponse(parsed, req, ctx.workspaceRoot)

  // Common failure mode: model spent all steps in tool-calls and never emitted
  // final JSON. Retry once with a higher step budget so it can finish.
  if (result.finishReason === "tool-calls") {
    const retrySteps = Math.max(maxSteps + 2, 6)
    log.warn("llm-advisor: retrying due to unfinished tool-calls", {
      symbol: req.targetSymbol,
      prevFinishReason: result.finishReason,
      prevTextLength: result.text?.length ?? 0,
      retrySteps,
    })

    for (const modelName of uniqueModels) {
      try {
        const retry = await generateOnce(modelName, retrySteps)
        log.info("llm-advisor: retry call complete", {
          symbol: req.targetSymbol,
          model: modelName,
          finishReason: retry.finishReason,
          textLength: retry.text?.length ?? 0,
          steps: retry.steps?.length ?? 0,
        })
        const retryParsed = extractJson(retry.text, req.targetSymbol)
        if (retryParsed) return normalizeProposalResponse(retryParsed, req, ctx.workspaceRoot)
      } catch (err: any) {
        log.warn("llm-advisor: retry call failed", {
          symbol: req.targetSymbol,
          model: modelName,
          error: String(err?.message ?? "unknown error").slice(0, 240),
        })
      }
    }
  }

  // Final safety net: force a single-step JSON-only finalization from the last
  // raw model text. This avoids losing useful reasoning when the model keeps
  // ending in tool-calls narration.
  const sourceText = result.text ?? ""
  if (sourceText.trim()) {
    for (const modelName of uniqueModels) {
      try {
        const finalized = await finalizeJsonOnce(modelName, sourceText)
        log.info("llm-advisor: json-finalization call complete", {
          symbol: req.targetSymbol,
          model: modelName,
          finishReason: finalized.finishReason,
          textLength: finalized.text?.length ?? 0,
        })
        const finalizedParsed = extractJson(finalized.text, req.targetSymbol)
        if (finalizedParsed) return normalizeProposalResponse(finalizedParsed, req, ctx.workspaceRoot)
      } catch (err: any) {
        log.warn("llm-advisor: json-finalization call failed", {
          symbol: req.targetSymbol,
          model: modelName,
          error: String(err?.message ?? "unknown error").slice(0, 240),
        })
      }
    }
  }

  return null
}
